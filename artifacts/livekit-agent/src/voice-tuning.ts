// Turn-taking and streaming settings. Values are operator configuration, never tenant input,
// and are validated at startup so a typo cannot silently fall back to a different behaviour.
export type VoiceTuning = {
  /** Deepgram `endpointing`: trailing silence (ms) before the provider marks speech_final. */
  sttEndpointingMs: number;
  /** LiveKit endpointing.minDelay. In STT turn detection it is added after the STT end-of-speech signal. */
  endpointingMinMs: number;
  /** LiveKit endpointing.maxDelay. */
  endpointingMaxMs: number;
  /** LiveKit preemptive LLM generation. Preemptive TTS is never enabled. */
  preemptiveLlm: boolean;
  /** LiveKit ttsReadIdleTimeout: longest wait for the next synthesized frame (including the first) before the reply is dropped. */
  ttsIdleTimeoutMs: number;
};

// Values in effect before Phase 1R tuning, i.e. the installed SDK/plugin defaults.
export const baselineTuning: VoiceTuning = Object.freeze({ sttEndpointingMs: 25, endpointingMinMs: 500, endpointingMaxMs: 3000, preemptiveLlm: true, ttsIdleTimeoutMs: 10000 });
// Phase 1R evidence (docs/production-readiness/real-time-voice-latency.md): minDelay 200 ms split
// most 450 ms pauses; disabling preemptive generation saved ~20 ms but stalled the first user
// turn in 4 of 10 sessions (0 of 10 with it enabled), so both stay at baseline.
export const defaultTuning: VoiceTuning = baselineTuning;

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d{1,5}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`Invalid voice tuning: ${name}`);
  return Number(raw);
}

export function voiceTuning(env: NodeJS.ProcessEnv = process.env): VoiceTuning {
  const sttEndpointingMs = integer(env, "DIALOG_VOICE_STT_ENDPOINTING_MS", defaultTuning.sttEndpointingMs, 10, 2000);
  const endpointingMinMs = integer(env, "DIALOG_VOICE_ENDPOINTING_MIN_MS", defaultTuning.endpointingMinMs, 0, 2000);
  const endpointingMaxMs = integer(env, "DIALOG_VOICE_ENDPOINTING_MAX_MS", defaultTuning.endpointingMaxMs, 500, 6000);
  if (endpointingMaxMs < endpointingMinMs) throw new Error("Invalid voice tuning: DIALOG_VOICE_ENDPOINTING_MAX_MS");
  const preemptive = env.DIALOG_VOICE_PREEMPTIVE_LLM;
  if (preemptive !== undefined && preemptive !== "" && preemptive !== "on" && preemptive !== "off") throw new Error("Invalid voice tuning: DIALOG_VOICE_PREEMPTIVE_LLM");
  const ttsIdleTimeoutMs = integer(env, "DIALOG_VOICE_TTS_IDLE_TIMEOUT_MS", defaultTuning.ttsIdleTimeoutMs, 2000, 30000);
  return { sttEndpointingMs, endpointingMinMs, endpointingMaxMs, preemptiveLlm: preemptive ? preemptive === "on" : defaultTuning.preemptiveLlm, ttsIdleTimeoutMs };
}
