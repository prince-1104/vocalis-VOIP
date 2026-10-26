import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import os from 'node:os';
import { completedResponseEnd, greetingCompletion, replyDelivery, interruptionAccounting } from './voice-audio-boundary.mjs';
const credentials = JSON.parse(await readFile('/run/dialog-local/login.json', 'utf8'));
const BENCH = process.env.VOICE_BENCH === '1';
const MOCKS = 'http://mock-providers:8090';
// Manual-live benchmark only (scripts/voice-local.mjs bench-live): real STT cannot transcribe
// synthetic vowels, so an operator-recorded speech clip replaces the synthesizer. Never logged.
const LIVE = BENCH && process.env.VOICE_BENCH_PROVIDER_MODE === 'live';
const LIVE_CLIP = '/app/bench-out/live-utterance.wav';
// The smoke container shares the gateway network namespace, so 127.0.0.1 reaches the
// gateway relays (5173 frontend, 7880-7882 LiveKit) and is a secure context, which is
// required for navigator.mediaDevices to exist at all.
async function main() {
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
try {
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  await page.addInitScript({ content: 'window.__completedResponseEnd = ' + completedResponseEnd.toString() });
  await page.addInitScript({ content: 'window.__greetingCompletion = ' + greetingCompletion.toString() });
  await page.addInitScript({ content: 'window.__replyDelivery = ' + replyDelivery.toString() });
  await page.addInitScript({ content: 'window.__interruptionAccounting = ' + interruptionAccounting.toString() });
  // Only sanitized assertion names go to stdout. No traces, HARs or provider payload logs.
  // Failure diagnostics print redacted, truncated error text only — never tokens or payloads.
  const redact = text => String(text).replace(/(token|secret|authorization|key)[=:"'\s]+[^&\s"']+/gi, '$1=***')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>').replace(/\b(RM|PA|TR)_[A-Za-z0-9]+/g, '$1_<id>').slice(0, 300);
  page.on('pageerror', error => console.error('DIAG pageerror:', redact(error.message)));
  page.on('crash', () => console.error('DIAG renderer crashed'));
  page.on('console', message => { if (message.type() === 'error') console.error('DIAG console:', redact(message.text())); });
  await page.addInitScript(() => {
    // Speech-like synthetic microphone (source-filter vowel synthesis): a ~120 Hz glottal pulse
    // train with pitch drift and vibrato through three formant band-passes whose targets change
    // every 220 ms syllable, behind a gate scheduled on the audio clock. A plain sawtooth is not
    // classified as speech by Silero VAD (max probability ~0.07), so barge-in would go untested.
    const mic = new AudioContext();
    const harmonics = new Float32Array(40).fill(1); harmonics[0] = 0;
    const voice = mic.createOscillator(); voice.setPeriodicWave(mic.createPeriodicWave(new Float32Array(40), harmonics)); voice.frequency.value = 120;
    for (const [rate, depthHz] of [[0.8, 15], [5.1, 6]]) {
      const lfo = mic.createOscillator(); lfo.frequency.value = rate; const depth = mic.createGain(); depth.gain.value = depthHz;
      lfo.connect(depth).connect(voice.frequency); lfo.start();
    }
    const VOWELS = [[730, 1090, 2440], [270, 2290, 3010], [300, 870, 2240], [530, 1840, 2480], [570, 840, 2410]];
    const syllable = mic.createGain(); syllable.gain.value = 0;
    const formants = [[5, 1], [8, 0.6], [10, 0.3]].map(([q, weight], i) => {
      const band = mic.createBiquadFilter(); band.type = 'bandpass'; band.Q.value = q; band.frequency.value = VOWELS[0][i];
      const g = mic.createGain(); g.gain.value = weight * 3; voice.connect(band).connect(g).connect(syllable); return band;
    });
    const gate = mic.createGain(); gate.gain.value = 0;
    syllable.connect(gate); voice.start();
    let vowelIndex = 0;
    const scheduleSyllables = (from, ms) => {
      for (let t = 0; t < ms; t += 220) {
        const at = from + t / 1000, len = Math.min(0.22, (ms - t) / 1000), v = VOWELS[vowelIndex++ % VOWELS.length];
        formants.forEach((band, i) => band.frequency.setValueAtTime(v[i], at));
        syllable.gain.setValueAtTime(0.15, at); syllable.gain.linearRampToValueAtTime(1, at + Math.min(0.06, len / 2));
        syllable.gain.setValueAtTime(1, at + Math.max(len - 0.05, len / 2)); syllable.gain.linearRampToValueAtTime(0.15, at + len);
      }
    };
    // A fresh stream per call: the SDK stops the previous session's track on disconnect.
    navigator.mediaDevices.getUserMedia = async () => {
      await mic.resume(); const destination = mic.createMediaStreamDestination(); gate.connect(destination); return destination.stream;
    };
    // segments: [[speechMs, silenceMs], ...]. Returns browser-clock (performance.now) speech boundaries.
    window.__speak = async (segments, level = 0.4) => {
      await mic.resume();
      const ctxStart = mic.currentTime + 0.05, perfStart = performance.now() + 50;
      const bounds = []; let offset = 0;
      for (const [on, off] of segments) {
        gate.gain.setValueAtTime(level, ctxStart + offset / 1000); bounds.push([perfStart + offset]);
        if (clip) {
          const source = mic.createBufferSource(); source.buffer = clip; source.loop = true; source.connect(gate);
          source.start(ctxStart + offset / 1000); source.stop(ctxStart + (offset + on) / 1000);
        } else scheduleSyllables(ctxStart + offset / 1000, on);
        offset += on;
        gate.gain.setValueAtTime(0, ctxStart + offset / 1000); bounds[bounds.length - 1].push(perfStart + offset);
        offset += off;
      }
      await new Promise(r => setTimeout(r, offset + 60));
      return bounds;
    };
    let clip = null;
    window.__setClip = async base64 => { clip = await mic.decodeAudioData(Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer); return clip.duration; };
    window.__voiceInput = async (ms = 1000) => { await window.__speak([[ms, 0]]); return { localPeak: 0.4, contextState: mic.state }; };
    // Agent audio envelope on the browser clock: audible segments [onset, last audible sample].
    window.__env = { segments: [], audible: false, onAt: 0, lastLoud: 0, peak: 0 };
    window.__audioEvidence = { get peak() { return window.__env.peak; } };
    // Elements may start via autoplay without play(), so watch for new subscribed streams instead.
    const observed = new Map(); // stream id -> stop()
    const observe = (stream, element) => {
      const audio = new AudioContext(); const input = audio.createMediaStreamSource(stream);
      const analyser = audio.createAnalyser(); analyser.fftSize = 256; input.connect(analyser); const data = new Float32Array(analyser.fftSize);
      let lastReport = 0, windowPeak = 0;
      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(data);
        let peak = 0; for (const v of data) peak = Math.max(peak, Math.abs(v));
        const env = window.__env, now = performance.now();
        windowPeak = Math.max(windowPeak, peak);
        if (now - lastReport >= 250) {
          const correlation = element.dataset.dialogDiagnostic;
          window.dispatchEvent(new CustomEvent('dialog-media', { detail: { e: 'browser_analyser', t: now,
            correlation: /^[0-9a-f-]{36}$/.test(correlation ?? '') ? correlation : undefined,
            track: Number(element.dataset.dialogTrack), peak: windowPeak, running: audio.state === 'running', threshold: 0.02 } }));
          lastReport = now; windowPeak = 0;
        }
        env.peak = Math.max(env.peak, peak);
        if (peak > 0.02) { if (!env.audible) { env.audible = true; env.onAt = now; } env.lastLoud = now; }
        else if (env.audible && now - env.lastLoud > 25) { env.audible = false; env.segments.push([env.onAt, env.lastLoud]); }
      }, 5);
      void audio.resume();
      return () => { clearInterval(timer); void audio.close(); };
    };
    setInterval(() => {
      const live = new Set();
      for (const el of document.querySelectorAll('audio')) {
        const stream = el.srcObject;
        if (!(stream instanceof MediaStream) || !stream.getAudioTracks().some(t => t.readyState === 'live')) continue;
        live.add(stream.id);
        if (!observed.has(stream.id)) observed.set(stream.id, observe(stream, el));
      }
      for (const [id, stop] of observed) if (!live.has(id)) { stop(); observed.delete(id); }
    }, 50);
    // Worker stage events: worker-clock `t`; `rx` is only used to assign events to a test case.
    window.__bench = [];
    window.addEventListener('dialog-bench', e => { try { window.__bench.push({ ...JSON.parse(e.detail), rx: performance.now() }); if (window.__bench.length > 20000) window.__bench.shift(); } catch {} });
    window.__media = [];
    window.addEventListener('dialog-media', e => { window.__media.push(e.detail); if (window.__media.length > 2000) window.__media.shift(); });
  });
  // A freshly recreated Vite dev server pre-bundles dependencies on first request.
  await page.goto('http://127.0.0.1:5173/login', { timeout: 120000 });
  const tokens = [];
  for (const user of credentials) {
    const response = await context.request.post('http://fixture-api:3003/api/auth/login', { data: user });
    assert.equal(response.status(), 200, 'fixture password login'); tokens.push((await response.json()).token);
  }
  await page.evaluate(token => localStorage.setItem('ss_auth_token', token), tokens[0]);
  await page.goto('http://127.0.0.1:5173/dev/livekit');
  if (LIVE) await page.evaluate(clip => window.__setClip(clip), (await readFile(LIVE_CLIP)).toString('base64'));
  let createdSessions = 0;
  await page.route('**/api/dev/livekit/sessions', async route => {
    const response = await route.fetch();
    if (response.status() !== 201) { await route.fulfill({ response }); return; }
    createdSessions++;
    const data = await response.json();
    // The browser runs inside the isolated bridge; loopback reaches the gateway relay.
    data.url = 'ws://127.0.0.1:7880';
    await route.fulfill({ response, json: data });
  });
  // Mock benchmark populations include every session, without an unrecorded warming preflight.
  if (!(BENCH && !LIVE)) {
  // A job that lands on a worker process still initializing (cold SDK import + VAD load) can miss
  // the greeting window; one bounded retry is allowed and reported, never silently absorbed.
  for (let attempt = 1; ; attempt++) {
    await page.getByRole('button', { name: 'Start preview' }).click();
    try {
      await page.getByRole('status').filter({ hasText: 'Connected' }).waitFor({ timeout: 60000 });
    } catch (error) {
      console.error('DIAG status at timeout:', redact(await page.getByRole('status').textContent().catch(() => 'unreadable')));
      throw error;
    }
    const greeted = await page.waitForFunction(() => window.__audioEvidence.peak > 0.01, undefined, { timeout: 45000 }).then(() => true).catch(() => false);
    if (greeted) break;
    if (attempt === 2) throw new Error('No greeting audio after retry');
    console.error('DIAG no greeting within 45 s; retrying session start once');
    await page.getByRole('button', { name: 'Stop preview' }).click().catch(() => undefined);
    await page.getByRole('status').filter({ hasText: 'Stopped' }).waitFor({ timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(15000);
  }
  console.log('PASS real-room greeting: non-silent subscribed audio');
  if (LIVE) {
    // No mock counters exist in manual-live mode; worker stage events prove the turn instead.
    await page.waitForTimeout(3000);
    const seen = await page.evaluate(() => window.__bench.length);
    await page.evaluate(() => window.__voiceInput(4000));
    await page.waitForFunction(n => window.__bench.slice(n).some(e => e.e === 'tts_start'), seen, { timeout: 30000 });
  } else {
    const before = await (await context.request.get(`${MOCKS}/metrics`)).json();
    // STT audio arrives in 100 ms chunks; speak long enough for a final transcript and a reply.
    await page.waitForTimeout(3000);
    const spokeAt = await page.evaluate(() => performance.now());
    await page.evaluate(() => window.__voiceInput(4000));
    // APIRequestContext avoids broadening frontend CORS just for fixture observations.
    const deadline = Date.now() + 30000;
    let after;
    do { after = await (await context.request.get(`${MOCKS}/metrics`)).json(); if (after.ttsRequests > before.ttsRequests) break; await new Promise(r => setTimeout(r, 250)); } while (Date.now() < deadline);
    if (!(after.sttTurns > before.sttTurns && after.ttsRequests > before.ttsRequests)) {
      // Event names, offsets and counter deltas only.
      const events = await page.evaluate(() => window.__bench.map(e => [e.e, Math.round(e.rx)]));
      console.error('DIAG smoke turn:', JSON.stringify(Object.fromEntries(['sttFrames', 'sttLoudFrames', 'sttInterims', 'sttFinals', 'sttTurns', 'ttsRequests'].map(k => [k, (after[k] ?? 0) - (before[k] ?? 0)]))),
        JSON.stringify(events.map(([e, rx]) => [e, rx - Math.round(spokeAt)])).slice(0, 1500));
    }
    assert.ok(after.sttTurns > before.sttTurns && after.ttsRequests > before.ttsRequests, 'microphone audio -> official STT plugin -> Dialog LLM -> official TTS plugin');
  }
  console.log('PASS real-room synthetic microphone response');
  await page.getByRole('button', { name: 'Stop preview' }).click();
  await page.getByRole('status').filter({ hasText: 'Stopped' }).waitFor();
  console.log('PASS explicit session shutdown');
  }
  if (BENCH) await benchmark(page, context, () => createdSessions);
  await context.close();
} finally { await browser.close(); }
}

// ── Latency benchmark (VOICE_BENCH=1) ────────────────────────────────────────
async function benchmark(page, context, sessionCount) {
  // Manual-live runs are bounded (paid provider requests) and never inject faults.
  const config = {
    label: /^[a-z0-9-]{1,40}$/.test(process.env.VOICE_BENCH_LABEL ?? '') ? process.env.VOICE_BENCH_LABEL : 'unlabelled',
    warmupSessions: int('VOICE_BENCH_WARMUP', LIVE ? 0 : 1, 0, LIVE ? 1 : 5),
    mixedSessions: int('VOICE_BENCH_ITERATIONS', LIVE ? 2 : 10, 0, LIVE ? 3 : 50),
    // Reliability mode: greeting, then a first user turn 150/600/1500 ms after playback ends, then a second turn.
    firstTurnSessions: LIVE ? 0 : int('VOICE_BENCH_FIRST_TURN', 0, 0, 100),
    repeatSessions: int('VOICE_BENCH_REPEAT_SESSIONS', LIVE ? 1 : 4, 0, LIVE ? 2 : 20),
    repeatTurns: 6,
    failureRuns: LIVE ? 0 : int('VOICE_BENCH_FAILURE_RUNS', 1, 0, 5),
    providerMode: LIVE ? 'live' : 'mock',
  };
  const control = body => LIVE ? Promise.resolve() : context.request.post(`${MOCKS}/control`, { data: body }).catch(() => undefined);
  const now = () => page.evaluate(() => performance.now());
  const status = () => page.getByRole('status').textContent();
  const samples = [];   // { case, iteration, turn?, browser: {...}, worker: {...}, outcome }
  await mkdir('/app/bench-out', { recursive: true });
  const attemptLedger = `/app/bench-out/attempts-${config.label}-${Date.now()}.jsonl`;
  let tuning = null;
  const nextOnset = (after, timeout) => page.waitForFunction(([after]) => {
    const env = window.__env;
    const seg = env.segments.find(s => s[0] > after);
    return seg ? seg[0] : (env.audible && env.onAt > after ? env.onAt : false);
  }, [after], { timeout, polling: 10 }).then(h => h.jsonValue()).catch(() => null);
  // End of an agent response: last audible sample followed by `quiet` ms of silence.
  const responseEnd = (after, quiet, timeout, completionAfter = null, replyFrom = null) => page.waitForFunction(([after, quiet, completionAfter, replyFrom]) => {
    const env = window.__env;
    const completed = replyFrom !== null ? window.__replyDelivery(window.__bench, window.__media, replyFrom).complete
      : completionAfter === null || window.__greetingCompletion(window.__bench, window.__media, completionAfter);
    return window.__completedResponseEnd(env, performance.now(), after, quiet, completed);
  }, [after, quiet, completionAfter, replyFrom], { timeout, polling: 20 }).then(h => h.jsonValue()).catch(() => null);
  const segmentsBetween = (from, to) => page.evaluate(([from, to]) => {
    const env = window.__env, all = [...env.segments, ...(env.audible ? [[env.onAt, env.lastLoud]] : [])];
    return all.filter(s => s[1] >= from && s[0] <= to);
  }, [from, to]);
  const eventsBetween = (from, to) => page.evaluate(([from, to]) => window.__bench.filter(e => e.rx >= from && e.rx <= to), [from, to]);
  const playback = segs => {
    if (!segs.length) return { playbackMs: null, gaps: 0, gapMs: 0, responses: 0 };
    const responses = [[...segs[0]]]; let gaps = 0, gapMs = 0;
    for (const s of segs.slice(1)) {
      const cur = responses.at(-1), gap = s[0] - cur[1];
      if (gap < 400) { if (gap >= 30) { gaps++; gapMs += gap; } cur[1] = s[1]; } else responses.push([...s]);
    }
    return { playbackMs: responses[0][1] - responses[0][0], gaps, gapMs: Math.round(gapMs), responses: responses.length };
  };
  async function startSession(quiet = 600) {
    // One invocation is one attempt. Never replace a failed session with a successful retry.
    return startSessionOnce(quiet);
  }
  async function startSessionOnce(quiet) {
    for (let attempt = 0; attempt < 1; attempt++) {
      await page.evaluate(() => { window.__env.segments = []; window.__env.audible = false; window.__env.peak = 0; });
      const clicked = await now();
      await page.getByRole('button', { name: 'Start preview' }).click();
      const ok = await page.getByRole('status').filter({ hasText: 'Connected' }).waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
      if (ok) {
        const start = await now();
        const greetingOn = await nextOnset(start - 5000, 20000);
        if (greetingOn === null) {
          // Worker stage events of this attempt: names and worker-clock offsets only.
          const events = await eventsBetween(clicked, await now());
          console.error('DIAG no greeting:', JSON.stringify(await page.evaluate(() => ({ benchEvents: window.__bench.length, peak: window.__env.peak,
            audioElements: document.querySelectorAll('audio').length, status: document.querySelector('[role=status]')?.textContent }))),
            JSON.stringify(events.map(e => [e.e, Math.round(e.t - (events[0]?.t ?? 0))])).slice(0, 1500));
          return { ok: false, reason: 'no_greeting' };
        }
        const greetingEnd = await responseEnd(greetingOn, quiet, 20000, clicked);
        if (greetingEnd === null) return { ok: false, reason: 'greeting_incomplete' };
        return { ok: true, connectToGreetingMs: greetingOn - start, greetingOn, greetingEnd };
      }
      await stopSession(); await page.waitForTimeout(2000);
    }
    return { ok: false, reason: 'start_failed' };
  }
  async function stopSession() {
    await page.getByRole('button', { name: 'Stop preview' }).click().catch(() => undefined);
    await page.getByRole('status').filter({ hasText: 'Stopped' }).waitFor({ timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
  }
  // One user turn: speak, then observe the agent's reply on the browser clock.
  async function turn(name, segments, { expectLong = false, quiet = 700, extra } = {}) {
    const caseStart = await now();
    const bounds = await page.evaluate(s => window.__speak(s), segments);
    const speechStart = bounds[0][0], speechEnd = bounds.at(-1)[1];
    const onset = await nextOnset(speechStart, expectLong ? 15000 : 12000);
    const record = { case: name, browser: { speechStartMs: speechStart, speechEndMs: speechEnd }, outcome: 'ok' };
    if (onset === null) { record.outcome = 'timeout_no_response'; }
    else {
      record.browser.e2eFirstAudioMs = onset - speechEnd;
      if (onset < speechEnd) record.outcome = 'premature_response';
      if (extra) {
        const prior = record.outcome;
        const { browser = {}, ...rest } = await extra(onset, speechEnd, caseStart); Object.assign(record.browser, browser); Object.assign(record, rest);
        if (prior !== 'ok' && record.outcome === 'ok') record.outcome = prior;
      }
      const end = 'endAt' in record ? record.endAt : await responseEnd(onset, quiet, expectLong ? 30000 : 15000, null, record.interrupted ? null : caseStart);
      const segs = await segmentsBetween(onset - 1, (end ?? await now()) + 1);
      const p = playback(segs);
      record.browser.playbackMs = record.interrupted ? null : p.playbackMs;
      record.browser.gaps = p.gaps; record.browser.gapMs = p.gapMs; record.browser.responses = p.responses;
      if (end === null && record.outcome === 'ok') record.outcome = 'timeout_response_end';
    }
    await page.waitForTimeout(800);
    const caseEnd = await now();
    const all = await segmentsBetween(caseStart, caseEnd);
    record.browser.responsesInWindow = playback(all).responses;
    const events = await eventsBetween(caseStart, caseEnd);
    record.media = await page.evaluate(([from, to]) => window.__media.filter(e => e.t >= from && e.t <= to), [caseStart, caseEnd]);
    record.stages = events;
    record.delivery = await page.evaluate(from => window.__replyDelivery(window.__bench, window.__media, from), caseStart);
    if (record.outcome === 'ok' && !record.interrupted && !record.delivery.complete) record.outcome = 'incomplete_audio_delivery';
    record.worker = workerStages(events);
    // No worker event at all while the user spoke: the job stopped processing (silent session).
    if (record.outcome === 'timeout_no_response' && !events.length) record.outcome = 'timeout_session_silent';
    if ((extra || record.outcome !== 'ok') && events.length) record.timeline = events.map(e => [e.e, Math.round(e.t - events[0].t)]);
    // A second synthesized reply in one user turn means the turn was split (premature closure).
    if (record.outcome === 'ok' && !record.interrupted && !record.pausesAllowed
      && (record.worker.counts.tts_start ?? 0) > 1 + (record.delivery.cancelledBeforeAudioStreams ?? 0)) record.outcome = 'duplicate_response';
    tuning ??= (await page.evaluate(() => window.__bench.find(e => e.e === 'session_start'))) ?? null;
    return record;
  }
  const interruptExtra = async (onset, _speechEnd, caseStart) => {
    await page.waitForTimeout(Math.max(0, onset + 1200 - await now()));
    const bounds = await page.evaluate(() => window.__speak([[1200, 0]]));
    const userOn = bounds[0][0], userEnd = bounds[0][1];
    // The obsolete reply stops (an audible segment followed by >= 300 ms of silence);
    // the interrupting request is then answered rather than suppressed.
    const stop = await page.waitForFunction(([userOn]) => {
      const env = window.__env, now = performance.now();
      const segs = env.segments.filter(s => s[1] >= userOn);
      for (let i = 0; i < segs.length; i++) {
        const next = segs[i + 1]?.[0] ?? (env.audible ? env.onAt : Infinity);
        if (next - segs[i][1] >= 300 && (next !== Infinity || now - segs[i][1] >= 300)) return segs[i][1];
      }
      return false;
    }, [userOn], { timeout: 8000, polling: 10 }).then(h => h.jsonValue()).catch(() => null);
    const reply = await nextOnset(Math.max(userEnd, stop ?? userEnd), 12000);
    const replyEnd = reply === null ? null : await responseEnd(reply, 700, 15000, null, userOn);
    const recoveryDelivery = await page.evaluate(from => window.__replyDelivery(window.__bench, window.__media, from), userOn);
    const interruptedDelivery = await page.evaluate(from => window.__interruptionAccounting(window.__bench, window.__media, from), caseStart);
    return { interrupted: true, interruptedDelivery, recoveryDelivery, endAt: replyEnd,
      browser: { interruptStopMs: stop === null ? null : stop - userOn, afterInterruptFirstAudioMs: reply === null ? null : reply - userEnd },
      outcome: stop === null ? 'interrupt_not_stopped' : reply === null ? 'interrupt_reply_missing'
        : !interruptedDelivery.confirmed ? 'interrupt_not_confirmed' : !recoveryDelivery.complete || replyEnd === null ? 'incomplete_interrupt_reply' : 'ok' };
  };
  const falseInterruptExtra = async (onset, _speechEnd, caseStart) => {
    await page.waitForTimeout(Math.max(0, onset + 1200 - await now()));
    const before = await mockCounters();
    await control({ kind: 'stt', mode: 'noise', count: 1 });
    const bounds = await page.evaluate(() => window.__speak([[250, 0]]));
    const burst = bounds[0][0];
    const end = await responseEnd(onset, 2600, 40000, null, caseStart);
    const segs = await segmentsBetween(onset - 1, (end ?? await now()) + 1);
    const pauses = segs.slice(1).map((s, i) => s[0] - segs[i][1]).filter(g => g >= 400);
    const audible = segs.reduce((n, s) => n + s[1] - s[0], 0);
    const after = await mockCounters();
    const noiseInjected = after.injectedFailures - before.injectedFailures === 1;
    await control({ kind: 'stt', mode: 'ok', count: 0 });
    return { endAt: end, pausesAllowed: true, paused: pauses.length > 0, burstAt: burst, noiseInjected,
      ...(!noiseInjected ? { outcome: 'false_interruption_fault_not_injected' } : {}), browser: { audibleMs: Math.round(audible) } };
  };
  // Worker evidence decides the class: a second LLM/TTS turn means the burst became a user turn
  // (the reply was replaced); an SDK false-interruption event means playout paused and resumed.
  const classifyFalseInterrupt = r => {
    const c = r.worker?.counts ?? {};
    r.falseInterruption = (c.llm_start ?? 0) > 1 || (c.tts_start ?? 0) > 1 ? 'treated_as_turn'
      : (c.tts_cancelled ?? 0) > 0 ? 'reply_cancelled' : (c.false_interruption ?? 0) > 0 ? 'paused_then_resumed' : r.paused ? 'paused' : 'continued';
    if (['treated_as_turn', 'reply_cancelled'].includes(r.falseInterruption) && r.outcome === 'ok') r.outcome = 'false_interruption_dropped_reply';
    return r;
  };
  const run = async (mixed, iteration, measured) => {
    const out = [];
    const from = await now();
    const started = await startSession();
    const session = { case: 'session', iteration, outcome: started.ok ? (started.retried ? 'ok_after_no_greeting_retry' : 'ok') : started.reason,
      retried: Boolean(started.retried), browser: started.ok ? { connectToGreetingMs: started.connectToGreetingMs } : {} };
    out.push(session);
    const finish = async () => {
      const d = sessionDiagnostics(await eventsBetween(from, await now()));
      delete d._greetingDoneT;
      session.diagnostics = d; session.browser.sessionMs = Math.round(await now() - from);
      await stopSession();
      return out.map(r => ({ ...r, iteration }));
    };
    if (!started.ok) return finish();
    if (mixed) {
      out.push(await turn('pause', [[1500, 450], [1500, 0]]));
      out.push(await turn('long', [[3000, 0]], { expectLong: true }));
      await page.waitForTimeout(2000); // silence before speech: no response may start
      const quietWindow = await segmentsBetween(await now() - 2000, await now());
      const s = await turn('silence', [[1200, 0]], { quiet: 2500 });
      if (quietWindow.length) s.outcome = 'response_during_silence';
      out.push(s);
      out.push(await turn('interrupt', [[3000, 0]], { expectLong: true, extra: interruptExtra }));
      out.push(classifyFalseInterrupt(await turn('false_interrupt', [[3000, 0]], { expectLong: true, extra: falseInterruptExtra })));
    } else {
      for (let t = 0; t < (measured ? config.repeatTurns : 2); t++) out.push({ ...(await turn('short', [[1200, 0]])), turn: t + 1 });
    }
    return finish();
  };
  const mockCounters = async () => (await (await context.request.get(`${MOCKS}/metrics`)).json().catch(() => ({})));
  const COUNTER_KEYS = ['sttConnections', 'sttTurns', 'ttsConnections', 'ttsRequests', 'ttsCancelled', 'injectedFailures'];
  const STT_KEYS = ['sttFrames', 'sttLoudFrames', 'sttInterims', 'sttFinals'];
  const isDisconnected = timeout => page.getByRole('status').filter({ hasText: 'Disconnected' }).waitFor({ timeout }).then(() => true).catch(() => false);
  const failure = async (kind, mode, iteration) => {
    const before = await mockCounters();
    const started = await startSession();
    if (!started.ok) { await stopSession(); return { case: `${kind}_${mode}`, iteration, outcome: started.reason, browser: {}, worker: {}, faultInjected: false }; }
    const t0 = await now();
    // Arm only after confirmed greeting completion; STT drops this live utterance.
    await control({ kind, mode, count: 1 });
    const first = await page.evaluate(() => window.__speak([[1200, 0]]));
    const firstEnd = first[0][1];
    const firstReply = await nextOnset(first[0][0], 15000);
    let faultedDelivery = null;
    if (firstReply !== null) {
      const completed = await responseEnd(firstReply, 700, 20000, null, t0);
      faultedDelivery = await page.evaluate(from => window.__replyDelivery(window.__bench, window.__media, from), t0);
      if (completed === null) faultedDelivery.complete = false;
    }
    let disconnected = await isDisconnected(firstReply === null ? 5000 : 500);
    // Follow-up turn: does the session recover once the injected fault is spent?
    let secondReply = null, secondEnd = null, recoveryDelivery = null;
    if (!disconnected) {
      const recoveryStart = await now();
      const second = await page.evaluate(() => window.__speak([[1200, 0]]));
      secondEnd = second[0][1];
      secondReply = await nextOnset(second[0][0], 15000);
      if (secondReply !== null) {
        const completed = await responseEnd(secondReply, 700, 20000, null, recoveryStart);
        recoveryDelivery = await page.evaluate(from => window.__replyDelivery(window.__bench, window.__media, from), recoveryStart);
        if (completed === null) recoveryDelivery.complete = false;
      }
      disconnected = await isDisconnected(500);
    }
    const at = await now();
    const after = await mockCounters();
    const outcome = firstReply !== null ? (disconnected ? 'reply_then_closed' : 'reply_delivered')
      : disconnected ? 'session_closed' : secondReply !== null && recoveryDelivery?.complete ? 'turn_dropped_then_recovered' : 'turn_dropped_no_recovery';
    const record = { case: `${kind}_${mode}`, iteration, outcome, greetingConfirmed: true, faultedDelivery, recoveryDelivery,
      browser: { faultedTurnFirstAudioMs: firstReply === null ? null : firstReply - firstEnd, recoveryTurnFirstAudioMs: secondReply === null ? null : secondReply - secondEnd },
      worker: workerStages(await eventsBetween(t0 - 1, at + 1000)),
      mockDelta: Object.fromEntries(COUNTER_KEYS.map(k => [k, (after[k] ?? 0) - (before[k] ?? 0)])) };
    await control({ kind, mode: 'ok', count: 0 });
    await stopSession();
    return record;
  };
  // Session-level reliability evidence from worker events (worker clock only).
  const sessionDiagnostics = events => {
    const stalls = events.filter(e => e.e === 'loop_stall').map(e => e.ms);
    const end = events.find(e => e.e === 'session_end');
    const greetingDone = events.find(e => e.e === 'greeting_done');
    return { loopStalls: stalls.length, loopStallMaxMs: stalls.length ? Math.max(...stalls) : 0,
      heartbeatLate: events.filter(e => e.e === 'heartbeat_late').length,
      heartbeatMaxGapMs: Math.max(0, ...events.filter(e => e.e === 'heartbeat_late').map(e => e.gapMs)),
      heartbeatRetries: events.filter(e => e.e === 'heartbeat_retry').length,
      // Any session_end received while the browser is still connected is a premature close.
      prematureEnd: end ? Object.keys(end).find(k => !['e', 't', 'rx', 'correlation'].includes(k)) ?? 'unknown' : null,
      greetingDoneSeen: Boolean(greetingDone), greetingInterrupted: greetingDone?.interrupted ?? null, _greetingDoneT: greetingDone?.t,
      publication: Object.fromEntries(['publication_started', 'publication_resolved', 'publication_rejected', 'publication_timeout', 'subscription_timeout', 'subscription_ready'].map(name => [name, events.find(e => e.e === name)?.t ?? null])),
      publicationToSubscriptionMs: (() => { const p = events.find(e => e.e === 'publication_resolved'), s = events.find(e => e.e === 'subscription_ready'); return p && s ? s.t - p.t : null; })(),
      agentTrackPublished: events.some(e => e.e === 'agent_track_published'), agentTrackSubscribed: events.some(e => e.e === 'agent_track_subscribed') };
  };
  const FIRST_TURN_GAPS = [150, 600, 1500];
  const firstTurnSession = async iteration => {
    const gapMs = FIRST_TURN_GAPS[(iteration - 1) % FIRST_TURN_GAPS.length];
    const from = await now();
    const started = await startSession(120);
    const session = { case: 'first_turn_session', iteration, gapMs, retried: Boolean(started.retried),
      outcome: started.ok ? (started.retried ? 'ok_after_no_greeting_retry' : 'ok') : started.reason, browser: started.ok ? { connectToGreetingMs: started.connectToGreetingMs, greetingOnMs: started.greetingOn, greetingEndMs: started.greetingEnd } : {} };
    session.media = await page.evaluate(from => window.__media.filter(e => e.t >= from), from);
    if (!started.ok) { session.stages = await eventsBetween(from, await now()); session.diagnostics = sessionDiagnostics(session.stages); await stopSession(); return [session]; }
    await page.waitForTimeout(Math.max(0, started.greetingEnd + gapMs - await now()));
    // Mock STT counters around each turn: did the recognizer receive loud audio and emit results?
    const sttDelta = async work => {
      const before = await mockCounters(); const record = await work(); const after = await mockCounters();
      return { ...record, sttDelta: Object.fromEntries(STT_KEYS.map(k => [k, (after[k] ?? 0) - (before[k] ?? 0)])) };
    };
    const first = { ...(await sttDelta(() => turn('first_turn', [[1200, 0]]))), iteration, gapMs };
    first.browser.actualGreetingGapMs = first.browser.speechStartMs - started.greetingEnd;
    const second = { ...(await sttDelta(() => turn('second_turn', [[1200, 0]]))), iteration, gapMs };
    const d = sessionDiagnostics(await eventsBetween(from, await now()));
    // Did the user start speaking (worker VAD) before the worker finished greeting playout?
    const firstSpeech = (await eventsBetween(from, await now())).find(e => e.e === 'user_speaking');
    d.userBeforeGreetingDone = d._greetingDoneT !== undefined && firstSpeech ? firstSpeech.t < d._greetingDoneT : null;
    delete d._greetingDoneT;
    session.diagnostics = d;
    session.stages = await eventsBetween(from, await now());
    session.media = await page.evaluate(from => window.__media.filter(e => e.t >= from), from);
    await stopSession();
    return [session, first, second];
  };
  await control({ reset: true });
  for (let i = 0; i < config.warmupSessions; i++) await run(false, -1 - i, false);
  for (let i = 0; i < config.firstTurnSessions; i++) {
    const createdBefore = sessionCount();
    let records;
    try { records = await firstTurnSession(i + 1); }
    catch {
      records = [{ case: 'first_turn_session', iteration: i + 1, outcome: 'harness_error', browser: {}, worker: {} }];
      await stopSession().catch(() => undefined);
    }
    samples.push(...records);
    const sessionRecord = records.find(record => record.case === 'first_turn_session');
    if (sessionRecord) sessionRecord.genuineSession = sessionCount() > createdBefore;
    // Retain completed attempts even if a subsequent attempt or report generation crashes.
    if (!LIVE) await appendFile(attemptLedger, JSON.stringify({ attempt: i + 1, records }) + '\n');
    if (page.isClosed() || sessionRecord?.outcome === 'harness_error') break; // Remaining planned attempts were not executed.
  }
  const retain = async (group, iteration, work) => {
    const before = sessionCount();
    let records;
    try { const value = await work(); records = Array.isArray(value) ? value : [value]; }
    catch { records = [{ case: group, iteration, outcome: 'harness_error' }]; await stopSession().catch(() => undefined); }
    const session = records.find(r => r.case === 'session') ?? records[0];
    session.genuineSession = sessionCount() - before === 1;
    session.createdAttempts = sessionCount() - before;
    samples.push(...records);
    if (!LIVE) await appendFile(attemptLedger, JSON.stringify({ group, iteration, records }) + '\n');
  };
  for (let i = 0; i < config.repeatSessions; i++) await retain('session', i + 1, () => run(false, i + 1, true));
  for (let i = 0; i < config.mixedSessions; i++) await retain('session', i + 1, () => run(true, i + 1, true));
  for (let i = 0; i < config.failureRuns; i++) {
    await retain('tts_refuse', i + 1, () => failure('tts', 'refuse', i + 1));
    await retain('tts_stall', i + 1, () => failure('tts', 'stall', i + 1));
    await retain('stt_drop', i + 1, () => failure('stt', 'drop', i + 1));
  }
  const mock = LIVE ? null : await context.request.get(`${MOCKS}/metrics`).then(response => response.json()).catch(() => ({}));
  const report = summarize(samples, { config, tuning, mock, chromium: page.context().browser()?.version() });
  await mkdir('/app/bench-out', { recursive: true });
  const stamp = report.timestamp.replace(/[:.]/g, '-');
  // Manual-live output keeps aggregates only.
  const name = `${LIVE ? 'live-' : ''}${config.label}-${stamp}`;
  if (LIVE) delete report.records;
  await writeFile(`/app/bench-out/${name}.json`, JSON.stringify(report, null, 2));
  await writeFile(`/app/bench-out/${name}.md`, markdown(report));
  console.log(`BENCH wrote ${name}.json (${samples.length} records)`);
  console.log(markdown(report));
}
function int(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
// Intervals between worker events use only worker-clock timestamps (`t`).
function workerStages(events) {
  const first = (name, after = -Infinity, pred = () => true) => events.find(e => e.e === name && e.t >= after && pred(e));
  const last = (name, before, after = -Infinity) => events.filter(e => e.e === name && e.t <= before && e.t >= after).at(-1);
  const out = { counts: {} };
  for (const e of events) out.counts[e.e] = (out.counts[e.e] ?? 0) + 1;
  out.counts.llm_cancelled = events.filter(e => e.e === 'llm_end' && e.cancelled).length;
  out.counts.tts_cancelled = events.filter(e => e.e === 'tts_end' && e.cancelled).length;
  // TTS streams that ended without a single audio frame (provider stalled or refused).
  const silentEnds = events.filter(e => e.e === 'tts_end' && !e.cancelled).filter(end => {
    const start = events.filter(e => e.e === 'tts_start' && e.t <= end.t).at(-1);
    return start && !events.some(e => e.e === 'tts_first_audio' && e.t >= start.t && e.t <= end.t);
  });
  out.counts.tts_no_audio = silentEnds.length;
  if (silentEnds.length) {
    const end = silentEnds[0], auth = events.filter(e => e.e === 'tts_authorized' && e.t <= end.t).at(-1);
    if (auth) out.ttsNoAudioGiveUpMs = end.t - auth.t;
  }
  const speaking = first('user_speaking');
  const interim = speaking && first('stt_interim', speaking.t);
  if (interim) out.sttFirstInterimMs = interim.t - speaking.t;
  const tts = first('tts_start', speaking?.t ?? -Infinity);
  if (tts) {
    const ttsEnd = first('tts_end', tts.t)?.t ?? Infinity;
    const eou = last('eou', tts.t);
    if (eou) { out.transcriptionDelayMs = eou.transcriptionDelayMs; out.endOfTurnDelayMs = eou.endOfUtteranceDelayMs; }
    const llmStart = last('llm_start', tts.t);
    if (llmStart) {
      const llmFirst = first('llm_first', llmStart.t), llmEnd = first('llm_end', llmStart.t);
      const final = last('stt_final', llmStart.t);
      if (llmFirst) { out.llmFirstTokenMs = llmFirst.t - llmStart.t; if (final) out.finalToLlmFirstTokenMs = llmFirst.t - final.t; }
      if (llmEnd && !llmEnd.cancelled) out.llmTotalMs = llmEnd.t - llmStart.t;
      const ttsAudio = first('tts_first_audio', tts.t, e => e.t <= ttsEnd);
      if (llmFirst && ttsAudio) out.llmFirstToTtsAudioMs = ttsAudio.t - llmFirst.t;
    }
    const authorized = first('tts_authorized', tts.t, e => e.t <= ttsEnd), audio = first('tts_first_audio', tts.t, e => e.t <= ttsEnd);
    if (authorized) out.ttsAuthorizeMs = authorized.t - tts.t;
    if (authorized && audio) out.ttsFirstAudioMs = audio.t - authorized.t;
    const spoke = first('agent_speaking', tts.t);
    if (eou && spoke) out.eouToAgentSpeakingMs = spoke.t - eou.t;
  }
  // Barge-in: user speech that starts while the agent is still speaking (no listening state between).
  const agentOn = first('agent_speaking', speaking?.t ?? -Infinity);
  const nextBarge = agentOn && first('user_speaking', agentOn.t);
  const barge = nextBarge && !events.some(e => e.e === 'agent_listening' && e.t >= agentOn.t && e.t <= nextBarge.t) ? nextBarge : undefined;
  const cancel = barge && first('tts_end', barge.t, e => e.cancelled);
  if (cancel) out.interruptToTtsCancelMs = cancel.t - barge.t;
  // Barge-in pauses (or interrupts) playout: the SDK moves the agent to listening.
  const stopped = barge && first('agent_listening', barge.t);
  if (barge) out.agentSpeakingToBargeDetectMs = barge.t - agentOn.t;
  if (stopped) out.bargeToAgentListeningMs = stopped.t - barge.t;
  return out;
}
function stats(values, minN) {
  const v = values.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  const q = p => v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)];
  const r = x => x === undefined ? null : Math.round(x);
  return { n: v.length, p50: v.length >= minN.p50 ? r(q(0.5)) : null, p90: v.length >= minN.p90 ? r(q(0.9)) : null, p95: v.length >= minN.p95 ? r(q(0.95)) : null,
    min: r(v[0]), max: r(v.at(-1)), mean: v.length ? r(v.reduce((a, b) => a + b, 0) / v.length) : null };
}
const MIN_N = { p50: 5, p90: 10, p95: 20 };
const DEFINITIONS = {
  'browser.connectToGreetingMs': 'Browser clock: room connected (status Connected observed) -> first greeting audio. Includes job dispatch, worker process availability, claim and greeting synthesis.',
  'browser.e2eFirstAudioMs': 'Browser clock: synthetic speech gate closes (end of user speech at the source) -> first agent audio sample above threshold in the subscribed track.',
  'browser.playbackMs': 'Browser clock: agent audio onset -> last audible sample of the reply (gaps under 400 ms belong to the reply).',
  'browser.gaps': 'Browser clock: silent gaps of 30-400 ms inside one reply (mock TTS is continuous tone, so each gap is starvation).',
  'browser.audibleMs': 'Browser clock: total audible agent audio in the reply (false-interruption case: detects truncation).',
  'browser.interruptStopMs': 'Browser clock: interrupting speech starts -> last audible sample of the obsolete reply.',
  'browser.afterInterruptFirstAudioMs': 'Browser clock: interrupting speech ends -> first audio of the reply to it.',
  'browser.faultedTurnFirstAudioMs': 'Browser clock (fault cases): end of the user turn that hits the injected fault -> first agent audio (missing = turn dropped).',
  'browser.recoveryTurnFirstAudioMs': 'Browser clock (fault cases): end of the follow-up user turn -> first agent audio (missing = no recovery).',
  'worker.sttFirstInterimMs': 'Worker clock: VAD user_speaking -> first STT interim (or final) transcript event.',
  'worker.transcriptionDelayMs': 'Worker, SDK EOU metric: end of user speech -> final transcript.',
  'worker.endOfTurnDelayMs': 'Worker, SDK EOU metric: end of user speech -> turn committed.',
  'worker.finalToLlmFirstTokenMs': 'Worker clock: last final transcript before the LLM request -> first LLM text chunk received by the worker.',
  'worker.llmFirstTokenMs': 'Worker clock: llmNode request start -> first LLM text chunk (includes the worker->API hop).',
  'worker.llmTotalMs': 'Worker clock: llmNode request start -> stream completion (non-cancelled only).',
  'worker.llmFirstToTtsAudioMs': 'Worker clock: first LLM text chunk -> first synthesized audio frame (includes turn commit wait when generation was preemptive).',
  'worker.ttsAuthorizeMs': 'Worker clock: ttsNode start -> Dialog operation admission granted.',
  'worker.ttsFirstAudioMs': 'Worker clock: admission granted -> first synthesized audio frame (connection, config, text tokenization, synthesis).',
  'worker.eouToAgentSpeakingMs': 'Worker clock: EOU metrics emitted (turn committed) -> agent state speaking (audio playout started).',
  'worker.interruptToTtsCancelMs': 'Worker clock: user_speaking during agent speech -> obsolete TTS stream cancelled (absent when synthesis already finished).',
  'worker.agentSpeakingToBargeDetectMs': 'Worker clock: agent speaking -> VAD detects the interrupting user speech (synthetic barge-in starts ~1200 ms after reply onset).',
  'worker.bargeToAgentListeningMs': 'Worker clock: VAD barge-in -> agent state listening (playout paused or interrupted).',
  'worker.ttsNoAudioGiveUpMs': 'Worker clock (fault cases): admission granted -> TTS stream ended without producing any audio.',
};
function summarize(samples, meta) {
  const metrics = {};
  const byCase = {};
  for (const s of samples) (byCase[s.case] ??= []).push(s);
  for (const [name, recs] of Object.entries(byCase)) {
    const m = {};
    for (const key of Object.keys(DEFINITIONS)) {
      const [domain, field] = key.split('.');
      const values = recs.map(r => r[domain]?.[field]);
      if (values.some(v => typeof v === 'number')) m[key] = { ...stats(values, MIN_N), missing: values.filter(v => typeof v !== 'number').length };
    }
    const outcomes = {}; for (const r of recs) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    const counts = {}; for (const r of recs) for (const [k, v] of Object.entries(r.worker?.counts ?? {})) counts[k] = (counts[k] ?? 0) + v;
    const falseInterruption = {}; for (const r of recs) if (r.falseInterruption) falseInterruption[r.falseInterruption] = (falseInterruption[r.falseInterruption] ?? 0) + 1;
    const mockDelta = {}; for (const r of recs) for (const [k, v] of Object.entries(r.mockDelta ?? {})) mockDelta[k] = (mockDelta[k] ?? 0) + v;
    const diag = recs.filter(r => r.diagnostics).map(r => r.diagnostics);
    const tally = list => list.reduce((o, k) => ({ ...o, [k]: (o[k] ?? 0) + 1 }), {});
    const diagnostics = diag.length ? { sessions: diag.length, retried: recs.filter(r => r.retried).length,
      prematureEnd: tally(diag.map(d => d.prematureEnd).filter(Boolean)), loopStallOver1s: diag.filter(d => d.loopStallMaxMs > 1000).length,
      loopStallMaxMs: Math.max(0, ...diag.map(d => d.loopStallMaxMs)), heartbeatLateSessions: diag.filter(d => d.heartbeatLate > 0).length,
      heartbeatMaxGapMs: Math.max(0, ...diag.map(d => d.heartbeatMaxGapMs)), heartbeatRetries: diag.reduce((n, d) => n + (d.heartbeatRetries ?? 0), 0), greetingDoneMissing: diag.filter(d => !d.greetingDoneSeen).length,
      userBeforeGreetingDone: diag.filter(d => d.userBeforeGreetingDone === true).length,
      sessionMaxMs: Math.max(0, ...recs.map(r => r.browser?.sessionMs ?? 0)) } : undefined;
    metrics[name] = { records: recs.length, outcomes, workerEventCounts: counts, ...(Object.keys(falseInterruption).length ? { falseInterruption } : {}),
      ...(Object.keys(mockDelta).length ? { mockProviderDelta: mockDelta } : {}), ...(diagnostics ? { diagnostics } : {}), metrics: m };
  }
  const { tuning } = meta;
  return {
    schema: 'dialog-voice-latency/1', timestamp: new Date().toISOString(), label: meta.config.label,
    providerMode: meta.config.providerMode, method: 'LiveKit room media: headless Chromium <-> local LiveKit <-> Dialog worker; ' + (meta.config.providerMode === 'mock' ? 'deterministic mock STT/LLM/TTS' : 'manual-live providers'),
    environment: { node: process.version, chromium: meta.chromium, platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length, memoryGb: Math.round(os.totalmem() / 2 ** 30) },
    configuration: { tuning: tuning ? { sttEndpointingMs: tuning.sttEndpointingMs, endpointingMinMs: tuning.endpointingMinMs, endpointingMaxMs: tuning.endpointingMaxMs, preemptiveLlm: tuning.preemptiveLlm, ttsIdleTimeoutMs: tuning.ttsIdleTimeoutMs } : null,
      iterations: meta.config, ...(meta.config.providerMode === 'mock' ? { mockLlmChunkMs: 20, mockTtsMsPerCharacter: 55 } : { input: 'operator-recorded speech clip (content not recorded)' }),
      percentileMinimumSamples: MIN_N },
    definitions: DEFINITIONS, mockProviderCounters: meta.mock, cases: metrics, records: samples,
  };
}
function markdown(report) {
  const lines = [`# Voice latency benchmark — ${report.label}`, '', `- Timestamp: ${report.timestamp}`, `- Method: ${report.method}`, `- Provider mode: **${report.providerMode}**`,
    `- Environment: ${JSON.stringify(report.environment)}`, `- Tuning: ${JSON.stringify(report.configuration.tuning)}`,
    `- Percentiles need at least ${report.configuration.percentileMinimumSamples.p50}/${report.configuration.percentileMinimumSamples.p90}/${report.configuration.percentileMinimumSamples.p95} samples for p50/p90/p95; otherwise "n/a".`, ''];
  for (const [name, c] of Object.entries(report.cases)) {
    lines.push(`## ${name} (${c.records} records)`, '', `Outcomes: ${JSON.stringify(c.outcomes)}${c.falseInterruption ? ` · false interruption: ${JSON.stringify(c.falseInterruption)}` : ''}`, '',
      ...(c.diagnostics ? [`Diagnostics: ${JSON.stringify(c.diagnostics)}`, ''] : []),
      '| Metric | n | missing | p50 | p90 | p95 | min | max |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const [k, s] of Object.entries(c.metrics)) lines.push(`| ${k} | ${s.n} | ${s.missing} | ${s.p50 ?? 'n/a'} | ${s.p90 ?? 'n/a'} | ${s.p95 ?? 'n/a'} | ${s.min ?? 'n/a'} | ${s.max ?? 'n/a'} |`);
    const counts = c.workerEventCounts;
    lines.push('', `Worker work counts: llm_start=${counts.llm_start ?? 0}, llm_cancelled=${counts.llm_cancelled ?? 0}, tts_start=${counts.tts_start ?? 0}, tts_cancelled=${counts.tts_cancelled ?? 0}, tts_no_audio=${counts.tts_no_audio ?? 0}, false_interruption=${counts.false_interruption ?? 0}, error=${counts.error ?? 0}`, ...(c.mockProviderDelta ? ['', `Mock provider counter delta: ${JSON.stringify(c.mockProviderDelta)}`] : []), '');
  }
  return lines.join('\n');
}
await main();
