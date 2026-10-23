import { randomUUID } from "node:crypto";
import type { pool } from "@workspace/db";
type Pool = typeof pool;
import { VoiceDenied, type Principal } from "./sessions";

/** Deliberately no production adapter or public route. Provisioning and dialing remain disabled. */
export interface MockSipAdapter {
  readonly mode: "mock";
  create(request: { operationId: string; room: string; trunk: string; destination: string }): Promise<{ participantId: string }>;
  reconcile(operationId: string): Promise<{ state: "unknown" | "absent" | "ended"; participantId?: string; seconds?: number }>;
}
export interface SipBudget {
  policies(principal: Principal, callLogId: number): Promise<void>;
  reserve(ownerId: number, key: string, amount: number): Promise<void>;
  // Called only with definitive evidence, or an explicitly unknown outcome. Implementations
  // must use the existing idempotent ledger and retain conservative unknown holds.
  settle(key: string, outcome: "unknown" | "not_charged" | "charged", seconds?: number): Promise<void>;
}
export function requiredRate(rates: Record<string, number>, key: string): number {
  const rate = rates[key];
  if (!Object.hasOwn(rates, key) || !Number.isFinite(rate) || rate < 0) throw new VoiceDenied(503);
  return rate;
}
export class MockSipOrchestrator {
  constructor(private pool: Pool, private adapter: MockSipAdapter, private budget: SipBudget) {
    if (adapter.mode !== "mock") throw new VoiceDenied();
  }
  async attempt(p: Principal, callLogId: number, operationId: string, rates: Record<string, number>) {
    if (!/^[0-9a-f-]{36}$/.test(operationId)) throw new VoiceDenied(400);
    await this.budget.policies(p, callLogId);
    const rate = requiredRate(rates, "telephony:vobiz:outbound");
    // Owner identity comes from the principal and persisted call, never the destination payload.
    const c = await this.pool.connect();
    let reserved = false;
    let request: { operationId: string; room: string; trunk: string; destination: string } | undefined;
    try {
      await c.query("begin");
      const call = await c.query(`select c.id,c.phone from call_logs c join tenants t on t.owner_id=c.user_id
        join tenant_users m on m.tenant_id=t.id join tenant_sessions a on a.tenant_user_id=m.id and a.tenant_id=t.id
        where c.id=$1 and c.user_id=$2 and t.id=$3 and t.telephony_type='VOBIZ_SIP'
        and t.status='active' and m.id=$4 and m.role='admin' and m.is_active=true and a.token=$5
        and a.revoked_at is null and a.expires_at>now() and c.finalized_at is null and c.ended_at is null
        for update of c`, [callLogId, p.ownerId, p.tenantId, p.memberId, p.token]);
      if (call.rows.length !== 1) throw new VoiceDenied();
      const prior = await c.query("select o.state,s.tenant_id,s.call_log_id from livekit_operations o join livekit_sessions s on s.id=o.session_id where o.id=$1", [operationId]);
      if (prior.rows.length) {
        if (prior.rows[0].tenant_id !== p.tenantId || prior.rows[0].call_log_id !== callLogId) throw new VoiceDenied();
        await c.query("commit"); return { state: prior.rows[0].state };
      }
      await this.budget.reserve(p.ownerId, operationId, rate * 2);
      reserved = true;
      const mapping = await c.query("select trunk_id from livekit_trunks where tenant_id=$1 and provider='vobiz' and state='mock'", [p.tenantId]);
      if (mapping.rows.length !== 1) throw new VoiceDenied(503);
      const auth = await c.query("select id from tenant_sessions where token=$1", [p.token]);
      const room = `sip-mock-${randomUUID()}`, id = randomUUID();
      await c.query(`insert into livekit_sessions(id,tenant_id,owner_id,member_id,auth_session_id,call_log_id,mode,room,participant,admission_until)
        values($1,$2,$3,$4,$5,$6,'mock',$7,$8,now()+interval '120 seconds')`, [id, p.tenantId, p.ownerId, p.memberId, auth.rows[0].id, callLogId, room, `sip-${randomUUID()}`]);
      await c.query("insert into livekit_operations(id,session_id,kind,state) values($1,$2,'sip_create','creating')", [operationId, id]);
      await c.query("commit");
      request = { operationId, room, trunk: mapping.rows[0].trunk_id, destination: call.rows[0].phone };
    } catch (e) {
      await c.query("rollback");
      // No adapter invocation occurred; release only this known-not-sent attempt's hold.
      if (reserved) await this.budget.settle(operationId, "not_charged");
      throw e;
    } finally { c.release(); }
    // Commit intent BEFORE crossing the provider boundary. A restart never blindly retries it.
    try {
      const response = await this.adapter.create(request!);
      const bound = await this.pool.query(`update livekit_operations set provider_id=$2,state='admitted'
        where id=$1 and state='creating' and provider_id is null returning id`, [operationId, response.participantId]);
      if (!bound.rows.length) throw new Error("Ambiguous binding");
      return { state: "mock_admitted" };
    } catch {
      await this.pool.query("update livekit_operations set state='unknown' where id=$1 and state='creating'", [operationId]);
      await this.budget.settle(operationId, "unknown");
      return { state: "needs_reconciliation" };
    }
  }
  async reconcile(operationId: string, tenantId: number) {
    const op = await this.pool.query(`select o.* from livekit_operations o join livekit_sessions s on s.id=o.session_id
      where o.id=$1 and s.tenant_id=$2 and o.kind='sip_create'`, [operationId, tenantId]);
    if (!op.rows.length) throw new VoiceDenied(404);
    if (op.rows[0].state === "completed") return;
    const evidence = await this.adapter.reconcile(operationId);
    if (evidence.state === "unknown") { await this.budget.settle(operationId, "unknown"); return; }
    // Idempotent ledger key allows retry after an API crash between settlement and completion.
    await this.budget.settle(operationId, evidence.state === "absent" ? "not_charged" : "charged", evidence.seconds);
    await this.pool.query("update livekit_operations set state='completed', completed_at=now() where id=$1 and state<>'completed'", [operationId]);
    await this.pool.query("update livekit_sessions set state='closed',closed_at=now(),lease_until=null where id=$1 and state<>'closed'", [op.rows[0].session_id]);
  }
}
