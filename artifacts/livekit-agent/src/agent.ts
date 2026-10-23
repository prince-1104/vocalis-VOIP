import { defineAgent, initializeLogger, voice, llm } from "@livekit/agents";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as sarvam from "@livekit/agents-plugin-sarvam";
import * as silero from "@livekit/agents-plugin-silero";
import { RoomEvent } from "@livekit/rtc-node";
import { ReadableStream } from "node:stream/web";
import { randomUUID } from "node:crypto";
import { DialogApi, reference, type Claim } from "./api";
import { StageClock, forwardToWorker } from "./bench";
import { voiceTuning } from "./voice-tuning";
import { DialogSentenceTokenizer } from "./sentences";
import { logger } from "@workspace/observability/runtime/logger";
import { metrics } from "@workspace/observability/runtime/operational-metrics";

initializeLogger({ level: "silent", pretty: false });
const tuning = voiceTuning();
// AgentSession requires an LLM model object even when its supported llmNode
// extension performs the transport. No cloud inference model is implicitly created.
class DialogTransportModel extends llm.LLM {
  label() { return "dialog-api"; }
  override get provider() { return "dialog"; }
  override get model() { return "api-resolved"; }
  chat(): llm.LLMStream { throw new Error("DialogAgent.llmNode is required"); }
}
/** Shared turn state used only to time interruption handling. */
type TurnState = { agentSpeaking: boolean; interruptedAt?: number };
class DialogAgent extends voice.Agent {
  constructor(readonly api: DialogApi, readonly sessionId: string, readonly claim: Claim, readonly signal: AbortSignal,
    readonly clock: StageClock, readonly turn: TurnState) {
    // Instructions and model resolution belong to the API; this text never authorizes provider work.
    super({ instructions: "Dialog API controls the conversation.", llm: new DialogTransportModel() });
  }
  override async llmNode(chat: llm.ChatContext) {
    const controller = new AbortController();
    const signal = AbortSignal.any([this.signal, controller.signal]);
    const clock = this.clock, started = clock.mark("llm_start");
    let first = 0, completed = false, ended = false;
    const end = (outcome: "success" | "cancelled" | "error") => {
      if (ended) return; ended = true;
      clock.mark("llm_end", { cancelled: outcome === "cancelled", error: outcome === "error" });
      clock.observe("llm_total", "internal", outcome, clock.now() - started);
    };
    let response: Response;
    try {
      response = await this.api.request(`/${this.sessionId}/llm`, { messages: chat.items.flatMap(i => i.type === "message" && i.role !== "system" ? [{ role: i.role, content: i.textContent ?? "" }] : []) }, this.claim.credential, signal);
    } catch (e) { end(signal.aborted ? "cancelled" : "error"); throw e; }
    const reader = response.body!.getReader();
    // One decoder per stream: multi-byte characters (Devanagari is 3 bytes) can span chunks.
    const decoder = new TextDecoder();
    let pending = "";
    const iterator = async function* () {
      try {
        while (!signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) { completed = true; break; }
          pending += decoder.decode(chunk.value, { stream: true });
          if (pending.length > 65536) throw new Error("Stream limit exceeded");
          let boundary: number;
          while ((boundary = pending.indexOf("\n\n")) >= 0) {
            const line = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
            if (line === "data: [DONE]") { completed = true; return; }
            if (line.startsWith("data: ") && !signal.aborted) {
              if (!first) { first = clock.mark("llm_first"); clock.observe("llm_first_token", "internal", "success", first - started); }
              yield String(JSON.parse(line.slice(6)).text);
            }
          }
        }
      } catch (e) { end(signal.aborted ? "cancelled" : "error"); throw e; }
      finally { end(completed ? "success" : "cancelled"); controller.abort(); await reader.cancel().catch(() => undefined); }
    }();
    return new ReadableStream<string>({
      async pull(out) { try { const part = await iterator.next(); if (part.done) out.close(); else out.enqueue(part.value); } catch (e) { out.error(e); } },
      async cancel() { controller.abort(); await iterator.return(); },
    });
  }
  override async ttsNode(text: Parameters<voice.Agent["ttsNode"]>[0], settings: Parameters<voice.Agent["ttsNode"]>[1]) {
    this.signal.throwIfAborted();
    const clock = this.clock, turn = this.turn, started = clock.mark("tts_start");
    const operationId = randomUUID();
    await this.api.json(`/${this.sessionId}/authorize`, { component: "tts", operationId }, this.claim.credential, this.signal);
    const authorized = clock.mark("tts_authorized");
    clock.observe("tts_authorize", "internal", "success", authorized - started);
    this.signal.throwIfAborted();
    let characters = 0;
    const iterator = (async function* () { for await (const chunk of text) { characters += chunk.length; if (characters > 6000) throw new Error("Synthesis limit"); yield chunk; } })();
    const source = new ReadableStream<string>({
      async pull(out) { try { const next = await iterator.next(); if (next.done) out.close(); else out.enqueue(next.value); } catch (e) { out.error(e); } },
      async cancel() { await iterator.return(); },
    });
    const audio = await super.ttsNode(source, settings);
    if (!audio) return null;
    const reader = audio.getReader(); const api = this.api, id = this.sessionId, claim = this.claim, signal = this.signal;
    let settled = false, firstAudio = false;
    const settle = async (ended: "complete" | "cancelled" | "failed") => {
      if (settled) return; settled = true;
      // The plugin ends the stream normally when the provider socket is refused or closes before
      // its final event, and the SDK ends it after an idle timeout. With text sent but no audio
      // received, whether the provider billed is unknown and must stay open for reconciliation.
      const outcome = ended === "complete" && (firstAudio || characters === 0) ? "charged" : "unknown";
      const cancelled = ended === "cancelled";
      clock.mark("tts_end", { cancelled, noAudio: !firstAudio });
      clock.observe("tts_total", "sarvam", cancelled ? "cancelled" : outcome === "charged" ? "success" : "error", clock.now() - authorized);
      if (cancelled && turn.interruptedAt !== undefined) { clock.observe("interruption_cancel", "livekit", "success", clock.now() - turn.interruptedAt); turn.interruptedAt = undefined; }
      await api.request(`/${id}/usage`, { operationId, outcome, quantity: characters }, claim.credential).catch(() => undefined);
    };
    return new ReadableStream({
      async pull(out) {
        try {
          signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted();
          if (next.done) { await settle("complete"); out.close(); }
          else {
            if (!firstAudio) { firstAudio = true; clock.observe("tts_first_audio", "sarvam", "success", clock.mark("tts_first_audio") - authorized); }
            out.enqueue(next.value);
          }
        } catch (e) { await settle(signal.aborted ? "cancelled" : "failed"); out.error(e); }
      },
      async cancel() { await reader.cancel(); await settle("cancelled"); },
    });
  }
}
export default defineAgent({
  // The VAD model loads before any job (and its 15s claim lease) starts; loading it inside
  // the entry starved the heartbeat loop long enough to expire the lease on slow machines.
  prewarm: async proc => {
    const started = performance.now();
    proc.userData.vad = await silero.VAD.load({ forceCPU: true });
    logger.info({ event: "livekit_process_ready", vadLoadMs: Math.round(performance.now() - started), uptimeMs: Math.round(process.uptime() * 1000) }, "Voice job process ready");
  },
  entry: async ctx => {
    initializeLogger({ level: "silent", pretty: false });
    const api = new DialogApi();
    const id = reference(ctx.job.metadata);
    // The claim is authorized before joining, so ctx.room is not connected yet and
    // its name is still undefined; only the job's room descriptor carries it here.
    const claim = await api.json<Claim>("/claim", { id, room: ctx.job.room?.name ?? "", worker: ctx.workerId });
    // Stage events go to the room only for local benchmarking; they contain timings, never content.
    const bench = process.env.DIALOG_VOICE_BENCH === "1" && (claim.mode === "mock" || process.env.DIALOG_LOCAL_VOICE_PROFILE === "manual-live");
    const clock = new StageClock(claim.mode,
      bench ? async payload => { await ctx.room.localParticipant?.publishData(payload, { reliable: true, topic: "dialog.bench" }); } : undefined,
      forwardToWorker(process.env.LIVEKIT_WORKER_SECRET));
    const turn: TurnState = { agentSpeaking: false };
    const controller = new AbortController();
    let session: voice.AgentSession | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let ending: Promise<void> | undefined;
    const sttOperation = randomUUID();
    let sttAdmitted = false;
    const close = (): Promise<void> => ending ??= (async () => {
      controller.abort();
      clearTimeout(heartbeat);
      await session?.close().catch(() => undefined);
      if (sttAdmitted) await api.request(`/${id}/usage`, { operationId: sttOperation, outcome: "unknown" }, claim.credential).catch(() => undefined);
      await api.request(`/${id}/close`, {}, claim.credential).catch(() => undefined);
      await clock.flush();
      await ctx.room.disconnect().catch(() => undefined);
      logger.info({ event: "livekit_session_closed" }, "Voice session closed");
    })();
    ctx.addShutdownCallback(close);
    ctx.room.once(RoomEvent.Disconnected, () => { void close(); });
    const beat = async () => {
      const finish = metrics.operation("livekit_lease", "livekit");
      try {
        await api.json(`/${id}/heartbeat`, {}, claim.credential, controller.signal);
        if (!controller.signal.aborted) heartbeat = setTimeout(() => { void beat(); }, 5000);
        finish();
      } catch { finish("blocked"); await close(); }
    };
    try {
      if (!claim.speaker || !claim.sttLanguage || !claim.ttsLanguage) throw new Error("Unsupported voice configuration");
      const mocked = claim.mode === "mock";
      const fixtures = mocked ? new URL(process.env.MOCK_PROVIDER_URL ?? "") : undefined;
      if (mocked && !['mock-providers', '127.0.0.1', 'localhost'].includes(fixtures!.hostname)) throw new Error("Mock provider configuration missing");
      if (!mocked && (process.env.DIALOG_LOCAL_VOICE_PROFILE !== "manual-live" || !process.env.DEEPGRAM_API_KEY || !process.env.SARVAM_API_KEY)) throw new Error("Manual provider configuration missing");
      await api.json(`/${id}/authorize`, { component: "stt", operationId: sttOperation }, claim.credential, controller.signal);
      sttAdmitted = true;
      await beat();
      controller.signal.throwIfAborted();
      const vad = ctx.proc.userData.vad as silero.VAD;
      if (!vad) throw new Error("VAD not prewarmed");
      const stt = new deepgram.STT({ apiKey: mocked ? "local-fixture" : process.env.DEEPGRAM_API_KEY, model: "nova-3", language: claim.sttLanguage,
        interimResults: true, endpointing: tuning.sttEndpointingMs,
        ...(fixtures ? { baseUrl: fixtures.origin.replace(/^http/, "ws") } : {}), mipOptOut: true });
      const tts = new sarvam.TTS({ apiKey: mocked ? "local-fixture" : process.env.SARVAM_API_KEY, model: "bulbul:v3", speaker: claim.speaker,
        targetLanguageCode: claim.ttsLanguage, streaming: true, sentenceTokenizer: new DialogSentenceTokenizer(),
        ...(fixtures ? { baseURL: fixtures.origin } : {}), outputAudioCodec: "linear16", sampleRate: 24000 });
      session = new voice.AgentSession({ stt, tts, vad, ttsReadIdleTimeout: tuning.ttsIdleTimeoutMs,
        turnHandling: { turnDetection: "stt", endpointing: { minDelay: tuning.endpointingMinMs, maxDelay: tuning.endpointingMaxMs },
          interruption: { mode: "vad", enabled: true }, preemptiveGeneration: { enabled: tuning.preemptiveLlm, preemptiveTts: false } },
        connOptions: { sttConnOptions: { maxRetry: 0, timeoutMs: 8000 }, ttsConnOptions: { maxRetry: 0, timeoutMs: 8000 }, maxUnrecoverableErrors: 1 } });
      let interimFrom: number | undefined;
      session.on(voice.AgentSessionEventTypes.UserStateChanged, ev => {
        if (ev.newState === "speaking") {
          const at = clock.mark("user_speaking"); interimFrom = at;
          if (turn.agentSpeaking) turn.interruptedAt = at;
        } else if (ev.newState === "listening") clock.mark("user_listening");
      });
      session.on(voice.AgentSessionEventTypes.UserInputTranscribed, ev => {
        const at = clock.mark(ev.isFinal ? "stt_final" : "stt_interim");
        if (interimFrom !== undefined) { clock.observe("stt_first_interim", "deepgram", "success", at - interimFrom); interimFrom = undefined; }
      });
      session.on(voice.AgentSessionEventTypes.AgentStateChanged, ev => {
        turn.agentSpeaking = ev.newState === "speaking";
        if (ev.newState === "speaking") { clock.mark("agent_speaking"); turn.interruptedAt = undefined; }
        else if (ev.newState === "thinking") clock.mark("agent_thinking");
        else if (ev.newState === "listening") clock.mark("agent_listening");
      });
      session.on(voice.AgentSessionEventTypes.MetricsCollected, ev => {
        if (ev.metrics.type !== "eou_metrics") return;
        const { transcriptionDelayMs, endOfUtteranceDelayMs } = ev.metrics;
        clock.mark("eou", { transcriptionDelayMs: Math.round(transcriptionDelayMs), endOfUtteranceDelayMs: Math.round(endOfUtteranceDelayMs) });
        clock.observe("stt_transcription_delay", "deepgram", "success", transcriptionDelayMs);
        clock.observe("end_of_turn_delay", "livekit", "success", endOfUtteranceDelayMs);
      });
      session.on(voice.AgentSessionEventTypes.AgentFalseInterruption, ev => { clock.mark("false_interruption", { resumed: ev.resumed }); });
      session.once(voice.AgentSessionEventTypes.Close, () => { void close(); });
      session.on(voice.AgentSessionEventTypes.Error, ev => {
        const kind = (ev.error as { type?: string }).type ?? "";
        clock.mark("error", { stt: kind === "stt_error", tts: kind === "tts_error", llm: kind === "llm_error" });
        void close();
      });
      await ctx.connect();
      controller.signal.throwIfAborted();
      clock.mark("session_start", { endpointingMinMs: tuning.endpointingMinMs, endpointingMaxMs: tuning.endpointingMaxMs, sttEndpointingMs: tuning.sttEndpointingMs, preemptiveLlm: tuning.preemptiveLlm, ttsIdleTimeoutMs: tuning.ttsIdleTimeoutMs });
      await session.start({ agent: new DialogAgent(api, id, claim, controller.signal, clock, turn), room: ctx.room, record: false,
        inputOptions: { participantIdentity: claim.participant, textEnabled: false, videoEnabled: false, closeOnDisconnect: true } });
      controller.signal.throwIfAborted();
      session.say(claim.greeting, { allowInterruptions: true });
    } catch { await close(); }
  },
});
