import type { VoiceStage } from "@workspace/observability/runtime/operational-metrics";

// Stage boundary events. Fixed names and numeric fields only: never transcripts, identities or payloads.
export const stageEvents = ["session_start", "user_speaking", "user_listening", "stt_interim", "stt_final", "eou", "llm_start", "llm_first", "llm_end",
  "tts_start", "tts_authorized", "tts_first_audio", "tts_end", "agent_listening", "agent_thinking", "agent_speaking", "false_interruption", "error",
  "greeting_done", "loop_stall", "heartbeat_late", "heartbeat_retry", "heartbeat_lost", "session_end", "agent_track_published", "agent_track_subscribed",
  "agent_connected", "audio_track_created", "publication_started", "publication_resolved", "publication_rejected", "publication_timeout", "subscription_timeout", "subscription_ready"] as const;
/** Why a job ended its session; a closed set so logs and events stay bounded. */
export const closeReasons = ["heartbeat", "room_disconnected", "session_closed", "session_error", "shutdown", "start_failed", "connection_timeout", "media_timeout", "publication_rejected", "media_cancelled"] as const;
export type CloseReason = typeof closeReasons[number];
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
  private readonly sending = new Set<Promise<void>>();
  private forwarding = false;
  constructor(private readonly mode: Observation["mode"], private readonly publish?: (payload: Uint8Array) => Promise<void>, private readonly forward?: (batch: Observation[]) => Promise<void>, private readonly correlation?: string) {}
  now(): number { return performance.now(); }
  mark(event: StageEvent, fields: Fields = {}): number {
    const at = performance.now();
    if (this.publish && this.sending.size < 64) {
      const payload = new TextEncoder().encode(JSON.stringify({ e: event, t: Math.round((at - this.origin) * 10) / 10,
        ...(/^[0-9a-f-]{36}$/.test(this.correlation ?? "") ? { correlation: this.correlation } : {}), ...fields }));
      const sent = this.publish(payload).catch(() => undefined);
      this.sending.add(sent); void sent.finally(() => this.sending.delete(sent));
    }
    return at;
  }
  /** Waits (bounded) for published events, so the last ones are not lost when the room disconnects. */
  async delivered(ms = 500) {
    await Promise.race([Promise.allSettled([...this.sending]), new Promise(r => setTimeout(r, ms))]);
  }
  observe(stage: VoiceStage, provider: Observation["provider"], outcome: Observation["outcome"], ms: number) {
    if (!this.forward || !Number.isFinite(ms) || ms < 0) return;
    if (this.queue.length >= 200) return;
    this.queue.push({ stage, provider, mode: this.mode, outcome, ms: Math.round(ms * 10) / 10 });
    if (this.queue.length >= 50) void this.flush();
    else this.timer ??= setTimeout(() => { void this.flush(); }, 2000);
  }
  async flush() {
    if (this.forwarding) return;
    clearTimeout(this.timer); this.timer = undefined;
    const batch = this.queue.splice(0, 200);
    if (batch.length && this.forward) {
      this.forwarding = true;
      try { await this.forward(batch).catch(() => undefined); }
      finally { this.forwarding = false; }
    }
    if (this.queue.length) this.timer ??= setTimeout(() => { void this.flush(); }, 2000);
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
