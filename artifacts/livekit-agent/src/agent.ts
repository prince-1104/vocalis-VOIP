import { defineAgent, initializeLogger, voice, llm } from "@livekit/agents";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as sarvam from "@livekit/agents-plugin-sarvam";
import * as silero from "@livekit/agents-plugin-silero";
import { RoomEvent } from "@livekit/rtc-node";
import { RoomServiceClient } from "livekit-server-sdk";
import { ReadableStream } from "node:stream/web";
import { randomUUID } from "node:crypto";
import { DialogApi, DialogDenied, leaseLost, reference, type Claim } from "./api";
import { StageClock, forwardToWorker, type CloseReason } from "./bench";
import { voiceTuning } from "./voice-tuning";
import { DialogSentenceTokenizer } from "./sentences";
import { observePublication, MediaReadinessError } from "./media-readiness";
import { observeAudioPipeline, frameMeasure } from "./audio-diagnostics";
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
    clock.mark("llm_authorized");
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
    let settled = false, firstAudio = false, frames = 0, audioMs = 0, peak = 0;
    const settle = async (ended: "complete" | "cancelled" | "failed") => {
      if (settled) return; settled = true;
      // The plugin ends the stream normally when the provider socket is refused or closes before
      // its final event, and the SDK ends it after an idle timeout. With text sent but no audio
      // received, whether the provider billed is unknown and must stay open for reconciliation.
      const outcome = ended === "complete" && (firstAudio || characters === 0) ? "charged" : "unknown";
      const cancelled = ended === "cancelled";
      clock.mark("tts_end", { cancelled, noAudio: !firstAudio });
      clock.mark("tts_audio_summary", { frames, audioMs: Math.round(audioMs), peak, cancelled, failed: ended === "failed" });
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
            const measured = frameMeasure(next.value); frames++; audioMs += measured.ms; peak = Math.max(peak, measured.peak);
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
    logger.info({ event: "livekit_process_initializing", uptimeMs: Math.round(process.uptime() * 1000) }, "Voice process prewarm started");
    try {
      proc.userData.vad = await silero.VAD.load({ forceCPU: true });
      const vadLoaded = performance.now();
      const ready = await fetch(`http://127.0.0.1:8082/process-ready/${process.pid}`, {
        method: "POST", headers: { authorization: `Bearer ${process.env.LIVEKIT_WORKER_SECRET}` }, signal: AbortSignal.timeout(2000),
      });
      if (!ready.ok) { await ready.body?.cancel(); throw new Error("Process readiness unavailable"); }
      logger.info({ event: "livekit_process_ready", vadLoadMs: Math.round(vadLoaded - started), registrationMs: Math.round(performance.now() - vadLoaded), uptimeMs: Math.round(process.uptime() * 1000) }, "Voice job process ready");
    } catch {
      logger.warn({ event: "livekit_process_failed", elapsedMs: Math.round(performance.now() - started) }, "Voice process initialization failed");
      throw new Error("Voice process initialization failed");
    }
  },
  entry: async ctx => {
    initializeLogger({ level: "silent", pretty: false });
    const api = new DialogApi();
    const id = reference(ctx.job.metadata);
    if (!ctx.proc.userData.vad) throw new Error("VAD not prewarmed");
    const diagnosticId = ctx.info.acceptArguments.attributes?.["dialog.diagnostic"] ?? randomUUID();
    logger.info({ event: "livekit_job_entry", diagnosticId, uptimeMs: Math.round(performance.now()) }, "Voice job entered prewarmed process");
    // The claim is authorized before joining, so ctx.room is not connected yet and
    // its name is still undefined; only the job's room descriptor carries it here.
    const claimSent = performance.now();
    const claim = await api.json<Claim>("/claim", { id, room: ctx.job.room?.name ?? "", worker: ctx.workerId });
    logger.info({ event: "livekit_job_claimed", diagnosticId, uptimeMs: Math.round(performance.now()), claimMs: Math.round(performance.now() - claimSent) }, "Voice job claimed");
    // Stage events go to the room only for local benchmarking; they contain timings, never content.
    const bench = process.env.DIALOG_VOICE_BENCH === "1" && (claim.mode === "mock" || process.env.DIALOG_LOCAL_VOICE_PROFILE === "manual-live");
    const clock = new StageClock(claim.mode,
      bench ? async payload => { await ctx.room.localParticipant?.publishData(payload, { reliable: true, topic: "dialog.bench" }); } : undefined,
      forwardToWorker(process.env.LIVEKIT_WORKER_SECRET), diagnosticId);
    const turn: TurnState = { agentSpeaking: false };
    const controller = new AbortController();
    let session: voice.AgentSession | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let connectDeadline: NodeJS.Timeout | undefined;
    let ending: Promise<void> | undefined;
    let media: ReturnType<typeof observePublication> | undefined;
    let audioDiagnostics: ReturnType<typeof observeAudioPipeline> | undefined;
    const sttOperation = randomUUID();
    let sttAdmitted = false;
    // Event-loop stalls starve the heartbeat and audio pacing; record them (duration only).
    let tick = performance.now();
    const loopWatch = setInterval(() => {
      const now = performance.now(), lag = now - tick - 250; tick = now;
      if (lag > 300) clock.mark("loop_stall", { ms: Math.round(lag) });
    }, 250);
    const close = (reason: CloseReason): Promise<void> => ending ??= (async () => {
      const closingAt = performance.now();
      controller.abort();
      media?.dispose();
      clearTimeout(heartbeat); clearTimeout(connectDeadline); clearInterval(loopWatch);
      clock.mark("session_end", { [reason]: true });
      const closing = { event: "livekit_session_closing", diagnosticId, reason };
      if (["media_timeout", "publication_rejected", "connection_timeout", "heartbeat", "session_error", "start_failed"].includes(reason)) logger.warn(closing, "Voice session closing");
      else logger.info(closing, "Voice session closing");
      if (reason === "media_timeout" || reason === "publication_rejected") {
        // Independent server view. Log counts only; never room/participant/track IDs.
        try {
          const rooms = new RoomServiceClient((process.env.LIVEKIT_URL ?? "").replace(/^ws/, "http"),
            process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { requestTimeout: 1, failover: false });
          const participants = await rooms.listParticipants(ctx.job.room?.name ?? "");
          const local = participants.find(p => p.attributes["dialog.diagnostic"] === diagnosticId);
          logger.warn({ event: "livekit_server_media_state", diagnosticId, participantCount: participants.length,
            agentPresent: Boolean(local), agentPublicationCount: local?.tracks.length ?? 0 }, "Server media state");
        } catch { logger.warn({ event: "livekit_server_media_state", diagnosticId, unavailable: true }, "Server media state unavailable"); }
      }
      await clock.delivered();
      // Disconnect first: rtc-node publication waits are cancelled by its disconnect signal.
      const bounded = async (work: Promise<unknown>) => {
        let timer: NodeJS.Timeout | undefined;
        try { await Promise.race([work.catch(() => undefined), new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); }
        finally { clearTimeout(timer); }
      };
      await bounded(ctx.room.disconnect());
      if (session) await bounded(session.close());
      audioDiagnostics?.dispose();
      if (sttAdmitted) await api.request(`/${id}/usage`, { operationId: sttOperation, outcome: "unknown" }, claim.credential).catch(() => undefined);
      await api.request(`/${id}/close`, {}, claim.credential).catch(() => undefined);
      await clock.flush();
      logger.info({ event: "livekit_session_closed", diagnosticId, reason, cleanupMs: Math.round(performance.now() - closingAt) }, "Voice session closed");
      ctx.shutdown(reason);
    })();
    ctx.addShutdownCallback(() => close("shutdown"));
    ctx.room.once(RoomEvent.Disconnected, () => { void close("room_disconnected"); });
    let lastBeat = performance.now();
    // Dialog extends the lease to 15 s after it receives a renewal, so a renewal sent at T keeps it until at least T + 15 s.
    let leaseDeadline = claimSent + 15000;
    const beat = async () => {
      const finish = metrics.operation("livekit_lease", "livekit");
      const sent = performance.now();
      try {
        await api.json(`/${id}/heartbeat`, {}, claim.credential, controller.signal, 4000);
        const now = performance.now();
        // A renewal gap far beyond the 5 s cadence means the process was starved.
        if (now - lastBeat > 8000) clock.mark("heartbeat_late", { gapMs: Math.round(now - lastBeat), rttMs: Math.round(now - sent) });
        lastBeat = now; leaseDeadline = sent + 15000;
        if (!controller.signal.aborted) heartbeat = setTimeout(() => { void beat(); }, 5000);
        finish();
      } catch (error) {
        finish("blocked");
        if (controller.signal.aborted) return;
        if (leaseLost(error, performance.now(), leaseDeadline)) {
          clock.mark("heartbeat_lost", { status: error instanceof DialogDenied ? error.status : 0, sinceRenewalMs: Math.round(performance.now() - (leaseDeadline - 15000)) });
          await close("heartbeat"); return;
        }
        clock.mark("heartbeat_retry", { rttMs: Math.round(performance.now() - sent) });
        heartbeat = setTimeout(() => { void beat(); }, 250);
      }
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
        ...(tuning.aecWarmupMs === null ? {} : { aecWarmupDuration: tuning.aecWarmupMs || null }),
        turnHandling: { turnDetection: "stt", endpointing: { minDelay: tuning.endpointingMinMs, maxDelay: tuning.endpointingMaxMs },
          interruption: { mode: "vad", enabled: true }, preemptiveGeneration: { enabled: tuning.preemptiveLlm, preemptiveTts: false } },
        connOptions: { sttConnOptions: { maxRetry: 0, timeoutMs: 8000 }, ttsConnOptions: { maxRetry: 0, timeoutMs: 8000 }, maxUnrecoverableErrors: 1 } });
      session.input.setAudioEnabled(false);
      let interimFrom: number | undefined;
      let speechOrdinal = 0;
      session.on(voice.AgentSessionEventTypes.SpeechCreated, ev => {
        const speech = ++speechOrdinal;
        clock.mark("speech_created", { speech, userInitiated: ev.userInitiated });
        ev.speechHandle.addDoneCallback(handle => { clock.mark("speech_done", { speech, interrupted: handle.interrupted }); });
      });
      session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ev => {
        if (ev.item.type === "message") clock.mark("conversation_committed", { user: ev.item.role === "user", assistant: ev.item.role === "assistant" });
      });
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
      session.once(voice.AgentSessionEventTypes.Close, () => { void close("session_closed"); });
      session.on(voice.AgentSessionEventTypes.Error, ev => {
        const kind = (ev.error as { type?: string }).type ?? "";
        clock.mark("error", { stt: kind === "stt_error", tts: kind === "tts_error", llm: kind === "llm_error" });
        void close("session_error");
      });
      // Agent audio plays out only after the participant subscribes to the published track.
      ctx.room.once(RoomEvent.LocalTrackPublished, publication => { clock.mark("agent_track_published"); if (publication?.track) audioDiagnostics?.published(publication.track as import("@livekit/rtc-node").LocalAudioTrack); });
      ctx.room.once(RoomEvent.LocalTrackSubscribed, () => { clock.mark("agent_track_subscribed"); });
      connectDeadline = setTimeout(() => { void close("connection_timeout"); }, 12000);
      await ctx.connect();
      clearTimeout(connectDeadline);
      controller.signal.throwIfAborted();
      clock.mark("agent_connected");
      if (!ctx.room.localParticipant) throw new Error("Missing local participant");
      const mediaOrigin = performance.now();
      if (bench) audioDiagnostics = observeAudioPipeline(clock, controller.signal);
      media = observePublication(ctx.room.localParticipant, (event, state) => {
        clock.mark(event, state);
        const fields = { event, diagnosticId, elapsedMs: Math.round(performance.now() - mediaOrigin), ...state };
        if (["publication_timeout", "subscription_timeout", "publication_rejected"].includes(event)) logger.warn(fields, "Voice media readiness failed");
        else logger.info(fields, "Voice media readiness");
      }, controller.signal);
      // Close immediately even when session.start itself is still pending.
      void media.ready.catch(error => close(error instanceof MediaReadinessError ? error.reason : "start_failed"));
      clock.mark("session_start", { endpointingMinMs: tuning.endpointingMinMs, endpointingMaxMs: tuning.endpointingMaxMs, sttEndpointingMs: tuning.sttEndpointingMs, preemptiveLlm: tuning.preemptiveLlm, ttsIdleTimeoutMs: tuning.ttsIdleTimeoutMs, aecWarmupMs: tuning.aecWarmupMs ?? -1 });
      await session.start({ agent: new DialogAgent(api, id, claim, controller.signal, clock, turn), room: ctx.room, record: false,
        inputOptions: { participantIdentity: claim.participant, textEnabled: false, videoEnabled: false, closeOnDisconnect: true } });
      controller.signal.throwIfAborted();
      await media.ready;
      controller.signal.throwIfAborted();
      if (session.output.audio) audioDiagnostics?.output(session.output.audio);
      session.input.setAudioEnabled(true);
      const greeting = session.say(claim.greeting, { allowInterruptions: true });
      void greeting.waitForPlayout().then(() => clock.mark("greeting_done", { interrupted: greeting.interrupted }), () => undefined);
    } catch (error) { await close(error instanceof MediaReadinessError ? error.reason : "start_failed"); }
  },
});
