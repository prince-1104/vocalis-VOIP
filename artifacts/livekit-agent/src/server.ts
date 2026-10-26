import { AgentServer, ServerOptions, initializeLogger } from "@livekit/agents";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { logger } from "@workspace/observability/runtime/logger";
import { metrics } from "@workspace/observability/runtime/operational-metrics";
import { DialogApi, reference } from "./api";
import { voiceTuning } from "./voice-tuning";
import { ProcessReadiness } from "./process-readiness";
import { superviseInference, observeInferenceExit } from "./worker-recovery";

// The SDK logs jobs, transcripts and provider payloads at several levels. Disable its
// logger in both parent and child, rather than relying on a list of sensitive fields.
initializeLogger({ level: "silent", pretty: false });
const api = new DialogApi();
voiceTuning(); // Fail at startup, not on the first call, when tuning configuration is invalid.
// Admission follows successful prewarm, rather than the SDK's WebSocket-only health check.
// Single-use processes report over authenticated loopback; reserve before accepting a job.
const processes = new ProcessReadiness(pid => { try { process.kill(pid, 0); return true; } catch { return false; } },
  pid => {
    logger.warn({ event: "livekit_dispatch_process_retired", childPid: pid }, "Unconfirmed dispatch child retired before capacity reuse");
    try { process.kill(pid, "SIGKILL"); } catch {}
  });
const inferenceExit = observeInferenceExit(fields => logger.info({
  event: fields.kind === 1 ? "livekit_job_process_exit" : "livekit_inference_exit", ...fields,
}, "SDK worker child exited"));
const server = new AgentServer(new ServerOptions({
  agent: fileURLToPath(new URL("./agent.js", import.meta.url)), agentName: "dialog-local",
  wsURL: process.env.LIVEKIT_URL, apiKey: process.env.LIVEKIT_API_KEY, apiSecret: process.env.LIVEKIT_API_SECRET,
  host: "0.0.0.0", port: 8081, logLevel: "silent", production: true,
  // One idle process keeps the prewarmed VAD ready so job startup never races the claim lease.
  numIdleProcesses: 1, initializeProcessTimeout: 60000, drainTimeout: 15000, shutdownProcessTimeout: 10000,
  requestFunc: async request => {
    const finish = metrics.operation("livekit_dispatch", "livekit");
    const diagnosticId = randomUUID();
    try {
      const id = reference(request.job.metadata);
      await api.json("/eligible", { id, room: request.job.room?.name });
      if (!processes.reserve(diagnosticId)) {
        logger.warn({ event: "livekit_job_process_unavailable" }, "Voice job refused before claim: no prewarmed process");
        throw new Error("No prewarmed process available");
      }
      const entered = processes.waitForEntry(diagnosticId);
      logger.info({ event: "livekit_job_reserved", diagnosticId }, "Voice job reserved; awaiting assignment and child entry");
      await request.accept("Dialog", `agent-${randomUUID()}`, "", { "dialog.diagnostic": diagnosticId });
      processes.dispatched(diagnosticId);
      if (!await entered) throw new Error("Job failed before confirmed process entry");
      processes.complete(diagnosticId);
      finish();
      logger.info({ event: "livekit_job_accepted", diagnosticId, uptimeMs: Math.round(performance.now()) }, "Voice job accepted");
    } catch {
      processes.fail(diagnosticId); finish("blocked");
      await request.reject().catch(() => undefined);
      logger.warn({ event: "livekit_job_denied", diagnosticId }, "Voice job failed or denied before confirmed dispatch");
    }
  },
}));
// Observe only public control-plane state, never job messages or participant attributes.
server.event.on("worker_registered", () => logger.info({ event: "livekit_worker_registered" }, "Voice worker registered"));
let advertisedStatus: number | undefined;
server.event.on("worker_msg", message => {
  if (message?.message?.case !== "updateWorker") return;
  const { status, load } = message.message.value;
  if (status !== advertisedStatus) {
    advertisedStatus = status;
    logger.info({ event: "livekit_worker_availability", status, load }, "Voice worker availability changed");
  }
});
// Internal-only administration. No tenant identifiers or SDK errors enter these metrics.
const administration = createServer(async (req, res) => {
  if (req.url === "/healthz") { res.end("ok"); return; }
  if (req.url === "/readyz") {
    const ready = await fetch("http://127.0.0.1:8081/", { signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false);
    const available = ready && processes.available() && !stopping;
    res.writeHead(available ? 200 : 503).end(available ? "ready" : "unavailable"); return;
  }
  if (req.url === "/metrics" && req.headers.authorization === `Bearer ${process.env.LIVEKIT_WORKER_SECRET}`) {
    res.setHeader("Content-Type", "text/plain"); res.end(metrics.render()); return;
  }
  if (req.url?.startsWith("/process-entry/") && req.method === "POST"
    && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")
    && req.headers.authorization === `Bearer ${process.env.LIVEKIT_WORKER_SECRET}`) {
    const [id, raw] = req.url.slice("/process-entry/".length).split("/");
    const entered = !stopping && /^\d{1,10}$/.test(raw ?? "") && processes.enter(id!, Number(raw));
    res.writeHead(entered ? 204 : 409).end(); return;
  }
  // Job processes have their own memory; they forward stage durations here. Loopback only.
  if (req.url?.startsWith("/process-ready/") && req.method === "POST"
    && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")
    && req.headers.authorization === `Bearer ${process.env.LIVEKIT_WORKER_SECRET}`) {
    const raw = req.url.slice("/process-ready/".length);
    const pid = Number(raw);
    if (!/^\d{1,10}$/.test(raw) || stopping || !processes.register(pid)) { res.writeHead(400).end(); return; }
    res.writeHead(204).end();
    return;
  }
  if (req.url === "/observe" && req.method === "POST" && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")
    && req.headers.authorization === `Bearer ${process.env.LIVEKIT_WORKER_SECRET}`) {
    let body = "";
    for await (const part of req) { body += part; if (body.length > 32768) { res.writeHead(413).end(); return; } }
    try {
      const { observations } = JSON.parse(body) as { observations: unknown };
      if (!Array.isArray(observations) || observations.length > 200) throw new Error("invalid");
      for (const o of observations as Record<string, unknown>[]) {
        if (typeof o?.ms !== "number") continue;
        // stage() drops any label outside its fixed enumerations.
        metrics.stage(o.stage as never, o.provider as never, o.mode as never, o.outcome as never, o.ms / 1000);
      }
      res.writeHead(204).end();
    } catch { res.writeHead(400).end(); }
    return;
  }
  res.writeHead(404).end();
});
administration.listen(8082, "0.0.0.0");
let stopping = false;
const inferenceRecovery = superviseInference(async () => {
  const response = await fetch("http://127.0.0.1:8081/", { signal: AbortSignal.timeout(1000) });
  return response.status === 503 && await response.text() === "inference process not running";
}, async () => {
  logger.warn({ event: "livekit_inference_recovery" }, "Dead SDK inference executor: retiring worker before automatic replacement");
  // Existing drain + process-close limits also bound a broken SDK shutdown.
  const deadline = setTimeout(() => process.exit(1), 15000 + 10000);
  deadline.unref();
  try { await stop(); } finally { process.exit(1); }
});
async function stop() {
  if (stopping) return;
  stopping = true;
  inferenceRecovery.dispose();
  processes.close();
  try { await server.drain(15000); }
  finally { await server.close(); inferenceExit.dispose(); administration.close(); }
}
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
await server.run();
