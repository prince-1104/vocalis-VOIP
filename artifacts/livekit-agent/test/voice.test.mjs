import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeLogger, voice } from '@livekit/agents';
import { LocalAudioTrack } from '@livekit/rtc-node';
initializeLogger({ level: 'silent', pretty: false });
// Inside the package so the external @livekit/agents import resolves from its node_modules.
const output = await mkdtemp(path.resolve('test', '.voice-build-'));
const modules = {};
try {
  for (const name of ['sentences', 'voice-tuning', 'bench', 'media-readiness', 'process-readiness', 'audio-diagnostics']) {
    await build({ entryPoints: [`src/${name}.ts`], outfile: path.join(output, `${name}.mjs`), bundle: true, platform: 'node', format: 'esm', packages: 'external' });
    modules[name] = await import(pathToFileURL(path.join(output, `${name}.mjs`)).href);
  }
} finally { await rm(output, { recursive: true, force: true }); }
const { splitSentences, DialogSentenceTokenizer } = modules.sentences;
const { voiceTuning, baselineTuning, defaultTuning } = modules['voice-tuning'];
const { StageClock } = modules.bench;
const { observePublication } = modules['media-readiness'];
const { ProcessReadiness } = modules['process-readiness'];
const { observeAudioPipeline } = modules['audio-diagnostics'];

test('audio probes preserve source/track/frame ownership, errors and bounded numeric diagnostics', async () => {
  const events = [], frames = [], controller = new AbortController();
  const clock = { now: () => performance.now(), mark: (e, fields = {}) => { events.push({ e, ...fields }); return performance.now(); } };
  let clears = 0, rejected = false;
  const failure = new Error('private provider detail must never enter diagnostics');
  const source = { captureFrame: async frame => { if (rejected) throw failure; frames.push(frame); }, clearQueue: () => { clears++; }, waitForPlayout: async () => {} };
  const frame = { data: Int16Array.from([0, 7000, -7000]), samplesPerChannel: 3, sampleRate: 24000, channels: 1 };
  const track = {}, factory = LocalAudioTrack.createAudioTrack, capture = source.captureFrame;
  LocalAudioTrack.createAudioTrack = (_name, value) => { assert.equal(value, source); return track; };
  const probe = observeAudioPipeline(clock, controller.signal);
  try {
    assert.equal(LocalAudioTrack.createAudioTrack('private track name', source), track);
    probe.published(track);
    class Sink extends voice.AudioOutput {
      async captureFrame(frame) { await super.captureFrame(frame); await source.captureFrame(frame); }
      clearBuffer() { source.clearQueue(); }
    }
    const sink = new Sink(24000); probe.output(sink);
    await sink.captureFrame(frame);
    assert.equal(frames[0], frame, 'observer must forward the original frame once');
    assert.equal(events.find(event => event.e === 'published_source_link').matched, true);
    assert.equal(events.find(event => event.e === 'source_captured').completed, 1);
    rejected = true;
    await assert.rejects(sink.captureFrame(frame), error => error === failure);
    assert.ok(events.some(event => event.e === 'source_capture_error'));
    for (let i = 0; i < 2500; i++) sink.clearBuffer();
    assert.equal(clears, 2500, 'buffer cleanup must continue when diagnostics are full');
    assert.ok(events.length <= 2000);
    for (const event of events) for (const [key, value] of Object.entries(event))
      assert.ok(key === 'e' ? typeof value === 'string' : typeof value === 'number' || typeof value === 'boolean');
    assert.equal(JSON.stringify(events).includes('private'), false);
  } finally { probe.dispose(); LocalAudioTrack.createAudioTrack = factory; }
  assert.equal(source.captureFrame, capture);
});

test('cold admission rejects before prewarm, reserves once, and discards dead processes', () => {
  const live = new Set([10, 11]);
  const pool = new ProcessReadiness(pid => live.has(pid));
  assert.equal(pool.reserve(), false);
  assert.equal(pool.register(10), true);
  assert.equal(pool.reserve(), true);
  assert.equal(pool.reserve(), false, 'two dispatches cannot reserve one ready process');
  assert.equal(pool.register(11), true); live.delete(11);
  assert.equal(pool.available(), false);
  assert.equal(pool.register(-1), false);
  assert.equal(pool.register(12), false);
});

