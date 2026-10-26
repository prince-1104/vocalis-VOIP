import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import type { StageClock } from "./bench";

// Diagnostic adapter for the exact installed SDK, never a playback controller.
// IDs are closed enums; handles, tasks and timers are session-local ordinals.
export const pauseCallbacks = ["onStartOfSpeech", "onEndOfSpeech", "onVADInferenceDone", "interruptByAudioActivityOnce",
  "onEndOfTurn", "reconcilePlayoutPause", "updatePausedSpeech", "cancelFalseInterruptionTimer",
  "startFalseInterruptionTimer", "restorePausedSpeechState", "cancelSpeechPause"] as const;
type Handle = { interrupted?: boolean; done?: () => boolean };
type Activity = {
  agentSession: { agentState?: string; output?: { audio?: unknown }; _activity?: unknown };
  _currentSpeech?: Handle; pausedSpeech?: { handle: Handle; timeout: number };
  userSilenceEvent?: { isSet: boolean }; falseInterruptionTimer?: object;
  falseInterruptionPending?: boolean; audioRecognition?: { endOfTurnTask?: object; isClosed?: boolean };
};
type Method = (this: Activity, ...args: unknown[]) => unknown;

export async function installedPausePrototype() {
  const directory = path.dirname(createRequire(import.meta.url).resolve("@livekit/agents"));
  const pkg = JSON.parse(await readFile(path.join(directory, "../package.json"), "utf8"));
  if (pkg.version !== "1.9.3") throw new Error("Pause diagnostics require the audited SDK version");
  const { AgentActivity } = await import(pathToFileURL(path.join(directory, "voice/agent_activity.js")).href);
  return AgentActivity.prototype as Record<string, Method>;
}

export function observePauseLifecycle(prototype: Record<string, Method>, session: unknown, clock: Pick<StageClock, "mark" | "now">) {
  if (pauseCallbacks.some(name => typeof prototype[name] !== "function")) throw new Error("Audited pause callback unavailable");
  const restore: (() => void)[] = [], ordinals = new WeakMap<object, number>();
  let ordinal = 0, records = 0, active = true, owner = 0, call = 0, lastVad = -Infinity;
  const id = (value: object | undefined) => { if (!value) return 0; let n = ordinals.get(value); if (!n) { n = ++ordinal; ordinals.set(value, n); } return n; };
  const snapshot = (activity: Activity) => {
    let output = activity.agentSession.output?.audio as { nextInChain?: unknown; playbackEnabledFuture?: { done: boolean } } | undefined;
    let paused = -1;
    for (let i = 0; output && i < 8; i++) {
      if (output.playbackEnabledFuture) { paused = Number(!output.playbackEnabledFuture.done); break; }
      output = output.nextInChain as typeof output;
    }
    const held = activity.pausedSpeech?.handle;
    const resumeReason = !held ? 1 : activity._currentSpeech !== held ? 2 : held.interrupted ? 3 : held.done?.() ? 4
      : activity.agentSession._activity !== activity ? 5 : !(activity.agentSession.output as { audioEnabled?: boolean } | undefined)?.audioEnabled ? 6
      : activity.falseInterruptionPending ? 7 : 0;
    return { current: id(activity._currentSpeech), held: id(held), resumeReason, pauseTimeout: activity.pausedSpeech?.timeout ?? 0,
      silent: Boolean(activity.userSilenceEvent?.isSet), timer: id(activity.falseInterruptionTimer),
      pending: Boolean(activity.falseInterruptionPending), task: id(activity.audioRecognition?.endOfTurnTask),
      taskDone: Boolean((activity.audioRecognition?.endOfTurnTask as { done?: boolean } | undefined)?.done),
      recognitionClosed: Boolean(activity.audioRecognition?.isClosed),
      interrupted: Boolean(activity.pausedSpeech?.handle.interrupted), done: Boolean(activity.pausedSpeech?.handle.done?.()),
      state: ["initializing", "idle", "listening", "thinking", "speaking"].indexOf(activity.agentSession.agentState ?? ""), paused };
  };
  const emit = (activity: Activity, callback: number, phase: number, invocation: number, fields: Record<string, number | boolean> = {}) => {
    if (active && records++ < 1600) clock.mark("pause_lifecycle", { callback, phase, invocation, owner, ...snapshot(activity), ...fields });
  };
  for (const [index, name] of pauseCallbacks.entries()) {
    const original = prototype[name];
    if (typeof original !== "function") throw new Error("Audited pause callback unavailable");
    prototype[name] = function (...args) {
      if (!active || this.agentSession !== session) return original.apply(this, args);
      const invocation = ++call, priorOwner = owner; owner = index + 1;
      const before = snapshot(this), vad = name === "onVADInferenceDone", ev = args[0] as Record<string, unknown> | undefined;
      const report = !vad || clock.now() - lastVad >= 200;
      const fields: Record<string, number | boolean> = {};
      if (name === "onStartOfSpeech" || name === "onEndOfSpeech" || vad) {
        for (const key of ["speechDuration", "silenceDuration", "rawAccumulatedSilence", "inferenceDuration"])
          if (typeof ev?.[key] === "number" && Number.isFinite(ev[key])) fields[key] = ev[key] as number;
        if (typeof ev?.speaking === "boolean") fields.speaking = ev.speaking;
      }
      if (typeof args[0] === "number") fields.timeout = args[0];
      if (report) { emit(this, index + 1, 1, invocation, fields); if (vad) lastVad = clock.now(); }
      // This SDK schedules exactly one timer synchronously in this method. Observe
      // that callback without changing its deadline, arguments, return or ownership.
      const set = globalThis.setTimeout;
      if (name === "startFalseInterruptionTimer") {
        const activity = this;
        globalThis.setTimeout = ((fn: (...values: unknown[]) => unknown, delay?: number, ...values: unknown[]) => {
          let timer: ReturnType<typeof setTimeout>;
          timer = set(function (this: unknown, ...callbackArgs: unknown[]) {
            const oldOwner = owner; owner = index + 1;
            emit(activity, index + 1, 4, invocation, { firedTimer: id(timer) });
            try { return fn.apply(this, callbackArgs); }
            finally { emit(activity, index + 1, 5, invocation, { firedTimer: id(timer) }); owner = oldOwner; }
          }, delay, ...values);
          return timer;
        }) as typeof setTimeout;
      }
      try {
        const result = original.apply(this, args);
        const after = snapshot(this);
        if (report || before.silent !== after.silent || before.held !== after.held || before.timer !== after.timer || before.paused !== after.paused)
          emit(this, index + 1, 2, invocation, fields);
        // Preserve the original Promise identity; observing settlement must not
        // replace the SDK result or create an unhandled rejection.
        if (result instanceof Promise) void result.then(() => emit(this, index + 1, 6, invocation), () => emit(this, index + 1, 3, invocation));
        return result;
      } catch (error) { emit(this, index + 1, 3, invocation); throw error; }
      finally { if (name === "startFalseInterruptionTimer") globalThis.setTimeout = set; owner = priorOwner; }
    };
    restore.push(() => { prototype[name] = original; });
  }
  return { dispose() { if (!active) return; clock.mark("pause_observer_end", { records: Math.min(records, 1600) }); active = false; for (const undo of restore.reverse()) undo(); } };
}
