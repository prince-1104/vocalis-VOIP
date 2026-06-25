import { WebSocketServer, WebSocket } from "ws";
import { URL } from "url";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { db, callLogsTable, intentTrainingTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { toFile } from "openai";
import { crmEventBus } from "./crm-event-bus";
import { logLLMCost, logTTSCost, resolveTenantIdForOwner } from "./cost-logger";
import { classifyIntent, shouldTransfer, detectHumanRequest, type TransferRules } from "./intent-classifier";
import { findBestAgent, buildTransferEventData, executeTransfer } from "./transfer-manager";
import {
  countUserTurns,
  resolveAgentPhone,
  DEFAULT_CAMPAIGN_CLOSING_MESSAGE,
} from "./campaign-transfer";
import { logger } from "./logger";
import { hangupCall } from "./telephony/hangup-call";
import { registerExotelStream, unregisterExotelStream } from "./telephony/exotel-stream-registry";
import OpenAI from "openai";
import { buildWhisperPrompt, normalizePhoneTranscript } from "./phone-stt-normalize";
import {
  getActiveLanguageMenu,
  buildLanguageMenuPrompt,
  resolveLanguageFromDigit,
  resolveCallLanguage,
  shouldAutoDetectLanguage,
  greetingForLanguage,
} from "./language-menu";

import {
  getCallMeta,
  getCachedAgentConfig,
  getCachedSystemPrompt,
  resolveActiveScript,
  isIndianLanguage,
  detectCallLanguage,
  callSarvamSTT,
  BULBUL_VOICE_FOR_LANG,
  finalizeCallLog,
} from "../routes/twilio";
import {
  resolveCrmOpeningGreeting,
  applyPitchTemplate,
} from "./external-crm-lookup";
import { shouldAutoHangupAfterTurn } from "./call-end-detector";

// ── bitwise G.711 mu-law Codec ─────────────────────────────────────────
const SIGN_BIT = 0x80;
const QUANT_MASK = 0xf;
const BIAS = 0x84;
const CLIP = 32635;

const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const byte = ~i & 0xFF;
  const sign = (byte & 0x80) ? -1 : 1;
  const exponent = (byte >> 4) & 0x07;
  const mantissa = byte & 0x0F;
  let sample = (mantissa << 3) + 132;
  sample <<= exponent;
  sample -= 132;
  MULAW_DECODE_TABLE[i] = sign * sample;
}

function decodeMuLawBuffer(muLawBuffer: Buffer): Int16Array {
  const pcm = new Int16Array(muLawBuffer.length);
  for (let i = 0; i < muLawBuffer.length; i++) {
    pcm[i] = MULAW_DECODE_TABLE[muLawBuffer[i]];
  }
  return pcm;
}

function linear2ulaw(pcmVal: number): number {
  let mask: number;
  let seg: number;
  let uval: number;

  if (pcmVal < 0) {
    pcmVal = -pcmVal;
    uval = SIGN_BIT;
  } else {
    uval = 0;
  }

  if (pcmVal > CLIP) pcmVal = CLIP;
  pcmVal += BIAS;

  seg = 0;
  for (mask = 0x4000; mask > 0x10; mask >>= 1) {
    if (pcmVal & mask) break;
    seg++;
  }

  uval |= (seg << 4) | ((pcmVal >> (seg + 3)) & QUANT_MASK);
  return ~(uval) & 0xff;
}

function encodeMuLawBuffer(pcm16: Int16Array): Buffer {
  const out = Buffer.alloc(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    out[i] = linear2ulaw(pcm16[i]);
  }
  return out;
}

// ── WAV Constructor & Downsampler ──────────────────────────────────────
function createWavBuffer(pcmSamples: Int16Array, sampleRate: number): Buffer {
  const buffer = Buffer.alloc(44 + pcmSamples.length * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + pcmSamples.length * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // Raw PCM
  buffer.writeUInt16LE(1, 22); // Mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); // Block align
  buffer.writeUInt16LE(16, 34); // 16-bit
  buffer.write("data", 36);
  buffer.writeUInt32LE(pcmSamples.length * 2, 40);
  for (let i = 0; i < pcmSamples.length; i++) {
    buffer.writeInt16LE(pcmSamples[i], 44 + i * 2);
  }
  return buffer;
}

const MULAW_SILENCE_BYTE = 0xff;
const TWILIO_CHUNK_BYTES = 160; // 20ms of 8kHz 8-bit mu-law
const TWILIO_CHUNK_MS = 20;

function parseWavPcm(wavBuffer: Buffer): { pcm: Int16Array; sampleRate: number } {
  if (wavBuffer.length < 44) throw new Error("Invalid WAV buffer");

  const sampleRate = wavBuffer.readUInt32LE(24);
  const bitsPerSample = wavBuffer.readUInt16LE(34);
  if (bitsPerSample !== 16) throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}`);

  let offset = 12;
  while (offset + 8 <= wavBuffer.length) {
    const chunkId = wavBuffer.toString("ascii", offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      const dataOffset = offset + 8;
      const pcmBytes = wavBuffer.subarray(dataOffset, dataOffset + chunkSize);
      const pcm = new Int16Array(Math.floor(pcmBytes.length / 2));
      for (let i = 0; i < pcm.length; i++) {
        pcm[i] = pcmBytes.readInt16LE(i * 2);
      }
      return { pcm, sampleRate };
    }
    offset += 8 + chunkSize;
  }

  throw new Error("WAV data chunk not found");
}

/** Low-pass filter + decimation for telephony-quality downsampling. */
function resamplePcmTo8k(pcm: Int16Array, inputRate: number): Int16Array {
  if (inputRate === 8000) return pcm;

  const ratio = inputRate / 8000;
  const outLen = Math.floor(pcm.length / ratio);
  const out = new Int16Array(outLen);
  const filterRadius = Math.max(2, Math.round(ratio));

  for (let i = 0; i < outLen; i++) {
    const center = i * ratio;
    let sum = 0;
    let weight = 0;

    for (let j = -filterRadius; j <= filterRadius; j++) {
      const idx = Math.round(center) + j;
      if (idx < 0 || idx >= pcm.length) continue;
      const w = 1 - Math.abs(j) / (filterRadius + 1);
      sum += pcm[idx] * w;
      weight += w;
    }

    out[i] = weight > 0
      ? Math.max(-32768, Math.min(32767, Math.round(sum / weight)))
      : 0;
  }

  return out;
}

/** Convert any audio blob to raw 8kHz mu-law using ffmpeg (required for clean Twilio playback). */
async function convertAudioToMulaw8k(audioBuffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const output: Buffer[] = [];
    const stderr: Buffer[] = [];

    const proc = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-af", "aresample=8000:resampler=soxr:precision=28,highpass=f=80",
      "-f", "mulaw",
      "-acodec", "pcm_mulaw",
      "-ar", "8000",
      "-ac", "1",
      "pipe:1",
    ]);

    proc.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg mulaw conversion failed (${code}): ${Buffer.concat(stderr).toString()}`));
        return;
      }
      const result = Buffer.concat(output);
      if (result.length === 0) {
        reject(new Error("ffmpeg mulaw conversion produced empty output"));
        return;
      }
      resolve(result);
    });

    proc.stdin.end(audioBuffer);
  });
}

async function convertToMulawWithFallback(audioBuffer: Buffer): Promise<Buffer> {
  try {
    return await convertAudioToMulaw8k(audioBuffer);
  } catch (err) {
    logger.warn({ err }, "ffmpeg mulaw conversion failed, using JS fallback");
    const { pcm, sampleRate } = parseWavPcm(audioBuffer);
    const pcm8 = resamplePcmTo8k(pcm, sampleRate);
    return encodeMuLawBuffer(pcm8);
  }
}

