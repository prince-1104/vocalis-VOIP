import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import type { pool } from "@workspace/db";
type Pool = typeof pool;
type PoolClient = Pick<Pool, "query"> & { release(): void };

export class VoiceDenied extends Error {
  constructor(readonly status = 403) { super("Voice session unavailable"); }
}
export function localVoiceEnabled(env: NodeJS.ProcessEnv): boolean {
  try {
    const u = new URL(env.DATABASE_URL ?? "");
    return env.NODE_ENV !== "production" && env.DIALOG_LOCAL_VOICE === "1"
      && ["localhost", "127.0.0.1", "[::1]", "fixture-db"].includes(u.hostname)
      && /^\/dialog_test_[a-zA-Z0-9_]+$/.test(u.pathname) && !u.search
      && (env.LIVEKIT_PROVIDER_MODE === "mock" || (env.LIVEKIT_PROVIDER_MODE === "live"
        && env.DIALOG_LOCAL_VOICE_PROFILE === "manual-live"));
  } catch { return false; }
}
export function serviceAuthorized(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || secret.length < 43 || !header?.startsWith("Bearer ")) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(secret));
}
export type Principal = { tenantId: number; ownerId: number; memberId: number; token: string };
export type VoiceSession = {
  id: string; tenant_id: number; owner_id: number; member_id: number; auth_session_id: number;
  call_log_id: number | null; mode: "mock" | "live"; room: string; participant: string;
  state: string; worker_id: string | null; claim_hash: string | null;
  lease_until: Date | null; active_until: Date | null; admission_until: Date;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
// SQL predicates apply at the database boundary; publisher metadata never grants authority.
const authorization = `exists (select 1 from tenants t join tenant_users m on m.tenant_id=t.id
  join tenant_sessions a on a.tenant_user_id=m.id and a.tenant_id=t.id
  where t.id=s.tenant_id and t.owner_id=s.owner_id and t.status='active'
  and m.id=s.member_id and m.is_active=true and m.role='admin'
  and a.id=s.auth_session_id and a.revoked_at is null and a.expires_at>now())`;

export class VoiceSessions {
  constructor(readonly pool: Pool) {}
  private async transaction<T>(run: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try { await c.query("begin"); const value = await run(c); await c.query("commit"); return value; }
    catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  }
  async create(p: Principal, mode: "mock" | "live" = "mock"): Promise<VoiceSession> {
    return this.transaction(async c => {
      // Serialize preview creation per tenant, including expiration and the partial unique index.
      await c.query("select id from tenants where id=$1 for update", [p.tenantId]);
      await this.reconcile(c);
      const valid = await c.query(`select a.id from tenant_sessions a join tenant_users m on m.id=a.tenant_user_id
        join tenants t on t.id=m.tenant_id where a.token=$1 and a.tenant_id=$2 and m.tenant_id=$2
        and m.id=$3 and t.owner_id=$4 and t.status='active' and m.is_active=true and m.role='admin'
        and a.revoked_at is null and a.expires_at>now()`, [p.token, p.tenantId, p.memberId, p.ownerId]);
      if (!valid.rows.length) throw new VoiceDenied();
      const busy = await c.query("select id from livekit_sessions where tenant_id=$1 and call_log_id is null and state in ('pending','active')", [p.tenantId]);
      if (busy.rows.length) throw new VoiceDenied(409);
      const id = randomUUID();
      const result = await c.query(`insert into livekit_sessions
        (id,tenant_id,owner_id,member_id,auth_session_id,mode,room,participant,admission_until)
        values ($1,$2,$3,$4,$5,$8,$6,$7,now()+interval '120 seconds') returning *`,
        [id, p.tenantId, p.ownerId, p.memberId, valid.rows[0].id, `dialog-${randomUUID()}`, `preview-${randomUUID()}`, mode]);
      return result.rows[0];
    });
  }
  async get(id: string, tenantId: number): Promise<VoiceSession> {
    await this.reconcile();
    const r = await this.pool.query("select * from livekit_sessions where id=$1 and tenant_id=$2", [id, tenantId]);
    if (!r.rows.length) throw new VoiceDenied(404);
    return r.rows[0];
  }
  async eligible(id: string, room: string): Promise<boolean> {
    const r = await this.pool.query(`select id from livekit_sessions s where s.id=$1 and s.room=$2
      and state='pending' and admission_until>now() and ${authorization}`, [id, room]);
    return r.rows.length === 1;
  }
  async claim(id: string, room: string, worker: string): Promise<{ session: VoiceSession; credential: string }> {
    const credential = randomBytes(32).toString("base64url");
    const r = await this.pool.query(`update livekit_sessions s set state='active', worker_id=$3,
      claim_hash=$4, lease_until=now()+interval '15 seconds', active_until=now()+interval '120 seconds'
      where id=$1 and room=$2 and state='pending' and admission_until>now() and ${authorization} returning *`,
      [id, room, worker, hash(credential)]);
    if (r.rows.length !== 1) throw new VoiceDenied();
    return { session: r.rows[0], credential };
  }
  async validate(id: string, credential: string, heartbeat = false): Promise<VoiceSession> {
    const r = await this.pool.query(`update livekit_sessions s set lease_until=${heartbeat ? "now()+interval '15 seconds'" : "lease_until"}
      where id=$1 and claim_hash=$2 and state='active' and lease_until>now() and active_until>now()
      and ${authorization} returning *`, [id, hash(credential)]);
    if (r.rows.length !== 1) throw new VoiceDenied();
    return r.rows[0];
  }
  async settlementSession(id: string, credential: string): Promise<VoiceSession> {
    const r = await this.pool.query("select * from livekit_sessions where id=$1 and claim_hash=$2", [id, hash(credential)]);
    if (r.rows.length !== 1) throw new VoiceDenied();
    return r.rows[0];
  }
  async admitOperation(id: string, credential: string, operation: string, component: "stt" | "tts", run: (s: VoiceSession) => Promise<unknown>) {
    return this.transaction(async c => {
      const r = await c.query(`select * from livekit_sessions s where id=$1 and claim_hash=$2 and state='active'
        and lease_until>now() and active_until>now() and ${authorization} for update`, [id, hash(credential)]);
      if (r.rows.length !== 1) throw new VoiceDenied();
      const count = await c.query("select id from livekit_operations where session_id=$1 and kind=$2", [id, component]);
      if (count.rows.length >= (component === "stt" ? 1 : 30)) throw new VoiceDenied();
      const inserted = await c.query("insert into livekit_operations(id,session_id,kind,state) values($1,$2,$3,'authorizing') on conflict do nothing returning id", [operation, id, component]);
      if (!inserted.rows.length) throw new VoiceDenied();
      const result = await run(r.rows[0]);
      await c.query("update livekit_operations set state='admitted',details=$2::jsonb where id=$1", [operation, JSON.stringify(result)]);
      return result;
    });
  }
  async close(id: string, tenantId?: number): Promise<VoiceSession | null> {
    const r = await this.pool.query(`update livekit_sessions set state='closed', closed_at=now(), lease_until=null
      where id=$1 and ($2::integer is null or tenant_id=$2) and state in ('pending','active') returning *`, [id, tenantId ?? null]);
    return r.rows[0] ?? null;
  }
  async reconcile(c: Pick<Pool, "query"> | PoolClient = this.pool): Promise<VoiceSession[]> {
    const r = await c.query(`update livekit_sessions s set state='closed', closed_at=now(), lease_until=null
      where (state='pending' and admission_until<=now()) or (state='active' and
      (lease_until<=now() or active_until<=now())) or (state in ('pending','active') and not (${authorization})) returning *`);
    return r.rows;
  }
  async event(eventId: string, room: string, participant: string | undefined, end: boolean): Promise<VoiceSession | null> {
    return this.transaction(async c => {
      const r = await c.query("select * from livekit_sessions where room=$1 for update", [room]);
      const s: VoiceSession | undefined = r.rows[0];
      if (!s || (participant && s.participant !== participant)) return null;
      const inserted = await c.query(`insert into livekit_operations(id,session_id,kind,state) values ($1,$2,'webhook','completed') on conflict do nothing returning id`, [eventId, s.id]);
      if (!inserted.rows.length || !end) return null;
      const closed = await c.query("update livekit_sessions set state='closed',closed_at=now(),lease_until=null where id=$1 and state in ('pending','active') returning *", [s.id]);
      return closed.rows[0] ?? null;
    });
  }
}