test('publication readiness observes resolution independently of room events and waits for subscription', async () => {
  const events = [], controller = new AbortController();
  let subscribed;
  const subscription = new Promise(resolve => { subscribed = resolve; });
  let calls = 0;
  const participant = { async publishTrack() { calls++; return { waitForSubscription: () => subscription }; } };
  const original = participant.publishTrack;
  const guard = observePublication(participant, e => events.push(e), controller.signal, 1000);
  await participant.publishTrack();
  assert.deepEqual(events, ['audio_track_created', 'publication_started', 'publication_resolved']);
  subscribed(); await guard.ready;
  assert.equal(events.at(-1), 'subscription_ready');
  await assert.rejects(participant.publishTrack(), /publication_rejected/);
  assert.equal(calls, 1);
  guard.dispose(); assert.equal(participant.publishTrack, original);
});

test('hung publication and subscription fail boundedly; late publication cannot make readiness succeed', async () => {
  for (const hang of ['publication', 'subscription']) {
    let published;
    const pending = new Promise(resolve => { published = resolve; });
    const publication = { waitForSubscription: () => new Promise(() => {}) };
    const participant = { publishTrack: () => hang === 'publication' ? pending : Promise.resolve(publication) };
    const events = [], controller = new AbortController();
    const guard = observePublication(participant, e => events.push(e), controller.signal, 20);
    const attempt = participant.publishTrack();
    await assert.rejects(guard.ready, /media_timeout/);
    published(publication); await attempt;
    assert.equal(events.filter(e => e === (hang === 'publication' ? 'publication_timeout' : 'subscription_timeout')).length, 1);
    assert.ok(!events.includes('subscription_ready'));
    guard.dispose();
  }
});

test('readiness timeout distinguishes an SDK that never invoked publication from a pending promise', async () => {
  let calls = 0;
  const participant = { async publishTrack() { calls++; return { async waitForSubscription() {} }; } };
  const events = [], controller = new AbortController();
  const guard = observePublication(participant, (event, state) => events.push({ event, state }), controller.signal, 20);
  await assert.rejects(guard.ready, /media_timeout/);
  assert.deepEqual(events, [{ event: 'publication_timeout', state: { started: false, published: false } }]);
  assert.equal(calls, 0);
  guard.dispose();
});

test('publication rejection and cancellation settle once without retries', async () => {
  for (const rejected of [true, false]) {
    const controller = new AbortController(), events = [];
    const participant = { async publishTrack() { if (rejected) throw new Error('private SDK detail'); return { waitForSubscription: () => new Promise(() => {}) }; } };
    const guard = observePublication(participant, e => events.push(e), controller.signal, 1000);
    await participant.publishTrack().catch(() => undefined);
    if (!rejected) controller.abort();
    await assert.rejects(guard.ready, rejected ? /publication_rejected/ : /media_cancelled/);
    guard.dispose();
    assert.ok(!events.includes('publication_timeout'));
  }
});

test('publication timeout triggers one teardown and disconnect cancellation releases the pending call', async () => {
  const controller = new AbortController();
  let cleanupCount = 0, calls = 0;
  const participant = { publishTrack() {
    calls++;
    return new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('disconnected')), { once: true }));
  } };
  const original = participant.publishTrack;
  const guard = observePublication(participant, () => {}, controller.signal, 20);
  const cleanup = guard.ready.catch(() => { cleanupCount++; controller.abort(); guard.dispose(); });
  const publishing = participant.publishTrack();
  await cleanup;
  await assert.rejects(publishing, /disconnected/);
  assert.equal(calls, 1);
  assert.equal(cleanupCount, 1);
  assert.equal(participant.publishTrack, original);
  await assert.rejects(guard.ready, /media_timeout/);
});

const LONG = 'Your order total is Rs. 1,250.50 and it ships on 12.05.2026. Dr. Rao will call at 3.30 p.m. to confirm the delivery window. '
  + 'You can track it at https://dialog.example.com/track?id=4 at any time. Is there anything else I can help you with today?';
const HINDI = 'आपका ऑर्डर तैयार है। क्या मैं आपकी और मदद कर सकती हूँ? धन्यवाद!';