const TWILIO_PREBUFFER_CHUNKS = 2; // 40ms jitter buffer before playback starts

class AudioPlayer {
  private queue: Buffer[] = [];
  private ws: WebSocket;
  private streamSid: string;
  private playbackTimer: NodeJS.Timeout | null = null;
  private prebufferTimer: NodeJS.Timeout | null = null;
  private onComplete: (() => void) | null = null;
  /** Partial frame carried across enqueue() calls to avoid silence gaps between TTS sentences */
  private remainder: Buffer = Buffer.alloc(0);
  private playbackStartMs: number | null = null;
  private chunksSent = 0;

  private streamProvider: "twilio" | "exotel";

  constructor(ws: WebSocket, streamSid: string, streamProvider: "twilio" | "exotel" = "twilio") {
    this.ws = ws;
    this.streamSid = streamSid;
    this.streamProvider = streamProvider;
  }

  public enqueue(muLawAudio: Buffer) {
    const combined = this.remainder.length > 0
      ? Buffer.concat([this.remainder, muLawAudio])
      : muLawAudio;
    this.remainder = Buffer.alloc(0);

    let offset = 0;
    while (offset + TWILIO_CHUNK_BYTES <= combined.length) {
      this.queue.push(combined.subarray(offset, offset + TWILIO_CHUNK_BYTES));
      offset += TWILIO_CHUNK_BYTES;
    }
    if (offset < combined.length) {
      this.remainder = Buffer.from(combined.subarray(offset));
    }

    this.ensurePlayback();
  }

  public clear() {
    this.queue = [];
    this.remainder = Buffer.alloc(0);
    this.stopPlayback();
  }

  public setOnComplete(cb: () => void) {
    this.onComplete = cb;
  }

  /** Resolves when all queued audio has been sent and playback has stopped. */
  public waitUntilIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();

    return new Promise((resolve) => {
      const check = () => {
        if (this.isIdle()) {
          resolve();
        } else {
          this.setOnComplete(check);
        }
      };
      this.setOnComplete(check);
    });
  }

  private isIdle(): boolean {
    return (
      this.queue.length === 0 &&
      !this.playbackTimer &&
      !this.prebufferTimer &&
      this.remainder.length === 0
    );
  }

  private stopPlayback() {
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
    if (this.prebufferTimer) {
      clearTimeout(this.prebufferTimer);
      this.prebufferTimer = null;
    }
    this.playbackStartMs = null;
    this.chunksSent = 0;
  }

  private sendChunk(chunk: Buffer) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const payload = chunk.toString("base64");
    if (this.streamProvider === "exotel") {
      this.ws.send(JSON.stringify({
        event: "media",
        stream_sid: this.streamSid,
        media: { payload },
      }));
    } else {
      this.ws.send(JSON.stringify({
        event: "media",
        streamSid: this.streamSid,
        media: { payload },
      }));
    }
  }

  /** Flush trailing partial frame once, then signal completion */
  private finishPlayback() {
    if (this.remainder.length > 0) {
      const padded = Buffer.alloc(TWILIO_CHUNK_BYTES, MULAW_SILENCE_BYTE);
      this.remainder.copy(padded);
      this.remainder = Buffer.alloc(0);
      this.queue.push(padded);
      this.tick();
      return;
    }

    this.stopPlayback();
    const cb = this.onComplete;
    this.onComplete = null;
    cb?.();

    if (this.queue.length > 0) {
      this.ensurePlayback();
    }
  }

  /**
   * Send one 20ms frame, then schedule the next based on wall-clock elapsed time
   * so timer drift doesn't cause underruns (audible breaks/gaps).
   */
  private tick() {
    if (this.queue.length === 0) {
      this.finishPlayback();
      return;
    }

    if (this.playbackStartMs === null) {
      this.playbackStartMs = Date.now();
      this.chunksSent = 0;
    }

    const chunk = this.queue.shift()!;
    this.sendChunk(chunk);
    this.chunksSent++;

    const expectedElapsed = this.chunksSent * TWILIO_CHUNK_MS;
    const actualElapsed = Date.now() - this.playbackStartMs;
    const delay = Math.max(1, expectedElapsed - actualElapsed);

    this.playbackTimer = setTimeout(() => {
      this.playbackTimer = null;
      this.tick();
    }, delay);
  }

  private ensurePlayback() {
    if (this.playbackTimer) return;

    if (this.queue.length === 0) return;

    // Small prebuffer so Twilio's jitter buffer doesn't underrun on the first frames
    if (this.playbackStartMs === null && this.queue.length < TWILIO_PREBUFFER_CHUNKS) {
      if (!this.prebufferTimer) {
        this.prebufferTimer = setTimeout(() => {
          this.prebufferTimer = null;
          if (this.queue.length > 0 && !this.playbackTimer) {
            this.tick();
          }
        }, TWILIO_CHUNK_MS * TWILIO_PREBUFFER_CHUNKS);
      }
      return;
    }

    this.tick();
  }
}

// ── Helper Utilities ───────────────────────────────────────────────────
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage = "Operation timed out"): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

async function fetchWithTimeout(url: string, options: RequestInit & { timeout?: number }): Promise<Response> {
  const { timeout = 4000, ...fetchOptions } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    clearTimeout(id);
    return response;
  } catch (error: any) {
    clearTimeout(id);
    if (error.name === "AbortError") {
      throw new Error(`Request to ${url} timed out after ${timeout}ms`);
    }
    throw error;
  }
}

async function fetchConfig(callLogIdStr: string) {
  const callLogId = parseInt(callLogIdStr, 10);
  if (isNaN(callLogId)) return null;

  const callMeta = await getCallMeta(callLogIdStr);
  if (!callMeta) return null;

  const userId = callMeta.userId;
  const agentConfig = await getCachedAgentConfig(userId);
  const script = await resolveActiveScript(userId, callMeta.scriptId);

  return {
    userId,
    agentConfig,
    script,
    callMeta
  };
}

