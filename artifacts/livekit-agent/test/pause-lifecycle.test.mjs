import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(path.resolve('test', '.pause-build-'));
let observer;
try {
  const file = path.join(directory, 'pause-diagnostics.mjs');
  await build({ entryPoints: ['src/pause-diagnostics.ts'], outfile: file, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
  observer = await import(pathToFileURL(file).href);
} finally { await rm(directory, { recursive: true, force: true }); }
const { observePauseLifecycle, pauseCallbacks } = observer;
const fixture = () => {
  const prototype = Object.fromEntries(pauseCallbacks.map(name => [name, function () {}]));
  const session = { agentState: 'thinking', output: { audio: { playbackEnabledFuture: { done: true } } } };
  const activity = Object.assign(Object.create(prototype), { agentSession: session, userSilenceEvent: { isSet: true } });
  const events = [], clock = { now: () => performance.now(), mark: (event, fields) => events.push({ event, ...fields }) };
  return { prototype, session, activity, events, clock };
};

test('pause diagnostics preserve arguments, return and Promise identities, errors and other sessions', async () => {
  const f = fixture(), argument = { privateTranscript: 'must never leave method' }, error = new Error('private provider error');
  let seen;
  const promise = Promise.resolve(argument);
  f.prototype.onStartOfSpeech = function (value) { seen = value; return argument; };
  f.prototype.cancelSpeechPause = () => promise;
  f.prototype.onEndOfSpeech = () => { throw error; };
  const original = { ...f.prototype }, observer = observePauseLifecycle(f.prototype, f.session, f.clock);
  assert.equal(f.activity.onStartOfSpeech(argument), argument);
  assert.equal(seen, argument);
  assert.equal(f.activity.cancelSpeechPause(), promise);
  assert.throws(() => f.activity.onEndOfSpeech(), value => value === error);
  await promise;
  const count = f.events.length;
  original.onStartOfSpeech.call({ agentSession: {} }, argument);
  f.prototype.onStartOfSpeech.call({ agentSession: {} }, argument);
  assert.equal(f.events.length, count);
  assert.equal(JSON.stringify(f.events).includes('private'), false);
  observer.dispose(); observer.dispose();
  assert.deepEqual(f.prototype, original);
  assert.equal(f.events.filter(e => e.event === 'pause_observer_end').length, 1);
});

test('controlled timer firing and replacement remain SDK-owned and teardown stops observation', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); let fired = 0;
  f.prototype.cancelFalseInterruptionTimer = function () { clearTimeout(this.falseInterruptionTimer); this.falseInterruptionTimer = undefined; };
  f.prototype.startFalseInterruptionTimer = function (timeout) {
    this.cancelFalseInterruptionTimer();
    this.falseInterruptionTimer = setTimeout(() => { this.falseInterruptionTimer = undefined; fired++; }, timeout);
    return this.falseInterruptionTimer;
  };
  const originalTimer = globalThis.setTimeout;
  const observer = observePauseLifecycle(f.prototype, f.session, f.clock);
  assert.equal(f.activity.startFalseInterruptionTimer(20), f.activity.falseInterruptionTimer);
  assert.equal(globalThis.setTimeout, originalTimer);
  t.mock.timers.tick(10);
  f.activity.startFalseInterruptionTimer(30);
  t.mock.timers.tick(20); assert.equal(fired, 0);
  t.mock.timers.tick(10); assert.equal(fired, 1);
  assert.equal(f.events.filter(e => e.phase === 4).length, 1);
  assert.equal(f.events.filter(e => e.phase === 5).length, 1);
  f.activity.startFalseInterruptionTimer(10);
  observer.dispose(); const count = f.events.length;
  t.mock.timers.tick(10);
  assert.equal(fired, 2, 'disposing diagnostics must not cancel an SDK timer');
  assert.equal(f.events.length, count);
});

test('diagnostics are bounded and unavailable callbacks fail before installing any wrapper', () => {
  const f = fixture(), original = { ...f.prototype };
  const observer = observePauseLifecycle(f.prototype, f.session, f.clock);
  for (let i = 0; i < 2000; i++) f.activity.onStartOfSpeech();
  assert.equal(f.events.length, 1600);
  observer.dispose(); assert.deepEqual(f.prototype, original);
  delete f.prototype.cancelSpeechPause;
  const before = { ...f.prototype };
  assert.throws(() => observePauseLifecycle(f.prototype, f.session, f.clock));
  assert.deepEqual(f.prototype, before);
});
