import { Router, raw, json, type RequestHandler } from "express";
import { AccessToken, AgentDispatchClient, RoomServiceClient, WebhookReceiver } from "livekit-server-sdk";
import { pool } from "@workspace/db";
import { requireRole } from "../middleware/auth";
import { VoiceDenied, VoiceSessions, localVoiceEnabled, serviceAuthorized } from "../lib/livekit/sessions";
import { logger } from "../lib/logger";
import { livekitVoice } from "../lib/voice-models";
import { PaidVoiceWork } from "../lib/livekit/paid-work";
import { livekitLlm } from "../lib/livekit/llm-stream";
import { mockLlm } from "../lib/livekit/mock-llm";

const sessionId = /^[0-9a-f]{8}-[0-9a-f-]{27}$/;
export function createLivekitRoutes(env = process.env, sessions = new VoiceSessions(pool)) {
  const internal = Router();
  const preview = Router();
  const paidWork = new PaidVoiceWork();
  const receiver = new WebhookReceiver(env.LIVEKIT_API_KEY ?? "unconfigured", env.LIVEKIT_API_SECRET ?? "unconfigured");
  const clients = () => {
    if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET || !env.LIVEKIT_BROWSER_URL) throw new VoiceDenied(503);
    return {
      rooms: new RoomServiceClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET),
      dispatch: new AgentDispatchClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET),
    };
  };
  const enabled: RequestHandler = (_req, res, next) => {
    if (!localVoiceEnabled(env)) { res.status(404).json({ error: "Not found" }); return; }
    next();
  };
  const wrap = (work: RequestHandler): RequestHandler => async (req, res, next) => {
    try { await work(req, res, next); }
    catch (e) {
      // Never serialize SDK/provider/SQL errors; they may include requests and secrets.
      const status = e instanceof VoiceDenied ? e.status : 503;
      logger.warn({ event: "livekit_request_denied", status }, "Voice request unavailable");
      if (!res.headersSent) res.status(status).json({ error: "Voice session unavailable" }); else res.end();
    }
  };
  const removeRoom = async (room: string) => { await clients().rooms.deleteRoom(room); };
  // This router must precede express.json(): signature verification requires exact bytes.
  internal.post("/livekit/webhook", enabled, raw({ type: "application/webhook+json", limit: "64kb" }), wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new VoiceDenied(401);
    let event;
    try { event = await receiver.receive(req.body.toString("utf8"), req.get("authorization")); }
    catch { throw new VoiceDenied(401); }
    if (event.id && event.room?.name) {
      const closed = await sessions.event(event.id, event.room.name, event.participant?.identity,
        event.event === "room_finished" || event.event === "participant_left");
      if (closed && event.event !== "room_finished") await removeRoom(closed.room);
    }
    res.sendStatus(204);
  }));
  internal.use("/internal/livekit", enabled, (req, res, next) => {
    if (!serviceAuthorized(req.get("authorization"), env.LIVEKIT_WORKER_SECRET)) { res.status(401).json({ error: "Unauthorized" }); return; }
    next();
  });
  // Own JSON parser because this router is intentionally before generic API authentication.
  internal.use("/internal/livekit", json({ limit: "32kb" }));
  internal.post("/internal/livekit/eligible", wrap(async (req, res) => {
    if (!sessionId.test(req.body?.id ?? "") || typeof req.body.room !== "string" || !await sessions.eligible(req.body.id, req.body.room)) throw new VoiceDenied();
    res.json({ eligible: true });
  }));
  internal.post("/internal/livekit/claim", wrap(async (req, res) => {
    if (!sessionId.test(req.body?.id ?? "") || typeof req.body.room !== "string"
      || typeof req.body.worker !== "string" || req.body.worker.length > 128) throw new VoiceDenied();
    const result = await sessions.claim(req.body.id, req.body.room, req.body.worker);
    // Configuration is resolved only after a durable authorized claim. No model keys cross this boundary.
    const cfg = await sessions.pool.query("select language, greeting from agent_configs where user_id=$1 order by id limit 1", [result.session.owner_id]);
    const language = cfg.rows[0]?.language ?? "en-US";
    let voice;
    try { voice = livekitVoice(language); } catch { await sessions.close(result.session.id); throw new VoiceDenied(); }
    res.json({ credential: result.credential, mode: result.session.mode, participant: result.session.participant,
      language, ...voice, greeting: cfg.rows[0]?.greeting ?? "Hello. This is the local voice preview.", heartbeatMs: 5000 });
  }));
  internal.post("/internal/livekit/:id/heartbeat", wrap(async (req, res) => {
    await sessions.validate(String(req.params.id), req.get("x-dialog-claim") ?? "", true);
    res.json({ active: true });
  }));
  internal.post("/internal/livekit/:id/close", wrap(async (req, res) => {
    // The claim remains hashed after closure so repeated authorized close is harmless.
    try { await sessions.validate(String(req.params.id), req.get("x-dialog-claim") ?? ""); }
    catch { res.sendStatus(204); return; }
    const s = await sessions.close(String(req.params.id));
    if (s) await removeRoom(s.room);
    res.sendStatus(204);
  }));
  internal.post("/internal/livekit/:id/authorize", wrap(async (req, res) => {
    if (!sessionId.test(req.body?.operationId ?? "") || !["stt", "tts"].includes(req.body?.component)) throw new VoiceDenied(400);
    const result = await sessions.admitOperation(String(req.params.id), req.get("x-dialog-claim") ?? "", req.body.operationId, req.body.component,
      s => paidWork.admit(s, req.body.component, req.body.component === "stt" ? 120 : 6000, req.body.operationId));
    res.json({ allowed: true, mode: (result as { mode: string }).mode });
  }));
  internal.post("/internal/livekit/:id/usage", wrap(async (req, res) => {
    const s = await sessions.settlementSession(String(req.params.id), req.get("x-dialog-claim") ?? "");
    const op = await sessions.pool.query("select * from livekit_operations where id=$1 and session_id=$2 and kind in ('stt','tts')", [req.body?.operationId, s.id]);
    if (op.rows.length !== 1 || !["charged", "unknown", "not_charged"].includes(req.body?.outcome)) throw new VoiceDenied(400);
    const record = op.rows[0].details.record;
    if (record && req.body.outcome === "charged" && (!(req.body.quantity >= 0) || req.body.quantity > (op.rows[0].kind === "stt" ? 120 : 6000))) throw new VoiceDenied(400);
    if (record) await paidWork.reconcile(record, req.body.outcome, req.body.quantity);
    await sessions.pool.query("update livekit_operations set state=$2,completed_at=now() where id=$1", [op.rows[0].id, req.body.outcome === "unknown" ? "unknown" : "completed"]);
    res.sendStatus(204);
  }));
  internal.post("/internal/livekit/:id/llm", wrap(async (req, res) => {
    const s = await sessions.validate(String(req.params.id), req.get("x-dialog-claim") ?? "");
    if (!Array.isArray(req.body?.messages) || req.body.messages.length > 32) throw new VoiceDenied(400);
    if (req.body.messages.some((m: any) => !m || !["user", "assistant"].includes(m.role) || typeof m.content !== "string" || m.content.length > 4096)) throw new VoiceDenied(400);
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    const textStream = s.mode === "mock" ? mockLlm(req.body.messages, abort.signal) : livekitLlm(sessions, s, req.body.messages, abort.signal);
    for await (const text of textStream) {
      await sessions.validate(s.id, req.get("x-dialog-claim") ?? "");
      if (res.destroyed) return;
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  }));
  preview.use("/dev/livekit/sessions", enabled, requireRole("admin"));
  preview.post("/dev/livekit/sessions", wrap(async (req, res) => {
    if (Object.keys(req.body ?? {}).length) throw new VoiceDenied(400);
    const { rooms, dispatch } = clients(); // Missing config must fail before creating durable work.
    const s = await sessions.create({ tenantId: req.tenantId!, ownerId: req.userId!, memberId: req.tenantUserId!, token: req.sessionToken! }, env.LIVEKIT_PROVIDER_MODE === "live" ? "live" : "mock");
    try {
      await rooms.createRoom({ name: s.room, emptyTimeout: 15, departureTimeout: 5, maxParticipants: 2 });
      await dispatch.createDispatch(s.room, "dialog-local", { metadata: JSON.stringify({ reference: s.id }) });
      const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, { identity: s.participant, ttl: 120 });
      token.addGrant({ room: s.room, roomJoin: true, canPublish: true, canSubscribe: true,
        canPublishData: false, canPublishSources: [2], canUpdateOwnMetadata: false });
      res.status(201).set("Cache-Control", "no-store").json({ id: s.id, url: env.LIVEKIT_BROWSER_URL, token: await token.toJwt(), mode: s.mode });
    } catch (e) { await sessions.close(s.id); await removeRoom(s.room).catch(() => undefined); throw e; }
  }));
  preview.get("/dev/livekit/sessions/:id", wrap(async (req, res) => {
    const s = await sessions.get(String(req.params.id), req.tenantId!);
    res.set("Cache-Control", "no-store").json({ id: s.id, state: s.state, mode: s.mode });
  }));
  preview.delete("/dev/livekit/sessions/:id", wrap(async (req, res) => {
    await sessions.get(String(req.params.id), req.tenantId!);
    const s = await sessions.close(String(req.params.id), req.tenantId);
    if (s) await removeRoom(s.room);
    res.sendStatus(204);
  }));
  // Timer is owned by the fixture/startup lifecycle, never started merely by importing routes.
  const reconcile = async () => {
    if (!localVoiceEnabled(env)) return;
    const closed = await sessions.reconcile();
    await Promise.allSettled(closed.map(s => removeRoom(s.room)));
    // Persist retryable cleanup separately: a failed delete must not reopen admission.
    const pending = await sessions.pool.query(`select s.id,s.room from livekit_sessions s where s.state='closed'
      and not exists(select 1 from livekit_operations o where o.id=s.id||':room-delete' and o.state='completed')
      order by s.closed_at limit 100`);
    await Promise.allSettled(pending.rows.map(async s => {
      try { await removeRoom(s.room); }
      catch (e) { const error = e as { status?: number; code?: string }; if (error.status !== 404 && error.code !== "not_found") throw e; }
      await sessions.pool.query(`insert into livekit_operations(id,session_id,kind,state,completed_at)
        values($1,$2,'room_delete','completed',now()) on conflict do nothing`, [s.id + ':room-delete', s.id]);
    }));
  };
  return { internal, preview, reconcile };
}