// ── Conversational Pipeline Helper Functions ───────────────────────────
async function generateSentenceTTS(text: string, lang: string, voice: string): Promise<Buffer> {
  const SARVAM_API_KEY = process.env.SARVAM_API_KEY ?? "";
  const useSarvamTts = isIndianLanguage(lang);

  if (useSarvamTts && SARVAM_API_KEY) {
    const speaker = BULBUL_VOICE_FOR_LANG[lang] ?? "manan";

    // Fire both Sarvam and OpenAI TTS in parallel — use whichever responds first.
    // Sarvam has better Indian language prosody, so prefer it if it finishes quickly.
    const sarvamPromise = (async (): Promise<{ source: "sarvam"; audio: Buffer }> => {
      const res = await fetchWithTimeout("https://api.sarvam.ai/text-to-speech", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-subscription-key": SARVAM_API_KEY,
        },
        body: JSON.stringify({
          inputs: [text],
          target_language_code: lang,
          speaker,
          model: "bulbul:v3",
          temperature: 0.4,
          pace: 1.0,
          speech_sample_rate: 8000,
          enable_preprocessing: true,
          output_audio_codec: "wav",
        }),
        timeout: 4000,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Sarvam Bulbul v3 TTS error ${res.status}: ${errText}`);
      }

      const data = await res.json() as any;
      const audioBase64: string | undefined = data.audios?.[0];
      if (!audioBase64) throw new Error("No audio returned from Sarvam");
      const wavBuffer = Buffer.from(audioBase64, "base64");
      const mulaw = await convertToMulawWithFallback(wavBuffer);
      return { source: "sarvam", audio: mulaw };
    })();

    const openaiPromise = (async (): Promise<{ source: "openai"; audio: Buffer }> => {
      const mp3Response = await openai.audio.speech.create({
        model: "tts-1",
        voice: (voice || "nova") as any,
        input: text,
      });
      const mp3Buffer = Buffer.from(await mp3Response.arrayBuffer());
      const mulaw = await convertToMulawWithFallback(mp3Buffer);
      return { source: "openai", audio: mulaw };
    })();

    try {
      // Race both — whichever finishes first wins
      const result = await Promise.any([sarvamPromise, openaiPromise]);
      logger.info({ bytes: result.audio.length, lang, source: result.source }, `${result.source === "sarvam" ? "Sarvam" : "OpenAI"} TTS mulaw audio ready (race winner)`);
      return result.audio;
    } catch (aggErr) {
      // Both failed — this is very unlikely but handle gracefully
      logger.error({ err: aggErr, lang }, "Both Sarvam and OpenAI TTS failed");
      throw aggErr;
    }
  } else {
    const mp3Response = await openai.audio.speech.create({
      model: "tts-1",
      voice: (voice || "nova") as any,
      input: text,
    });

    const mp3Buffer = Buffer.from(await mp3Response.arrayBuffer());
    const mulaw = await convertToMulawWithFallback(mp3Buffer);
    logger.info({ bytes: mulaw.length, lang }, "OpenAI TTS mulaw audio ready");
    return mulaw;
  }
}

async function* streamLLMResponse(
  systemPrompt: string,
  history: { role: string; content: string }[],
  userMessage: string,
  aiModel: string,
  lang: string
): AsyncGenerator<string, void, unknown> {
  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage }
  ];

  const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? "";
  const SARVAM_API_KEY = process.env.SARVAM_API_KEY ?? "";

  let client: OpenAI;
  let modelName = aiModel;

  if (aiModel === "deepseek-chat" || aiModel === "deepseek-v3") {
    client = new OpenAI({
      apiKey: DEEPSEEK_API_KEY,
      baseURL: "https://api.deepseek.com/v1"
    });
    modelName = "deepseek-chat";
  } else if (aiModel === "sarvam-m" || aiModel === "sarvam-1-2b") {
    client = new OpenAI({
      apiKey: SARVAM_API_KEY,
      baseURL: "https://api.sarvam.ai/v1"
    });
    modelName = "sarvam-m";
  } else {
    client = openai;
    const OPENAI_MODEL_MAP: Record<string, string> = {
      "gpt-4o-mini":          "gpt-4o-mini",
      "gpt-4o":               "gpt-4o",
      "gpt-5.2":              "gpt-4o",
      "gemini-1.5-pro":       "gpt-4o-mini",
      "llama-3.3-8b-private": "gpt-4o-mini",
      "bharatgpt":            "gpt-4o-mini",
      "bolna-ai":             "gpt-4o-mini",
    };
    modelName = OPENAI_MODEL_MAP[aiModel] ?? "gpt-4o-mini";
  }

  const stream = await client.chat.completions.create({
    model: modelName,
    messages: messages as any[],
    max_completion_tokens: 150,
    stream: true
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content || "";
    if (text) {
      yield text;
    }
  }
}

// ── WebSocket Server Definition & Event Loop ───────────────────────────
export const twilioWss = new WebSocketServer({ noServer: true });

export async function handleExotelStreamUpgrade(request: any, socket: any, head: any) {
  const url = new URL(request.url || "", `http://${request.headers.host}`);
  let callLogId = url.searchParams.get("callLogId");
  if (!callLogId) {
    const pathParts = url.pathname.split("/").filter(Boolean);
    callLogId = pathParts[3] || null;
  }
  if (!callLogId) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  twilioWss.handleUpgrade(request, socket, head, (ws) => {
    twilioWss.emit("connection", ws, request, callLogId, "exotel");
  });
}

export async function handleTwilioStreamUpgrade(request: any, socket: any, head: any) {
  const url = new URL(request.url || "", `http://${request.headers.host}`);
  let callLogId = url.searchParams.get("callLogId");
  if (!callLogId) {
    const pathParts = url.pathname.split("/").filter(Boolean);
    callLogId = pathParts[4] || null;
  }
  if (!callLogId) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  twilioWss.handleUpgrade(request, socket, head, (ws) => {
    twilioWss.emit("connection", ws, request, callLogId, "twilio");
  });
}

twilioWss.on("connection", async (ws: WebSocket, request: any, callLogId: string, streamProvider: "twilio" | "exotel" = "twilio") => {
  logger.info({ callLogId, streamProvider }, "Media Stream WebSocket client connected");
  const connectionTime = Date.now();

  const config = await fetchConfig(callLogId);
  if (!config) {
    logger.error({ callLogId }, "Failed to load call configuration for media stream");
    ws.close();
    return;
  }

  const callLogRow = await db.query.callLogsTable.findFirst({
    where: eq(callLogsTable.id, parseInt(callLogId, 10)),
  });
  const callStartedAt = callLogRow?.startedAt ? new Date(callLogRow.startedAt) : new Date();

  const { userId, agentConfig, script, callMeta } = config;
  const configuredLang = agentConfig?.language || "en-US";
  const languageMenuConfig = getActiveLanguageMenu(agentConfig || {});
  const aiModel = agentConfig?.aiModel || "gpt-4o-mini";
  const voice = agentConfig?.voice || "nova";

  let lockedCallLang: string | null = null;
  let languageMenuPhase = false;
  let languageMenuTimer: ReturnType<typeof setTimeout> | null = null;

  const getCallLang = (detected?: string) =>
    resolveCallLanguage(configuredLang, lockedCallLang, detected);

  let streamSid = "";
  let callSid = "";
  let inboundEncoding: "mulaw" | "pcm" = "mulaw";
  let player: AudioPlayer | null = null;

  // VAD state variables
  let vadState: "silent" | "speaking" = "silent";
  const SPEECH_THRESHOLD = 1800;
  const SILENCE_THRESHOLD = 900;
  const MIN_SPEECH_DURATION_CHUNKS = 8; // Ignore speech shorter than 160ms
  const SILENCE_DURATION_CHUNKS = 25; // 1.0 second silence (25 chunks * 40ms)

  let accumulatedPcm: number[] = [];
  let silenceChunksCount = 0;
  let speechChunksCount = 0;

  // State flags
  let isSpeaking = false;
  let isGenerating = false;
  let isProcessingTurn = false;
  let greetingCancelled = false;
  let greetingPhase = true;
  let deferredUtterance: Int16Array | null = null;
  let activeGenerationId = "";

  // History and transfer rule state
  const history: { role: string; content: string }[] = [...(callMeta.liveTranscript || [])];
  const intentTurnCounts: Record<string, number> = {};
  let humanReqCount = 0;

  const transferRules = callMeta.crmMetadata?.__transferRules as TransferRules | undefined;
  const hasTransferRules = !!transferRules;
  const crmCallFlow = callMeta.externalCrmCallFlow;

  let limitTriggered = false;
  let limitTimer: ReturnType<typeof setTimeout> | null = null;
  let crmLimitTimer: ReturnType<typeof setTimeout> | null = null;

  const defaultGreeting = script?.openingLine || agentConfig?.greeting || "Hi, thank you for calling. How can I help you today?";

  /** End inbound CRM call: optional ending pitch, ending note, brief pause, then hang up */
  const endCrmInboundCall = async (reason: string) => {
    if (limitTriggered) return;
    limitTriggered = true;
    if (limitTimer) {
      clearTimeout(limitTimer);
      limitTimer = null;
    }
    if (crmLimitTimer) {
      clearTimeout(crmLimitTimer);
      crmLimitTimer = null;
    }

    const callLogIdNum = parseInt(callLogId, 10);
    const lang = getCallLang();
    const leadSeconds = crmCallFlow?.endingNoteLeadSeconds ?? 2;

    logger.info({ callLogId, reason }, "CRM call flow limit reached — ending call");
    player?.clear();
    if (streamSid) {
      ws.send(JSON.stringify({ event: "clear", streamSid }));
    }

    const playTtsMessage = async (message: string) => {
      if (!message?.trim()) return;
      try {
        const audio = await generateSentenceTTS(message, lang, voice);
        isSpeaking = true;
        // Timeout the player callback — if audio doesn't finish in 8s, proceed anyway
        await new Promise<void>((resolve) => {
          const safetyTimeout = setTimeout(() => {
            isSpeaking = false;
            logger.warn({ callLogId }, "playTtsMessage timed out after 8s — proceeding to hangup");
            resolve();
          }, 8000);
          player?.setOnComplete(() => {
            clearTimeout(safetyTimeout);
            isSpeaking = false;
            resolve();
          });
          player?.enqueue(audio);
        });

        const turn = { role: "assistant", content: message, timestamp: new Date().toISOString() };
        callMeta.liveTranscript = [...callMeta.liveTranscript, turn];
      } catch (ttsErr) {
        logger.error({ ttsErr, callLogId }, "CRM ending TTS failed");
      }
    };

    try {
      const endingPitch = crmCallFlow?.endingPitch?.trim();
      if (endingPitch) {
        await playTtsMessage(applyPitchTemplate(endingPitch, callMeta.externalCrmContext));
      }

      const endingNote = crmCallFlow?.endingNote?.trim();
      if (endingNote) {
        await playTtsMessage(applyPitchTemplate(endingNote, callMeta.externalCrmContext));
      } else if (!endingPitch) {
        await playTtsMessage("Thank you for calling. Goodbye.");
      }

      if (leadSeconds > 0) {
        await new Promise(resolve => setTimeout(resolve, leadSeconds * 1000));
      }

      const updatedTranscript = callMeta.liveTranscript;
      await db.update(callLogsTable)
        .set({
          liveTranscript: updatedTranscript,
          transcript: updatedTranscript.map(t => `${t.role === "user" ? "Caller" : "Agent"}: ${t.content}`).join("\n\n"),
          transferReason: reason,
          endedAt: new Date(),
          outcome: "answered",
        })
        .where(eq(callLogsTable.id, callLogIdNum));
    } catch (err) {
      logger.error({ err, callLogId }, "CRM call ending sequence failed");
    } finally {
      // Always hang up — even if TTS/DB failed
      if (callSid) {
        await hangupCall(userId, callSid, callLogRow?.phone || undefined).catch(
          (err) => logger.error({ err, callLogId }, "Hangup failed in endCrmInboundCall"),
        );
      }
      isGenerating = false;
      ws.close();
    }
  };

  /** Hang up after the caller and AI have naturally concluded the conversation */
  const finishCallNaturally = async (reason: string) => {
    if (limitTriggered) return;
    limitTriggered = true;
    if (limitTimer) {
      clearTimeout(limitTimer);
      limitTimer = null;
    }
    if (crmLimitTimer) {
      clearTimeout(crmLimitTimer);
      crmLimitTimer = null;
    }

    const callLogIdNum = parseInt(callLogId, 10);
    const lang = getCallLang();
    const leadSeconds = crmCallFlow?.endingNoteLeadSeconds ?? 2;

    logger.info({ callLogId, reason }, "Ending call after natural conversation close");

    try {
      const endingNote = crmCallFlow?.endingNote?.trim();
      if (endingNote) {
        const noteText = applyPitchTemplate(endingNote, callMeta.externalCrmContext);
        const noteAudio = await generateSentenceTTS(noteText, lang, voice);
        isSpeaking = true;
        await new Promise<void>((resolve) => {
          const safetyTimeout = setTimeout(() => {
            isSpeaking = false;
            logger.warn({ callLogId }, "finishCallNaturally TTS timed out after 8s — proceeding to hangup");
            resolve();
          }, 8000);
          player?.setOnComplete(() => {
            clearTimeout(safetyTimeout);
            isSpeaking = false;
            resolve();
          });
          player?.enqueue(noteAudio);
        });
        callMeta.liveTranscript = [
          ...callMeta.liveTranscript,
          { role: "assistant", content: noteText, timestamp: new Date().toISOString() },
        ];
      }

      {
        const pauseSec = endingNote ? leadSeconds : 1;
        if (pauseSec > 0) {
          await new Promise(resolve => setTimeout(resolve, pauseSec * 1000));
        }
      }

      const updatedTranscript = callMeta.liveTranscript;
      await db.update(callLogsTable)
        .set({
          liveTranscript: updatedTranscript,
          transcript: updatedTranscript.map(t => `${t.role === "user" ? "Caller" : "Agent"}: ${t.content}`).join("\n\n"),
          endedAt: new Date(),
          outcome: "answered",
        })
        .where(eq(callLogsTable.id, callLogIdNum));
    } catch (err) {
      logger.error({ err, callLogId }, "Natural call end sequence failed");
    } finally {
      crmEventBus.emitCallEvent({
        type: "call.ended",
        callId: callLogIdNum,
        callSid: callSid || undefined,
        userId,
        data: {
          outcome: "answered",
          reason,
          limitType: "natural_close",
          liveTranscript: callMeta.liveTranscript,
        },
        metadata: callMeta.crmMetadata as Record<string, unknown> | undefined,
        timestamp: new Date().toISOString(),
      });

      if (callSid) {
        await hangupCall(userId, callSid, callLogRow?.phone || undefined).catch(
          (err) => logger.error({ err, callLogId }, "Hangup failed in finishCallNaturally"),
        );
      }

      isGenerating = false;
      ws.close();
    }
  };

  /** Play closing message and hang up — no further LLM billing */
  const endCampaignCallWithMessage = async (reason: string) => {
    if (limitTriggered) return;
    limitTriggered = true;
    if (limitTimer) {
      clearTimeout(limitTimer);
      limitTimer = null;
    }

    const closingMessage = transferRules?.transferMessage || DEFAULT_CAMPAIGN_CLOSING_MESSAGE;
    const callLogIdNum = parseInt(callLogId, 10);
    const lang = getCallLang();

    logger.info({ callLogId, reason }, "Campaign call limit reached — ending with closing message");
    player?.clear();
    if (streamSid) {
      ws.send(JSON.stringify({ event: "clear", streamSid }));
    }

    try {
      const closingAudio = await generateSentenceTTS(closingMessage, lang, voice);
      isSpeaking = true;
      await new Promise<void>((resolve) => {
        const safetyTimeout = setTimeout(() => {
          isSpeaking = false;
          logger.warn({ callLogId }, "endCampaignCallWithMessage TTS timed out after 8s — proceeding to hangup");
          resolve();
        }, 8000);
        player?.setOnComplete(() => {
          clearTimeout(safetyTimeout);
          isSpeaking = false;
          resolve();
        });
        player?.enqueue(closingAudio);
      });

      const closingTurn = { role: "assistant", content: closingMessage, timestamp: new Date().toISOString() };
      const updatedTranscript = [...callMeta.liveTranscript, closingTurn];
      callMeta.liveTranscript = updatedTranscript;

      await db.update(callLogsTable)
        .set({
          liveTranscript: updatedTranscript,
          transcript: updatedTranscript.map(t => `${t.role === "user" ? "Caller" : "Agent"}: ${t.content}`).join("\n\n"),
          transferReason: reason,
          transferredAt: new Date(),
          endedAt: new Date(),
          outcome: "answered",
        })
        .where(eq(callLogsTable.id, callLogIdNum));
    } catch (ttsErr) {
      logger.error({ ttsErr, callLogId }, "Closing message TTS failed");
    } finally {
      crmEventBus.emitCallEvent({
        type: "call.ended",
        callId: callLogIdNum,
        callSid: callSid || undefined,
        userId,
        data: {
          outcome: "answered",
          reason,
          limitType: "campaign",
          liveTranscript: callMeta.liveTranscript,
        },
        metadata: callMeta.crmMetadata as Record<string, unknown> | undefined,
        timestamp: new Date().toISOString(),
      });

      if (callSid) {
        await hangupCall(userId, callSid, callLogRow?.phone || undefined).catch(
          (err) => logger.error({ err, callLogId }, "Hangup failed in endCampaignCallWithMessage"),
        );
      }

      isGenerating = false;
      ws.close();
    }
  };

  // Initial greeting (may be replaced after DTMF language menu)
  let currentGreeting = resolveCrmOpeningGreeting(
    crmCallFlow ?? null,
    callMeta.externalCrmContext,
    defaultGreeting,
  );

  const clearLanguageMenuTimer = () => {
    if (languageMenuTimer) {
      clearTimeout(languageMenuTimer);
      languageMenuTimer = null;
    }
  };

  const playGreeting = async () => {
    try {
      isGenerating = true;
      greetingCancelled = false;

      const greetingLang = lockedCallLang && lockedCallLang !== "auto"
        ? lockedCallLang
        : configuredLang;

      logger.info({ callLogId, greeting: currentGreeting, greetingLang }, "Generating greeting TTS...");
      const audio = await generateSentenceTTS(currentGreeting, greetingLang, voice);

      if (!greetingCancelled) {
        isGenerating = false;
        isSpeaking = true;
        player?.setOnComplete(() => {
          isSpeaking = false;
          greetingPhase = false;
          if (deferredUtterance) {
            const pending = deferredUtterance;
            deferredUtterance = null;
            processUserUtterance(pending);
          }
        });
        player?.enqueue(audio);
        logger.info({ callLogId, bytes: audio.length }, "Greeting audio enqueued");

        history.push({ role: "assistant", content: currentGreeting });

        const updatedTranscript = [
          ...callMeta.liveTranscript,
          { role: "assistant", content: currentGreeting, timestamp: new Date().toISOString() }
        ];
        callMeta.liveTranscript = updatedTranscript;

        const formattedTranscript = updatedTranscript
          .map((turn: any) => `${turn.role === "user" ? "Caller" : "Agent"}: ${turn.content}`)
          .join("\n\n");

        await db.update(callLogsTable)
          .set({
            liveTranscript: updatedTranscript,
            transcript: formattedTranscript
          })
          .where(eq(callLogsTable.id, parseInt(callLogId, 10)));
      } else {
        isGenerating = false;
        greetingPhase = false;
        if (deferredUtterance) {
          const pending = deferredUtterance;
          deferredUtterance = null;
          processUserUtterance(pending);
        }
      }
    } catch (err) {
      logger.error({ err }, "Error playing greeting");
      isGenerating = false;
      isSpeaking = false;
      greetingPhase = false;
      if (deferredUtterance) {
        const pending = deferredUtterance;
        deferredUtterance = null;
        processUserUtterance(pending);
      }
    }
  };

  const finalizeLanguageSelection = async (selectedLang: string, source: string) => {
    if (!languageMenuPhase || !languageMenuConfig) return;
    clearLanguageMenuTimer();
    languageMenuPhase = false;
    lockedCallLang = selectedLang;

    const effectiveLang = selectedLang === "auto" ? "en-US" : selectedLang;
    const langFallback = greetingForLanguage(
      effectiveLang,
      script?.openingLine,
      agentConfig?.greeting,
    );
    currentGreeting = resolveCrmOpeningGreeting(
      crmCallFlow ?? null,
      callMeta.externalCrmContext,
      langFallback,
    );

    logger.info({ callLogId, selectedLang, source }, "Call language locked from menu");

    player?.clear();
    if (streamSid) {
      ws.send(JSON.stringify({ event: "clear", streamSid }));
    }
    isSpeaking = false;
    isGenerating = false;
    greetingPhase = true;

    await playGreeting();
  };

  const handleLanguageMenuDigit = (digit: string) => {
    if (!languageMenuConfig) return;
    const selected = resolveLanguageFromDigit(languageMenuConfig, digit);
    if (selected) {
      finalizeLanguageSelection(selected, `dtmf:${digit}`).catch(err =>
        logger.error({ err, callLogId, digit }, "Language menu DTMF handling failed"),
      );
    }
  };

  const playLanguageMenu = async () => {
    if (!languageMenuConfig) {
      await playGreeting();
      return;
    }

    try {
      languageMenuPhase = true;
      greetingPhase = true;
      isGenerating = true;
      greetingCancelled = false;

      const prompt = buildLanguageMenuPrompt(languageMenuConfig);
      logger.info({ callLogId, prompt }, "Playing language menu prompt");
      const audio = await generateSentenceTTS(prompt, "en-US", voice);

      if (!greetingCancelled && languageMenuPhase) {
        isGenerating = false;
        isSpeaking = true;
        player?.setOnComplete(() => {
          isSpeaking = false;
          // Start the DTMF timeout AFTER the prompt finishes playing,
          // so the caller has the full configured time to press a digit.
          if (languageMenuPhase) {
            languageMenuTimer = setTimeout(() => {
              const defaultLang = languageMenuConfig.defaultLanguage || "en-US";
              finalizeLanguageSelection(defaultLang, "timeout").catch(err =>
                logger.error({ err, callLogId }, "Language menu timeout handling failed"),
              );
            }, (languageMenuConfig.timeoutSeconds || 12) * 1000);
          }
        });
        player?.enqueue(audio);
      }
    } catch (err) {
      logger.error({ err, callLogId }, "Error playing language menu — falling back to greeting");
      languageMenuPhase = false;
      clearLanguageMenuTimer();
      await playGreeting();
    }
  };

  ws.on("message", async (msg: any) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "start") {
        streamSid = data.start?.streamSid || data.start?.stream_sid || "";
        callSid = data.start?.callSid || data.start?.call_sid || "";
        const fmt = String(data.start?.media_format?.encoding || "").toLowerCase();
        if (fmt.includes("mulaw") || fmt.includes("pcmu")) {
          inboundEncoding = "mulaw";
        } else if (fmt.includes("raw") || fmt.includes("pcm") || fmt.includes("linear")) {
          inboundEncoding = "pcm";
        } else if (streamProvider === "exotel") {
          inboundEncoding = "pcm";
        }
        player = new AudioPlayer(ws, streamSid, streamProvider);
        logger.info({ streamSid, callSid, streamProvider, inboundEncoding }, "Media stream started");

        if (streamProvider === "exotel") {
          registerExotelStream(callLogId, ws);
        }

        if (!callMeta.callSid) {
          callMeta.callSid = callSid;
          await db.update(callLogsTable).set({ callSid }).where(eq(callLogsTable.id, parseInt(callLogId, 10)));
        }

        if (transferRules?.campaignHandoff && transferRules.maxAiMinutes && transferRules.maxAiMinutes > 0) {
          const elapsed = Date.now() - callStartedAt.getTime();
          const remainingMs = Math.max(0, transferRules.maxAiMinutes * 60_000 - elapsed);
          limitTimer = setTimeout(() => {
            endCampaignCallWithMessage(
              `Campaign call duration limit reached (${transferRules.maxAiMinutes} min)`,
            ).catch(err => logger.error({ err, callLogId }, "Duration limit hangup failed"));
          }, remainingMs);
          logger.info({ callLogId, remainingMs }, "Campaign duration limit timer started");
        }

        if (crmCallFlow?.maxAiInteractionSeconds && crmCallFlow.maxAiInteractionSeconds > 0) {
          const elapsed = Date.now() - callStartedAt.getTime();
          const limitMs = crmCallFlow.maxAiInteractionSeconds * 1000;
          const remainingMs = Math.max(0, limitMs - elapsed);
          crmLimitTimer = setTimeout(() => {
            endCrmInboundCall(
              `CRM AI interaction limit reached (${crmCallFlow.maxAiInteractionSeconds}s)`,
            ).catch(err => logger.error({ err, callLogId }, "CRM duration limit hangup failed"));
          }, remainingMs);
          logger.info({ callLogId, remainingMs, limitSec: crmCallFlow.maxAiInteractionSeconds }, "CRM AI interaction limit timer started");
        }

        playLanguageMenu();
      }

      if (data.event === "dtmf") {
        // Twilio sends: { event: "dtmf", dtmf: { digit: "1" } }
        // Exotel sends: { event: "dtmf", dtmf: { digits: ["1"] } } or { digit: "1" }
        const digit = data.dtmf?.digit ?? data.dtmf?.digits?.[0] ?? data.digit;
        logger.info({ callLogId, digit, languageMenuPhase, rawDtmf: data.dtmf ?? data.digit }, "DTMF event received");
        if (digit && languageMenuPhase) {
          greetingCancelled = true;
          player?.clear();
          if (streamSid) {
            ws.send(JSON.stringify({ event: "clear", streamSid }));
          }
          isSpeaking = false;
          isGenerating = false;
          handleLanguageMenuDigit(String(digit));
        }
      }

      if (data.event === "media") {
        if (!player) return;
        if (languageMenuPhase) return;

        const payload = data.media.payload;
        const rawBuffer = Buffer.from(payload, "base64");
        const pcmChunk = inboundEncoding === "pcm"
          ? new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, Math.floor(rawBuffer.length / 2))
          : decodeMuLawBuffer(rawBuffer);

        let sum = 0;
        for (let i = 0; i < pcmChunk.length; i++) {
          sum += pcmChunk[i] * pcmChunk[i];
        }
        const rms = Math.sqrt(sum / pcmChunk.length);

        // While bot is speaking, ignore echo unless caller barges in (lower threshold during greeting).
        if (isSpeaking) {
          const interruptThreshold = greetingPhase ? 2800 : 7500;
          if (rms > interruptThreshold) {
            speechChunksCount++;
            const chunksNeeded = greetingPhase ? 3 : 4;
            if (speechChunksCount >= chunksNeeded) {
              logger.info({ rms, callLogId }, "VAD: Interruption detected! Clearing bot player.");
              greetingCancelled = true;
              greetingPhase = false;
              player.clear();
              ws.send(JSON.stringify({ event: "clear", streamSid }));
              isSpeaking = false;
              isGenerating = false;
              activeGenerationId = "";
              vadState = "speaking";
              accumulatedPcm = [];
              silenceChunksCount = 0;
              speechChunksCount = 0;
            }
          } else {
            speechChunksCount = 0;
          }
          return;
        }

        if (vadState === "silent") {
          const isGracePeriod = (Date.now() - connectionTime) < 2000;
          if (rms > SPEECH_THRESHOLD && !isGracePeriod) {
            speechChunksCount++;
            if (speechChunksCount >= 2) {
              vadState = "speaking";
              logger.info({ rms, callLogId }, "VAD: Speech onset detected");
              accumulatedPcm = [];
              silenceChunksCount = 0;
            }
          } else {
            speechChunksCount = 0;
          }
        } else {
          // speaking
          for (let i = 0; i < pcmChunk.length; i++) {
            accumulatedPcm.push(pcmChunk[i]);
          }

          if (rms < SILENCE_THRESHOLD) {
            silenceChunksCount++;
            if (silenceChunksCount >= SILENCE_DURATION_CHUNKS) {
              logger.info({ callLogId }, "VAD: Silence detected. Triggering transcription.");
              vadState = "silent";
              speechChunksCount = 0;

              const audioDataLength = accumulatedPcm.length;
              if (audioDataLength >= MIN_SPEECH_DURATION_CHUNKS * 160) {
                const pcmSamples = new Int16Array(accumulatedPcm);
                accumulatedPcm = [];
                processUserUtterance(pcmSamples);
              } else {
                logger.info({ callLogId, audioDataLength }, "VAD: Utterance too short, ignoring.");
                accumulatedPcm = [];
              }
            }
          } else {
            silenceChunksCount = 0;
          }
        }
      }

      if (data.event === "stop") {
        logger.info({ callLogId }, "Twilio Media Stream stopped");
        if (limitTimer) clearTimeout(limitTimer);
        clearLanguageMenuTimer();
        player?.clear();
        finalizeCallLog(parseInt(callLogId, 10), callStartedAt).catch(err =>
          logger.error({ err, callLogId }, "Failed to finalize call log on stream stop")
        );
      }
    } catch (err) {
      logger.error({ err }, "Error processing Twilio WS message");
    }
  });

  ws.on("close", () => {
    logger.info({ callLogId }, "Twilio Media Stream WebSocket closed");
    if (limitTimer) clearTimeout(limitTimer);
    clearLanguageMenuTimer();
    if (streamProvider === "exotel") unregisterExotelStream(callLogId);
    player?.clear();
    finalizeCallLog(parseInt(callLogId, 10), callStartedAt).catch(err =>
      logger.error({ err, callLogId }, "Failed to finalize call log on websocket close")
    );
  });

  ws.on("error", (err) => {
    logger.error({ err, callLogId }, "Twilio Media Stream WebSocket error");
    player?.clear();
  });

  // Main turn pipeline
  const processUserUtterance = async (pcmSamples: Int16Array) => {
    if (isProcessingTurn) {
      logger.info({ callLogId }, "Deferring utterance, turn already in progress");
      deferredUtterance = pcmSamples;
      return;
    }

    if (limitTriggered) {
      isProcessingTurn = false;
      return;
    }

    isProcessingTurn = true;
    const genId = randomUUID();
    activeGenerationId = genId;
    isGenerating = true;

    if (languageMenuPhase) {
      isProcessingTurn = false;
      isGenerating = false;
      return;
    }

    if (greetingPhase && !greetingCancelled) {
      deferredUtterance = pcmSamples;
      logger.info({ callLogId }, "Deferring utterance until greeting completes");
      isProcessingTurn = false;
      isGenerating = false;
      return;
    }

    try {
      const wavBuffer = createWavBuffer(pcmSamples, 8000);
      let sttLang = getCallLang();
      if (sttLang === "auto") sttLang = "en-US";
      let lang = sttLang;
      logger.info({ callLogId, sttLang, lockedCallLang }, "Transcribing audio...");
      let transcript = "";

      const useSarvamStt = isIndianLanguage(sttLang);
      if (useSarvamStt) {
        transcript = await callSarvamSTT(wavBuffer, "audio/wav", sttLang);
      } else {
        const file = await toFile(wavBuffer, "audio.wav", { type: "audio/wav" });
        const res = await openai.audio.transcriptions.create({
          file,
          model: "whisper-1",
          language: sttLang === "auto" ? undefined : sttLang.split("-")[0],
          prompt: buildWhisperPrompt(history, currentGreeting),
        });
        transcript = res.text;
      }

      const rawTranscript = transcript;
      transcript = normalizePhoneTranscript(transcript, history, currentGreeting);
      if (transcript !== rawTranscript) {
        logger.info({ callLogId, rawTranscript, transcript }, "STT transcript corrected");
      }

      logger.info({ callLogId, transcript }, "Transcription complete");

      if (activeGenerationId !== genId) {
        logger.info({ callLogId }, "Generation aborted due to interruption during transcription.");
        return;
      }

      if (!transcript.trim()) {
        isGenerating = false;
        return;
      }

      if (shouldAutoDetectLanguage(configuredLang, lockedCallLang)) {
        lang = detectCallLanguage(transcript);
        logger.info({ callLogId, lang }, "Language auto-detected");
      }

      if (detectHumanRequest(transcript)) {
        humanReqCount++;
        logger.info({ callLogId, humanReqCount }, "Human request count updated");
      }

      let intentResult = { intent: "general_question", confidence: 1.0, needsHuman: false };
      try {
        intentResult = await classifyIntent(history, transcript, hasTransferRules);
        if (intentResult.confidence >= 0.6) {
          intentTurnCounts[intentResult.intent] = (intentTurnCounts[intentResult.intent] || 0) + 1;
        }
      } catch (classifyErr) {
        logger.error({ classifyErr, callLogId }, "Intent classification failed");
      }

      // Emit user turn to CRM
      crmEventBus.emitCallEvent({
        type: "call.turn",
        callId: parseInt(callLogId, 10),
        callSid,
        data: { role: "user", content: transcript, turnIndex: history.length, language: lang },
        metadata: callMeta.crmMetadata,
        timestamp: new Date().toISOString()
      });

      history.push({ role: "user", content: transcript });

      // Check auto transfer rules (campaign CRM handoff or CRM API rules)
      if (transferRules) {
        const isCampaignHandoff = !!transferRules.campaignHandoff;
        const qaTurnCount = countUserTurns(history);

        let mergedRules: TransferRules = transferRules;
        if (!isCampaignHandoff) {
          const intentTraining = intentResult.intent !== "general_question"
            ? await db.query.intentTrainingTable.findFirst({
                where: and(
                  eq(intentTrainingTable.userId, userId),
                  eq(intentTrainingTable.intent, intentResult.intent)
                )
              }).catch(() => null)
            : null;

          mergedRules = {
            ...transferRules,
            perIntentMaxTurns: {
              ...(transferRules.perIntentMaxTurns || {}),
              ...(intentTraining ? { [intentResult.intent]: intentTraining.maxTurns } : {})
            }
          };
        }

        const decision = shouldTransfer(
          intentResult,
          mergedRules,
          isCampaignHandoff ? qaTurnCount : Math.floor((history.length + 1) / 2),
          intentTurnCounts,
          humanReqCount,
          callStartedAt,
        );

        if (decision.transfer) {
          // End call with closing message (default campaign mode — saves AI billing)
          if (isCampaignHandoff && transferRules.endCallOnly) {
            await endCampaignCallWithMessage(decision.reason);
            isProcessingTurn = false;
            isGenerating = false;
            return;
          }

          let agentId = transferRules.crmAgentId;
          let targetPhone = transferRules.transferTo;

          if (!isCampaignHandoff) {
            const intentTraining = intentResult.intent !== "general_question"
              ? await db.query.intentTrainingTable.findFirst({
                  where: and(
                    eq(intentTrainingTable.userId, userId),
                    eq(intentTrainingTable.intent, intentResult.intent)
                  )
                }).catch(() => null)
              : null;
            targetPhone = intentTraining?.transferTo || transferRules.transferTo;
            agentId = intentTraining?.crmAgentId || transferRules.crmAgentId;

            if (!targetPhone) {
              const bestAgent = await findBestAgent(userId, intentResult.intent);
              if (bestAgent) {
                targetPhone = bestAgent.phone;
                agentId = bestAgent.agentId;
              }
            }
          } else if (agentId) {
            const resolved = await resolveAgentPhone(userId, agentId);
            targetPhone = resolved.phone || targetPhone;
          }

          const transferMessage = transferRules.transferMessage || DEFAULT_CAMPAIGN_CLOSING_MESSAGE;
          const callLogIdNum = parseInt(callLogId, 10);
          const latestCallLog = callLogRow ?? await db.query.callLogsTable.findFirst({
            where: eq(callLogsTable.id, callLogIdNum),
          });

          const buildHandoffData = async (extra: Record<string, unknown>) =>
            latestCallLog
              ? buildTransferEventData(latestCallLog, userId, { ...extra, crmAgentId: agentId })
              : { ...extra, crmAgentId: agentId };

          // CRM dashboard handoff (no agent phone) — play message, webhook, end call (no LLM cost)
          if (isCampaignHandoff && agentId && !targetPhone) {
            logger.info({ callLogId, agentId }, "Campaign CRM dashboard handoff (no phone bridge)");
            player?.clear();
            ws.send(JSON.stringify({ event: "clear", streamSid }));

            crmEventBus.emitCallEvent({
              type: "call.transferring",
              callId: callLogIdNum,
              callSid,
              userId,
              data: await buildHandoffData({
                transferTo: `crm:${agentId}`,
                reason: decision.reason,
                handoffMode: "crm_dashboard",
              }),
              metadata: callMeta.crmMetadata as Record<string, unknown> | undefined,
              timestamp: new Date().toISOString(),
            });

            try {
              const handoffAudio = await generateSentenceTTS(transferMessage, lang, voice);
              isSpeaking = true;
              await new Promise<void>((resolve) => {
                const safetyTimeout = setTimeout(() => {
                  isSpeaking = false;
                  logger.warn({ callLogId }, "Handoff TTS timed out after 8s — proceeding to hangup");
                  resolve();
                }, 8000);
                player?.setOnComplete(() => {
                  clearTimeout(safetyTimeout);
                  isSpeaking = false;
                  resolve();
                });
                player?.enqueue(handoffAudio);
              });

              const handoffTurn = { role: "assistant", content: transferMessage, timestamp: new Date().toISOString() };
              const updatedTranscript = [...callMeta.liveTranscript, handoffTurn];
              callMeta.liveTranscript = updatedTranscript;
              await db.update(callLogsTable)
                .set({
                  liveTranscript: updatedTranscript,
                  transcript: updatedTranscript.map(t => `${t.role === "user" ? "Caller" : "Agent"}: ${t.content}`).join("\n\n"),
                  transferredTo: `crm:${agentId}`,
                  transferReason: decision.reason,
                  transferredAt: new Date(),
                })
                .where(eq(callLogsTable.id, callLogIdNum));
            } catch (ttsErr) {
              logger.error({ ttsErr, callLogId }, "Handoff TTS failed");
            } finally {
              crmEventBus.emitCallEvent({
                type: "call.transferred",
                callId: callLogIdNum,
                callSid,
                userId,
                data: await buildHandoffData({
                  transferTo: `crm:${agentId}`,
                  reason: decision.reason,
                  handoffMode: "crm_dashboard",
                }),
                metadata: callMeta.crmMetadata as Record<string, unknown> | undefined,
                timestamp: new Date().toISOString(),
              });

              if (callSid) {
                await hangupCall(userId, callSid, callLogRow?.phone || undefined).catch(
                  (err) => logger.error({ err, callLogId }, "Hangup failed in CRM dashboard handoff"),
                );
              }

              isGenerating = false;
              ws.close();
            }
            return;
          }

          // Phone bridge transfer (campaign or intent-based)
          if (targetPhone && callSid) {
            logger.info({ callLogId, targetPhone, agentId }, "Executing call transfer...");
            player?.clear();
            ws.send(JSON.stringify({ event: "clear", streamSid }));

            crmEventBus.emitCallEvent({
              type: "call.transferring",
              callId: callLogIdNum,
              callSid,
              userId,
              data: await buildHandoffData({
                transferTo: targetPhone,
                reason: decision.reason,
                intent: isCampaignHandoff ? undefined : intentResult.intent,
              }),
              metadata: callMeta.crmMetadata as Record<string, unknown> | undefined,
              timestamp: new Date().toISOString(),
            });

            const result = await executeTransfer(userId, {
              callId: callLogIdNum,
              callSid,
              transferTo: targetPhone,
              reason: decision.reason,
              transferType: "cold",
              callerMessage: transferMessage,
              crmAgentId: agentId,
            });

            if (result.success) {
              crmEventBus.emitCallEvent({
                type: "call.transferred",
                callId: callLogIdNum,
                callSid,
                userId,
                data: await buildHandoffData({
                  conferenceSid: result.conferenceSid,
                  transferTo: targetPhone,
                  reason: decision.reason,
                  crmAgentId: agentId,
                }),
                metadata: callMeta.crmMetadata as Record<string, unknown> | undefined,
                timestamp: new Date().toISOString(),
              });
            }

            isGenerating = false;
            ws.close();
            return;
          }
        }
      }

      const basePrompt = await getCachedSystemPrompt(userId, { ...(agentConfig || {}), language: lang }, callMeta.scriptId, callMeta.externalCrmContext, callMeta.externalCrmCallFlow);
      let systemPrompt = basePrompt;

      const intentTraining = intentResult.intent !== "general_question"
        ? await db.query.intentTrainingTable.findFirst({
            where: and(
              eq(intentTrainingTable.userId, userId),
              eq(intentTrainingTable.intent, intentResult.intent)
            )
          }).catch(() => null)
        : null;

      if (intentTraining && intentTraining.trainingContent) {
        systemPrompt = basePrompt +
          `\n\nINTENT-SPECIFIC KNOWLEDGE (${intentResult.intent}):\n${intentTraining.trainingContent}\n\n` +
          `IMPORTANT: Use the above intent-specific knowledge to answer the caller's question thoroughly. ` +
          `You are an expert on this topic. Give detailed, helpful answers. ` +
          `Only suggest connecting to a human agent if you truly cannot answer after using this knowledge.`;
      }

      // Stream response
      const responseStream = streamLLMResponse(systemPrompt, history, transcript, aiModel, lang);

      let sentenceBuffer = "";
      let fullResponseText = "";
      let nextWriteIndex = 0;
      const ttsBuffersMap = new Map<number, Buffer>();
      const ttsPromises: Promise<void>[] = [];
      let sentenceIndex = 0;

      let totalSentences = 0;

      const playAudioSequential = () => {
        while (ttsBuffersMap.has(nextWriteIndex)) {
          const buffer = ttsBuffersMap.get(nextWriteIndex)!;
          ttsBuffersMap.delete(nextWriteIndex);

          // Set onComplete on every sentence — only the last one's callback
          // will actually fire since AudioPlayer replaces the callback each time.
          // This ensures isSpeaking stays true until ALL sentences finish playing.
          player?.setOnComplete(() => { isSpeaking = false; });

          isSpeaking = true;
          player?.enqueue(buffer);
          logger.info({ callLogId, bytes: buffer.length, index: nextWriteIndex }, "Response audio enqueued");
          nextWriteIndex++;
        }
      };

      const enqueueSentenceTTS = (sentence: string, index: number) => {
        ttsPromises.push(
          generateSentenceTTS(sentence, lang, voice)
            .then(audioBuffer => {
              if (activeGenerationId === genId) {
                ttsBuffersMap.set(index, audioBuffer);
                playAudioSequential();
              }
            })
            .catch(err => logger.error({ err, sentence }, "TTS generation failed")),
        );
      };

      for await (const chunk of responseStream) {
        if (activeGenerationId !== genId) {
          logger.info({ callLogId }, "LLM stream cancelled due to interruption.");
          return;
        }

        sentenceBuffer += chunk;
        fullResponseText += chunk;

        let match;
        while ((match = /[.?!]\s+/.exec(sentenceBuffer)) !== null) {
          const splitIndex = match.index + match[0].length;
          const sentence = sentenceBuffer.slice(0, splitIndex).trim();
          sentenceBuffer = sentenceBuffer.slice(splitIndex);

          if (sentence) {
            const index = sentenceIndex++;
            logger.info({ callLogId, sentence, index }, "Streaming sentence to TTS");
            enqueueSentenceTTS(sentence, index);
          }
        }
      }

      if (sentenceBuffer.trim()) {
        const index = sentenceIndex++;
        const sentence = sentenceBuffer.trim();
        logger.info({ callLogId, sentence, index }, "Streaming remainder sentence to TTS");
        enqueueSentenceTTS(sentence, index);
      }

      await Promise.all(ttsPromises);

      const endingPitchRef = crmCallFlow?.endingPitch?.trim() || script?.closingLine?.trim() || null;
      const shouldHangup = shouldAutoHangupAfterTurn(transcript, fullResponseText, endingPitchRef);

      isGenerating = false;
      history.push({ role: "assistant", content: fullResponseText });

      // Persist turn
      const updatedTranscript = [
        ...callMeta.liveTranscript,
        { role: "user", content: transcript, timestamp: new Date().toISOString() },
        { role: "assistant", content: fullResponseText, timestamp: new Date().toISOString() }
      ];
      callMeta.liveTranscript = updatedTranscript;

      const formattedTranscript = updatedTranscript
        .map((turn: any) => `${turn.role === "user" ? "Caller" : "Agent"}: ${turn.content}`)
        .join("\n\n");

      await db.update(callLogsTable)
        .set({
          liveTranscript: updatedTranscript,
          transcript: formattedTranscript
        })
        .where(eq(callLogsTable.id, parseInt(callLogId, 10)));

      // Emit turn to CRM
      crmEventBus.emitCallEvent({
        type: "call.turn",
        callId: parseInt(callLogId, 10),
        callSid,
        data: { role: "assistant", content: fullResponseText, turnIndex: history.length - 1, language: lang },
        metadata: callMeta.crmMetadata,
        timestamp: new Date().toISOString()
      });

      // Log costs
      resolveTenantIdForOwner(userId).then(tenantId => {
        if (!tenantId) return;

        const charsPerToken = isIndianLanguage(lang) ? 2.0 : 2.5;
        const inputTokens = Math.ceil((transcript.length + systemPrompt.length) / charsPerToken);
        const outputTokens = Math.ceil(fullResponseText.length / charsPerToken);

        logLLMCost({
          tenantId,
          userId,
          provider: aiModel,
          inputTokens,
          outputTokens,
          context: "twilio-voice-streaming"
        });

        logTTSCost({
          tenantId,
          userId,
          provider: isIndianLanguage(lang) ? "sarvam" : "openai",
          characters: fullResponseText.length,
          context: "twilio-tts-streaming"
        });
      }).catch(err => logger.error({ err }, "Cost logging error"));

      if (shouldHangup && !limitTriggered) {
        logger.info({ callLogId, transcript }, "Caller done + AI closing detected — hanging up");
        await player?.waitUntilIdle();
        await finishCallNaturally("Conversation naturally concluded");
        return;
      }

    } catch (err) {
      logger.error({ err }, "Error processing user utterance turn");
      isGenerating = false;
    } finally {
      isProcessingTurn = false;
      // If another utterance arrived while this turn was in progress, process it now
      if (deferredUtterance) {
        const pending = deferredUtterance;
        deferredUtterance = null;
        logger.info({ callLogId }, "Processing deferred utterance from previous turn");
        processUserUtterance(pending);
      }
    }
  };
});
