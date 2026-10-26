import { tracingChannel } from "node:diagnostics_channel";
import type { ChildProcess } from "node:child_process";
import { basename } from "node:path";

/** Numeric worker-child exit evidence from Node's public spawn channel; no IPC payloads are logged. */
export function observeInferenceExit(mark: (fields: Record<string, number>) => void) {
  const children = new Set<() => void>();
  const channel = tracingChannel("child_process.spawn");
  const handlers = { end(message: unknown) {
    const child = (message as { process?: ChildProcess }).process;
    const kind = child && /^(inference|job)_proc_lazy_main\.(js|cjs)$/.exec(basename(child.spawnargs[1] ?? ""));
    if (!child || !kind) return;
    const started = performance.now(); let pongs = 0, lastPong = started;
    const onMessage = (message: unknown) => {
      if (message && typeof message === "object" && (message as { case?: string }).case === "pongResponse") {
        pongs++; lastPong = performance.now();
      }
    };
    const cleanup = () => { child.off("message", onMessage); child.off("exit", onExit); children.delete(cleanup); };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      mark({ kind: kind[1] === "job" ? 1 : 0, childPid: child.pid ?? 0, exitCode: code ?? -1,
        signal: signal === null ? 0 : signal === "SIGKILL" ? 1 : signal === "SIGTERM" ? 2 : signal === "SIGSEGV" ? 3 : signal === "SIGABRT" ? 4 : 5,
        pongs, lifetimeMs: Math.round(performance.now() - started), lastPongAgoMs: Math.round(performance.now() - lastPong) });
      cleanup();
    };
    child.on("message", onMessage); child.once("exit", onExit); children.add(cleanup);
  } };
  channel.end.subscribe(handlers.end);
  return { dispose() { channel.end.unsubscribe(handlers.end); for (const cleanup of children) cleanup(); } };
}

/** A dead SDK inference executor cannot be reused. Restart the owning worker once. */
export function superviseInference(probe: () => Promise<boolean>, recover: () => Promise<void>) {
  let closed = false, checking = false, recovering = false;
  const check = async () => {
    if (closed || checking || recovering) return;
    checking = true;
    try {
      const dead = await probe();
      if (dead && !closed) { recovering = true; await recover(); }
    } catch { /* Unavailable health transport is not proof of executor death. */ }
    finally { checking = false; }
  };
  const timer = setInterval(() => { void check(); }, 5000);
  return { check, dispose() { closed = true; clearInterval(timer); } };
}
