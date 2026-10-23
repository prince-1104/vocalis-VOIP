import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeLogger } from '@livekit/agents';
initializeLogger({ level: 'silent', pretty: false });
// Inside the package so the external @livekit/agents import resolves from its node_modules.
const output = await mkdtemp(path.resolve('test', '.voice-build-'));
const modules = {};
try {
  for (const name of ['sentences', 'voice-tuning', 'bench']) {
    await build({ entryPoints: [`src/${name}.ts`], outfile: path.join(output, `${name}.mjs`), bundle: true, platform: 'node', format: 'esm', packages: 'external' });
    modules[name] = await import(pathToFileURL(path.join(output, `${name}.mjs`)).href);
  }
} finally { await rm(output, { recursive: true, force: true }); }
const { splitSentences, DialogSentenceTokenizer } = modules.sentences;
const { voiceTuning, baselineTuning, defaultTuning } = modules['voice-tuning'];
const { StageClock } = modules.bench;

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
    { sttEndpointingMs: 300, endpointingMinMs: 200, endpointingMaxMs: 2500, preemptiveLlm: false, ttsIdleTimeoutMs: 4000 });
  for (const [name, value] of [['DIALOG_VOICE_STT_ENDPOINTING_MS', '5'], ['DIALOG_VOICE_STT_ENDPOINTING_MS', '300ms'], ['DIALOG_VOICE_ENDPOINTING_MIN_MS', '-1'],
    ['DIALOG_VOICE_ENDPOINTING_MAX_MS', '9000'], ['DIALOG_VOICE_PREEMPTIVE_LLM', 'yes'], ['DIALOG_VOICE_TTS_IDLE_TIMEOUT_MS', '500'], ['DIALOG_VOICE_TTS_IDLE_TIMEOUT_MS', 'sentinel-secret']]) {
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
