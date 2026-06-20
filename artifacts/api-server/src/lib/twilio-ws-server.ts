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
import { findBestAgent } from "./transfer-manager";
import { logger } from "./logger";
import twilio from "twilio";
import OpenAI from "openai";

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

  constructor(ws: WebSocket, streamSid: string) {
    this.ws = ws;
    this.streamSid = streamSid;
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
    this.ws.send(JSON.stringify({
      event: "media",
      streamSid: this.streamSid,
      media: {
        payload: chunk.toString("base64"),
      },
    }));
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

  if (useSarvamTts) {
    if (!SARVAM_API_KEY) throw new Error("SARVAM_API_KEY not configured");
    const speaker = BULBUL_VOICE_FOR_LANG[lang] ?? "manan";

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
      timeout: 2500,
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
    logger.info({ bytes: mulaw.length, lang }, "Sarvam TTS mulaw audio ready");
    return mulaw;
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
    twilioWss.emit("connection", ws, request, callLogId);
  });
}

twilioWss.on("connection", async (ws: WebSocket, request: any, callLogId: string) => {
  logger.info({ callLogId }, "Twilio Media Stream WebSocket client connected");
  const connectionTime = Date.now();
  const callStartedAt = new Date();

  const config = await fetchConfig(callLogId);
  if (!config) {
    logger.error({ callLogId }, "Failed to load call configuration for media stream");
    ws.close();
    return;
  }

  const { userId, agentConfig, script, callMeta } = config;
  const configuredLang = agentConfig?.language || "en-US";
  const aiModel = agentConfig?.aiModel || "gpt-4o-mini";
  const voice = agentConfig?.voice || "nova";

  let streamSid = "";
  let callSid = "";
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
  let activeGenerationId = "";

  // History and transfer rule state
  const history: { role: string; content: string }[] = [...(callMeta.liveTranscript || [])];
  const intentTurnCounts: Record<string, number> = {};
  let humanReqCount = 0;

  const transferRules = callMeta.crmMetadata?.__transferRules as TransferRules | undefined;
  const hasTransferRules = !!transferRules;

  // Initial greeting
  const greeting = script?.openingLine || agentConfig?.greeting || "Hi, thank you for calling. How can I help you today?";

  const playGreeting = async () => {
    try {
      isGenerating = true;
      greetingCancelled = false;

      logger.info({ callLogId, greeting }, "Generating greeting TTS...");
      const audio = await generateSentenceTTS(greeting, configuredLang, voice);

      if (!greetingCancelled) {
        isGenerating = false;
        isSpeaking = true;
        player?.setOnComplete(() => {
          isSpeaking = false;
        });
        player?.enqueue(audio);
        logger.info({ callLogId, bytes: audio.length }, "Greeting audio enqueued");

        const updatedTranscript = [
          ...callMeta.liveTranscript,
          { role: "assistant", content: greeting, timestamp: new Date().toISOString() }
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
      }
    } catch (err) {
      logger.error({ err }, "Error playing greeting");
      isGenerating = false;
    }
  };

  ws.on("message", async (msg: any) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "start") {
        streamSid = data.start.streamSid;
        callSid = data.start.callSid;
        player = new AudioPlayer(ws, streamSid);
        logger.info({ streamSid, callSid }, "Twilio Media Stream started");

        if (!callMeta.callSid) {
          callMeta.callSid = callSid;
          await db.update(callLogsTable).set({ callSid }).where(eq(callLogsTable.id, parseInt(callLogId, 10)));
        }

        playGreeting();
      }

      if (data.event === "media") {
        if (!player) return;

        const payload = data.media.payload;
        const muLawBuffer = Buffer.from(payload, "base64");
        const pcmChunk = decodeMuLawBuffer(muLawBuffer);

        let sum = 0;
        for (let i = 0; i < pcmChunk.length; i++) {
          sum += pcmChunk[i] * pcmChunk[i];
        }
        const rms = Math.sqrt(sum / pcmChunk.length);

        // While bot is speaking, ignore echo/noise unless caller speaks loudly to interrupt.
        if (isSpeaking) {
          const INTERRUPT_THRESHOLD = 7500;
          if (rms > INTERRUPT_THRESHOLD) {
            speechChunksCount++;
            if (speechChunksCount >= 4) {
              logger.info({ rms, callLogId }, "VAD: Interruption detected! Clearing bot player.");
              greetingCancelled = true;
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
      logger.info({ callLogId }, "Skipping utterance, turn already in progress");
      return;
    }

    isProcessingTurn = true;
    const genId = randomUUID();
    activeGenerationId = genId;
    isGenerating = true;

    try {
      const wavBuffer = createWavBuffer(pcmSamples, 8000);
      let lang = configuredLang;
      logger.info({ callLogId, lang }, "Transcribing audio...");
      let transcript = "";

      const useSarvamStt = isIndianLanguage(lang);
      if (useSarvamStt) {
        transcript = await callSarvamSTT(wavBuffer, "audio/wav", lang);
      } else {
        const file = await toFile(wavBuffer, "audio.wav", { type: "audio/wav" });
        const res = await openai.audio.transcriptions.create({
          file,
          model: "whisper-1",
          language: lang === "auto" ? undefined : lang.split("-")[0]
        });
        transcript = res.text;
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

      if (configuredLang === "auto") {
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

      // Check auto transfer rules
      if (transferRules) {
        const intentTraining = intentResult.intent !== "general_question"
          ? await db.query.intentTrainingTable.findFirst({
              where: and(
                eq(intentTrainingTable.userId, userId),
                eq(intentTrainingTable.intent, intentResult.intent)
              )
            }).catch(() => null)
          : null;

        const mergedRules: TransferRules = {
          ...transferRules,
          perIntentMaxTurns: {
            ...(transferRules.perIntentMaxTurns || {}),
            ...(intentTraining ? { [intentResult.intent]: intentTraining.maxTurns } : {})
          }
        };

        const decision = shouldTransfer(
          intentResult,
          mergedRules,
          Math.floor((history.length + 1) / 2),
          intentTurnCounts,
          humanReqCount
        );

        if (decision.transfer) {
          let targetPhone = intentTraining?.transferTo || transferRules.transferTo;
          let agentId = intentTraining?.crmAgentId || transferRules.crmAgentId;

          if (!targetPhone) {
            const bestAgent = await findBestAgent(userId, intentResult.intent);
            if (bestAgent) {
              targetPhone = bestAgent.phone;
              agentId = bestAgent.agentId;
            }
          }

          if (targetPhone) {
            logger.info({ callLogId, targetPhone }, "Executing transfer programmatically...");
            player?.clear();
            ws.send(JSON.stringify({ event: "clear", streamSid }));

            const conferenceName = `auto-transfer-${callLogId}-${Date.now()}`;
            const host = request.headers.host || "localhost";
            const baseUrl = `https://${host}`;

            const transferTwiml = `
<Response>
  <Say>Please wait, your call is being transferred to our specialist. Please stay on the line.</Say>
  <Dial>
    <Conference
      statusCallback="${baseUrl}/api/crm/conference-status?callId=${callLogId}"
      statusCallbackEvent="join leave end"
      startConferenceOnEnter="false"
      endConferenceOnExit="true"
      beep="false"
      waitUrl="${baseUrl}/api/twilio/hold-music?lang=${encodeURIComponent(lang)}"
      waitMethod="POST"
    >${conferenceName}</Conference>
  </Dial>
</Response>
`;

            if (agentConfig?.twilioAccountSid && agentConfig?.twilioAuthToken && agentConfig?.phoneNumber) {
              const client = twilio(agentConfig.twilioAccountSid, agentConfig.twilioAuthToken);
              
              await client.calls(callSid).update({ twiml: transferTwiml });

              client.calls.create({
                to: targetPhone,
                from: agentConfig.phoneNumber,
                twiml: `<Response><Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="false" beep="false">${conferenceName}</Conference></Dial></Response>`,
                statusCallback: `${baseUrl}/api/crm/agent-call-status?callId=${callLogId}`,
                statusCallbackMethod: "POST",
                statusCallbackEvent: ["completed", "no-answer", "busy", "failed"],
              }).then(agentCall => {
                crmEventBus.emitCallEvent({
                  type: "call.transferred",
                  callId: parseInt(callLogId, 10),
                  callSid,
                  userId,
                  data: { conferenceSid: conferenceName, agentCallSid: agentCall.sid, transferTo: targetPhone },
                  metadata: callMeta.crmMetadata,
                  timestamp: new Date().toISOString()
                });
              }).catch(err => logger.error({ err }, "Transfer agent dial failed"));

              await db.update(callLogsTable)
                .set({
                  conferenceSid: conferenceName,
                  transferredTo: targetPhone,
                  transferReason: decision.reason,
                  transferredAt: new Date()
                })
                .where(eq(callLogsTable.id, parseInt(callLogId, 10)));
            }

            isGenerating = false;
            ws.close();
            return;
          }
        }
      }

      const basePrompt = await getCachedSystemPrompt(userId, { ...(agentConfig || {}), language: lang }, callMeta.scriptId);
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
      let sentenceIndex = 0;

      const playAudioSequential = () => {
        while (ttsBuffersMap.has(nextWriteIndex)) {
          const buffer = ttsBuffersMap.get(nextWriteIndex)!;
          ttsBuffersMap.delete(nextWriteIndex);

          if (nextWriteIndex === 0) {
            player?.setOnComplete(() => { isSpeaking = false; });
          }

          isSpeaking = true;
          player?.enqueue(buffer);
          logger.info({ callLogId, bytes: buffer.length, index: nextWriteIndex }, "Response audio enqueued");
          nextWriteIndex++;
        }
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

            generateSentenceTTS(sentence, lang, voice)
              .then(audioBuffer => {
                if (activeGenerationId === genId) {
                  ttsBuffersMap.set(index, audioBuffer);
                  playAudioSequential();
                }
              })
              .catch(err => logger.error({ err, sentence }, "TTS generation failed"));
          }
        }
      }

      if (sentenceBuffer.trim()) {
        const index = sentenceIndex++;
        const sentence = sentenceBuffer.trim();
        logger.info({ callLogId, sentence, index }, "Streaming remainder sentence to TTS");

        generateSentenceTTS(sentence, lang, voice)
          .then(audioBuffer => {
            if (activeGenerationId === genId) {
              ttsBuffersMap.set(index, audioBuffer);
              playAudioSequential();
            }
          })
          .catch(err => logger.error({ err, sentence }, "TTS generation failed"));
      }

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

    } catch (err) {
      logger.error({ err }, "Error processing user utterance turn");
      isGenerating = false;
    } finally {
      isProcessingTurn = false;
    }
  };
});
