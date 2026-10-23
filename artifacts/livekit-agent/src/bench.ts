import type { VoiceStage } from "@workspace/observability/runtime/operational-metrics";

// Stage boundary events. Fixed names and numeric fields only: never transcripts, identities or payloads.
export const stageEvents = ["session_start", "user_speaking", "user_listening", "stt_interim", "stt_final", "eou", "llm_start", "llm_first", "llm_end",
  "tts_start", "tts_authorized", "tts_first_audio", "tts_end", "agent_listening", "agent_thinking", "agent_speaking", "false_interruption", "error"] as const;
export type StageEvent = typeof stageEvents[number];
type Fields = Record<string, number | boolean>;
export type Observation = { stage: VoiceStage; provider: "deepgram" | "sarvam" | "livekit" | "internal"; mode: "mock" | "live"; outcome: "success" | "cancelled" | "error" | "timeout"; ms: number };

/**
 * Timestamps come from one process's monotonic clock (performance.now) relative to the job start,
 * so intervals between them are valid. They are never compared with another machine's clock.
 */
export class StageClock {
  private readonly origin = performance.now();
  private queue: Observation[] = [];
  private timer?: NodeJS.Timeout;
  constructor(private readonly mode: Observation["mode"], private readonly publish?: (payload: Uint8Array) => Promise<void>, private readonly forward?: (batch: Observation[]) => Promise<void>) {}
  now(): number { return performance.now(); }
  mark(event: StageEvent, fields: Fields = {}): number {
    const at = performance.now();
    if (this.publish) {
      const payload = new TextEncoder().encode(JSON.stringify({ e: event, t: Math.round((at - this.origin) * 10) / 10, ...fields }));
      void this.publish(payload).catch(() => undefined);
    }
    return at;
  }
  observe(stage: VoiceStage, provider: Observation["provider"], outcome: Observation["outcome"], ms: number) {
    if (!this.forward || !Number.isFinite(ms) || ms < 0) return;
    this.queue.push({ stage, provider, mode: this.mode, outcome, ms: Math.round(ms * 10) / 10 });
    if (this.queue.length >= 50) void this.flush();
    else this.timer ??= setTimeout(() => { void this.flush(); }, 2000);
  }
  async flush() {
    clearTimeout(this.timer); this.timer = undefined;
    const batch = this.queue.splice(0, 200);
    if (batch.length && this.forward) await this.forward(batch).catch(() => undefined);
  }
}

/** Job processes forward aggregate observations to the worker's own /metrics registry over loopback. */
export function forwardToWorker(secret: string | undefined, port = 8082) {
  return async (observations: Observation[]) => {
    if (!secret) return;
    await fetch(`http://127.0.0.1:${port}/observe`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ observations }), signal: AbortSignal.timeout(1000) }).then(r => r.body?.cancel());
  };
}
