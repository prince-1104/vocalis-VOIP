import { createServer } from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../artifacts/api-server/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
// Deterministic local stand-ins for Deepgram streaming STT and Sarvam streaming TTS.
// They model the documented protocol semantics (endpointing, interim results, chunked audio,
// flush/final events) with zero artificial delay. Their timings are NOT provider latency.
const fresh = () => ({ sttConnections: 0, sttTurns: 0, sttInterims: 0, sttFinals: 0, sttFrames: 0, sttLoudFrames: 0,
  ttsConnections: 0, ttsRequests: 0, ttsTextMessages: 0, ttsCharacters: 0, ttsChunks: 0, ttsCancelled: 0, audioSamples: 0, injectedFailures: 0 });
let metrics = fresh();
// Failure injection for the benchmark only: each armed failure applies to the next connection(s).
const faults = { tts: { mode: 'ok', remaining: 0 }, stt: { mode: 'ok', remaining: 0 } };
const take = kind => {
  const fault = faults[kind];
  if (fault.mode === 'ok' || fault.remaining <= 0) return 'ok';
  fault.remaining--; metrics.injectedFailures++;
  return fault.mode;
};
const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
// One synthetic word per 300 ms of loud audio; segments of 2.5 s or more ask for a detailed answer.
const transcriptFor = loudMs => {
  const count = Math.max(1, Math.round(loudMs / 300));
  const text = Array.from({ length: count }, (_, i) => words[i % words.length]).join(' ');
  return loudMs >= 2500 ? `${text} detailed` : text;
};
const http = createServer(async (req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  if (req.url === '/metrics') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(metrics)); return; }
  if (req.url === '/control' && req.method === 'POST') {
    let body = ''; for await (const part of req) { body += part; if (body.length > 1024) { res.writeHead(413).end(); return; } }
    try {
      const { kind, mode, count = 1, reset } = JSON.parse(body || '{}');
      if (reset) { metrics = fresh(); faults.tts = { mode: 'ok', remaining: 0 }; faults.stt = { mode: 'ok', remaining: 0 }; }
      if (kind !== undefined) {
        const modes = { tts: ['ok', 'refuse', 'stall'], stt: ['ok', 'drop'] };
        if (!modes[kind]?.includes(mode) || !(count >= 0 && count <= 10)) throw new Error('invalid');
        faults[kind] = { mode, remaining: count };
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true }));
    } catch { res.writeHead(400).end(); }
    return;
  }
  res.writeHead(404).end();
});
const ws = new WebSocketServer({ server: http, maxPayload: 65536 });
ws.on('connection', (socket, req) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname === '/v1/listen') {
    metrics.sttConnections++;
    if (take('stt') === 'drop') { setTimeout(() => socket.terminate(), 1500); }
    // Deepgram semantics: `endpointing` is the trailing silence (ms) before speech_final, `false` disables it.
    const endpointing = url.searchParams.get('endpointing');
    const endpointMs = endpointing === null || endpointing === 'false' ? Infinity : Math.max(10, Number(endpointing) || 10);
    const interim = url.searchParams.get('interim_results') === 'true';
    const sampleRate = Number(url.searchParams.get('sample_rate')) || 16000;
    let speaking = false, loudMs = 0, silenceMs = 0, sinceInterim = 0, audioMs = 0, segmentStart = 0;
    const result = (isFinal, speechFinal) => {
      const text = transcriptFor(loudMs);
      socket.send(JSON.stringify({ type: 'Results', metadata: { request_id: 'local-mock' }, is_final: isFinal, speech_final: speechFinal,
        start: segmentStart / 1000, duration: (audioMs - segmentStart) / 1000,
        channel: { alternatives: [{ transcript: text, confidence: 1, words: text.split(' ').map((word, i) => ({ word, punctuated_word: word, start: segmentStart / 1000 + i * 0.3, end: segmentStart / 1000 + (i + 1) * 0.3, confidence: 1 })) }] } }));
    };
    socket.on('message', (data, binary) => {
      if (!binary) { if (JSON.parse(data).type === 'CloseStream') socket.close(); return; }
      const samples = Math.floor(data.length / 2);
      const frameMs = samples / sampleRate * 1000;
      let sum = 0;
      for (let i = 0; i + 1 < data.length; i += 2) sum += Math.abs(data.readInt16LE(i));
      const loud = sum / (samples || 1) > 100;
      metrics.sttFrames++; if (loud) metrics.sttLoudFrames++;
      audioMs += frameMs;
      if (loud) {
        if (!speaking) { speaking = true; loudMs = 0; sinceInterim = 0; segmentStart = audioMs - frameMs; socket.send(JSON.stringify({ type: 'SpeechStarted', channel: [0], timestamp: segmentStart / 1000 })); }
        loudMs += frameMs; silenceMs = 0; sinceInterim += frameMs;
        // Bursts shorter than 300 ms carry no words, like noise does for a real recognizer.
        if (interim && loudMs >= 300 && sinceInterim >= 300) { sinceInterim = 0; metrics.sttInterims++; result(false, false); }
      } else if (speaking) {
        silenceMs += frameMs;
        if (silenceMs >= endpointMs) {
          speaking = false;
          if (loudMs >= 300) { metrics.sttFinals++; metrics.sttTurns++; result(true, true); }
        }
      }
    });
  } else if (url.pathname === '/text-to-speech/ws') {
    metrics.ttsConnections++;
    const fault = take('tts');
    if (fault === 'refuse') { socket.close(1011); return; }
    let sampleRate = 24000, counted = false, finished = false;
    socket.on('close', () => { if (counted && !finished) metrics.ttsCancelled++; });
    socket.on('message', data => {
      if (fault === 'stall') return;
      const msg = JSON.parse(data);
      if (msg.type === 'config') sampleRate = Number(msg.data?.speech_sample_rate) || 24000;
      if (msg.type === 'text') {
        const text = String(msg.data?.text ?? '');
        if (!counted) { counted = true; metrics.ttsRequests++; }
        metrics.ttsTextMessages++; metrics.ttsCharacters += text.length;
        // ~55 ms of 440 Hz tone per character, in 200 ms linear16 chunks, sent as fast as generated.
        const total = Math.round(Math.max(300, text.length * 55) / 1000 * sampleRate);
        const chunk = Math.round(sampleRate / 5);
        for (let offset = 0; offset < total && socket.readyState === 1; offset += chunk) {
          const n = Math.min(chunk, total - offset), pcm = Buffer.alloc(n * 2);
          for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(7000 * Math.sin(2 * Math.PI * 440 * (offset + i) / sampleRate)), i * 2);
          metrics.audioSamples += n; metrics.ttsChunks++;
          socket.send(JSON.stringify({ type: 'audio', data: { audio: pcm.toString('base64') } }));
        }
      }
      if (msg.type === 'flush') { finished = true; socket.send(JSON.stringify({ type: 'event', data: { event_type: 'final' } })); }
    });
  } else socket.close(1008);
});
http.listen(8090, '0.0.0.0');