test('sentence boundaries keep currency, numbers, dates, abbreviations and URLs intact', () => {
  assert.deepEqual(splitSentences(LONG).map(s => s[0]), [
    'Your order total is Rs. 1,250.50 and it ships on 12.05.2026.',
    'Dr. Rao will call at 3.30 p.m. to confirm the delivery window.',
    'You can track it at https://dialog.example.com/track?id=4 at any time.',
    'Is there anything else I can help you with today?',
  ]);
  assert.deepEqual(splitSentences('Order No. 42 is ready. Pay Rs.500 today! Thanks.').map(s => s[0]), ['Order No. 42 is ready.', 'Pay Rs.500 today!', 'Thanks.']);
  assert.deepEqual(splitSentences('Meet Smt. Iyer at 10 a.m. tomorrow. She agreed.').map(s => s[0]), ['Meet Smt. Iyer at 10 a.m. tomorrow.', 'She agreed.']);
});
test('Devanagari danda ends a sentence so Hindi replies reach synthesis without waiting for the next "?"', () => {
  assert.deepEqual(splitSentences(HINDI).map(s => s[0]), ['आपका ऑर्डर तैयार है।', 'क्या मैं आपकी और मदद कर सकती हूँ?', 'धन्यवाद!']);
});
test('offsets let the buffered stream consume exactly the emitted text', () => {
  for (const text of [LONG, HINDI, 'Hi. Ok.  Then\nwe go.']) {
    for (const [sentence, start, end] of splitSentences(text)) {
      assert.equal(text.slice(start, end).replace(/\s+/g, ' ').trim(), sentence);
    }
  }
  assert.deepEqual(splitSentences('Hi. Ok. Fine.').map(s => s[0]), ['Hi. Ok. Fine.'], 'short sentences merge up to the minimum length');
});
async function streamed(text) {
  const stream = new DialogSentenceTokenizer().stream();
  const tokens = []; let pushed = 0, firstAt;
  const consumer = (async () => { for await (const ev of stream) { firstAt ??= pushed; tokens.push(ev.token); } })();
  const words = text.match(/\S+\s*/g);
  for (const word of words) { stream.pushText(word); pushed++; await new Promise(r => setImmediate(r)); }
  stream.endInput(); await consumer;
  return { tokens, firstAt, words: words.length };
}
test('streaming tokenizer emits the first sentence incrementally without losing or duplicating text', async () => {
  for (const text of [LONG, HINDI]) {
    const { tokens, firstAt, words } = await streamed(text);
    assert.ok(firstAt < words, 'first sentence emitted before the reply finished');
    assert.equal(tokens.join(' '), text.replace(/\s+/g, ' ').trim());
  }
  const { tokens } = await streamed(LONG);
  assert.equal(tokens[0], 'Your order total is Rs. 1,250.50 and it ships on 12.05.2026.');
  assert.ok(!tokens.some(t => t.endsWith('track?')), 'URL query string is not split');
});
test('voice tuning defaults are the measured baseline unless evidence changed them; invalid values fail closed without echoing input', () => {
  assert.deepEqual(voiceTuning({}), { ...defaultTuning });
  assert.deepEqual(defaultTuning, baselineTuning, 'no Phase 1R tuning experiment beat the baseline without a quality regression');
  assert.equal(Object.isFrozen(baselineTuning), true);
  assert.deepEqual(voiceTuning({ DIALOG_VOICE_STT_ENDPOINTING_MS: '300', DIALOG_VOICE_ENDPOINTING_MIN_MS: '200', DIALOG_VOICE_ENDPOINTING_MAX_MS: '2500',
    DIALOG_VOICE_PREEMPTIVE_LLM: 'off', DIALOG_VOICE_TTS_IDLE_TIMEOUT_MS: '4000' }),
    { sttEndpointingMs: 300, endpointingMinMs: 200, endpointingMaxMs: 2500, preemptiveLlm: false, ttsIdleTimeoutMs: 4000, aecWarmupMs: null });
  // Unset keeps the SDK's participant-aware AEC warmup (none for outbound SIP); explicit values override it.
  assert.equal(baselineTuning.aecWarmupMs, null);
  assert.equal(voiceTuning({ DIALOG_VOICE_AEC_WARMUP_MS: '0' }).aecWarmupMs, 0);
  assert.equal(voiceTuning({ DIALOG_VOICE_AEC_WARMUP_MS: '1500' }).aecWarmupMs, 1500);
  for (const [name, value] of [['DIALOG_VOICE_STT_ENDPOINTING_MS', '5'], ['DIALOG_VOICE_STT_ENDPOINTING_MS', '300ms'], ['DIALOG_VOICE_ENDPOINTING_MIN_MS', '-1'],
    ['DIALOG_VOICE_ENDPOINTING_MAX_MS', '9000'], ['DIALOG_VOICE_PREEMPTIVE_LLM', 'yes'], ['DIALOG_VOICE_TTS_IDLE_TIMEOUT_MS', '500'], ['DIALOG_VOICE_TTS_IDLE_TIMEOUT_MS', 'sentinel-secret'],
    ['DIALOG_VOICE_AEC_WARMUP_MS', '5000'], ['DIALOG_VOICE_AEC_WARMUP_MS', 'off']]) {
    assert.throws(() => voiceTuning({ [name]: value }), e => e.message === `Invalid voice tuning: ${name}` && !e.message.includes(value));
  }
  assert.throws(() => voiceTuning({ DIALOG_VOICE_ENDPOINTING_MIN_MS: '1500', DIALOG_VOICE_ENDPOINTING_MAX_MS: '1000' }));
});
test('manual-live benchmark fails closed before any container or provider request and never prints key values', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dialog-live-bench-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = path.join(root, '.local', 'livekit');
  await mkdir(path.join(root, 'scripts'), { recursive: true }); await mkdir(path.join(local, 'bench'), { recursive: true });
  await copyFile(path.resolve('../../scripts/voice-local.mjs'), path.join(root, 'scripts', 'voice-local.mjs'));
  await writeFile(path.join(local, 'api.env'), 'NODE_ENV=development\n');
  // An empty PATH means a precondition bug would surface as a Docker failure, never a real run.
  const run = env => spawnSync(process.execPath, [path.join(root, 'scripts', 'voice-local.mjs'), 'bench-live'], { env: { PATH: '', ...env }, encoding: 'utf8' });
  const expectRefusal = (env, pattern) => {
    const result = run(env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, pattern);
    assert.doesNotMatch(result.stdout + result.stderr, /sentinel-value|Docker operation|at most \d+ user turns/);
  };
  expectRefusal({}, /requires DIALOG_VOICE_LIVE_BENCH=paid-providers/);
  const live = { DIALOG_VOICE_LIVE_BENCH: 'paid-providers' };
  expectRefusal(live, /DEEPGRAM_API_KEY and SARVAM_API_KEY/);
  await writeFile(path.join(local, 'manual-worker.env'), 'DEEPGRAM_API_KEY=\nSARVAM_API_KEY=sentinel-value\n');
  expectRefusal(live, /DEEPGRAM_API_KEY and SARVAM_API_KEY/);
  await writeFile(path.join(local, 'manual-worker.env'), 'DEEPGRAM_API_KEY=sentinel-value\nSARVAM_API_KEY=sentinel-value\n');
  expectRefusal(live, /LLM key/);
  await writeFile(path.join(local, 'manual-api.env'), 'OPENAI_API_KEY=sentinel-value\n');
  expectRefusal(live, /recorded speech clip/);
  await writeFile(path.join(local, 'bench', 'live-utterance.wav'), Buffer.alloc(4000));
  expectRefusal({ ...live, VOICE_BENCH_ITERATIONS: '9' }, /VOICE_BENCH_ITERATIONS must be at most 3/);
  expectRefusal({ ...live, VOICE_BENCH_REPEAT_SESSIONS: '-1' }, /VOICE_BENCH_REPEAT_SESSIONS must be at most 2/);
});
test('stage clock publishes only event names and numbers, drops invalid durations and batches observations', async () => {
  const published = [], batches = [];
  const clock = new StageClock('mock', async payload => { published.push(JSON.parse(new TextDecoder().decode(payload))); }, async batch => { batches.push(batch); });
  const start = clock.mark('llm_start');
  clock.mark('eou', { transcriptionDelayMs: 12, endOfUtteranceDelayMs: 500 });
  await new Promise(r => setImmediate(r));
  for (const event of published) for (const [key, value] of Object.entries(event)) {
    assert.ok(key === 'e' ? typeof value === 'string' : typeof value === 'number' || typeof value === 'boolean');
  }
  assert.ok(clock.mark('llm_first') >= start, 'monotonic clock');
  clock.observe('llm_first_token', 'internal', 'success', 42.04);
  clock.observe('llm_first_token', 'internal', 'success', -1);
  clock.observe('llm_first_token', 'internal', 'success', Number.NaN);
  await clock.flush();
  assert.deepEqual(batches, [[{ stage: 'llm_first_token', provider: 'internal', mode: 'mock', outcome: 'success', ms: 42 }]]);
  const failing = new StageClock('mock', undefined, async () => { throw new Error('offline'); });
  failing.observe('tts_total', 'sarvam', 'cancelled', 10);
  await failing.flush();
});
