import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeLogger } from '@livekit/agents';
import {AudioFrame} from '@livekit/rtc-node';
initializeLogger({ level: 'silent', pretty: false });
const directory = path.dirname(createRequire(import.meta.url).resolve('@livekit/agents'));
const load = file => import(pathToFileURL(path.join(directory, file)).href);
const { AgentActivity } = await load('voice/agent_activity.js');
const { ParticipantAudioOutput } = await load('voice/room_io/_output.js');
const { SpeechHandle } = await load('voice/speech_handle.js');
const { Event, Future } = await load('utils.js');
const validFrame = frame => {
  if (!frame.data) return;
  assert.equal(frame.channels,1,'replay must preserve rtc-node channel metadata');
  assert.equal(frame.data.length,frame.samplesPerChannel*frame.channels,'replay buffer must match frame metadata');
};

// Use the installed activity and output implementations. Only the native source
// is replaced by a deterministic sink; this is a contract test, not a claim that
// a synthetic callback sequence reproduces the historical failure.
function fixture() {
  const captured = [], cleared = Promise.withResolvers();
  const output = Object.assign(Object.create(ParticipantAudioOutput.prototype), {
    capabilities: { pause: true }, startedFuture: new Future(), playbackEnabledFuture: new Future(),
    interruptedFuture: new Future(), firstFrameEmitted: false, pushedDuration: 0, sourcePushedDuration: 0,
    sourceDiscardedDuration: 0, interruptionGeneration: 0, forwardingCount: 0, forwardingIdleFuture: new Future(),
    pendingQueueFrames: [], _dialogReplayFrames: 0, _dialogReplayMs: 0,
    _capturing: false, playbackSegmentsCount: 0, playbackFinishedCount: 0, playbackFinishedFuture: new Future(),
    runOffset: 0, onPlaybackStarted() {}, onPlaybackProgressed() {},
    audioSource: { queuedDuration: 0, clearQueue() { cleared.resolve(); }, async captureFrame(frame) { validFrame(frame); captured.push(frame); }, async waitForPlayout() {} },
  });
  output.startedFuture.resolve(); output.playbackEnabledFuture.resolve(); output.forwardingIdleFuture.resolve();
  const handle = SpeechHandle.create(), activity = Object.create(AgentActivity.prototype);
  const session = { _activity: activity, _aecWarmupRemaining: 0, agentState: 'thinking', turnDetection: 'stt',
    _updateUserState() {}, emit() {}, output: { audioEnabled: true, audio: output },
    sessionOptions: { turnHandling: { interruption: { resumeFalseInterruption: true, falseInterruptionTimeout: 2000, minDuration: 500, minWords: 0 } } } };
  Object.assign(activity, { agent: {}, agentSession: session, _currentSpeech: handle, userSilenceEvent: new Event(),
    rtOverlappingSpeechEnabled: false, isInterruptionDetectionEnabled: false, isInterruptionByAudioActivityEnabled: true,
    audioRecognition: {}, logger: { debug() {} } });
  activity.userSilenceEvent.set();
  return { activity, output, handle, captured, cleared: cleared.promise };
}
const frame = () => ({ samplesPerChannel: 2400, sampleRate: 24000 });

test('provisional pause preserves queued samples and complete playback after false interruption',async()=>{
 const f=fixture(),frames=Array.from({length:31},(_,i)=>new AudioFrame(new Int16Array(2400).fill(i+1),24000,1,2400));
 let finished;f.output.onPlaybackFinished=event=>{finished=event};
 for(const value of frames.slice(0,14)){
  // The native source has a tail queued; it is not equivalent to completed playout.
  f.output.audioSource.queuedDuration=194;await f.output.captureFrame(value);
 }
 const cleared=Promise.withResolvers();
 f.output.audioSource.clearQueue=()=>{f.output.audioSource.queuedDuration=0;cleared.resolve()};
 f.output.pause();const held=f.output.captureFrame(frames[14]);await cleared.promise;
 f.output.resume();await held;
 for(const value of frames.slice(15))await f.output.captureFrame(value);
 f.output.flush();await f.output.flushTask.result;
 assert.equal(Math.round(finished.playbackPosition*1000),3100,'false interruption must not discard 194 ms of the valid reply');
 assert.equal(f.output._dialogReplayFrames,2);
 assert.equal(Math.round(f.output._dialogReplayMs),194);
 assert.equal(f.captured.length-f.output._dialogReplayFrames,31);
 assert.equal(f.captured[14].samplesPerChannel,2256);
 assert.equal(f.captured[14].data[0],13);
 assert.equal(f.captured[15].data[0],14);
 assert.deepEqual(f.captured.slice(16),frames.slice(14));
 assert.equal(f.output.pendingQueueFrames.length,0,'completed stream releases retained samples');
});

test('cancellation during native capture drains the stale capture before a new turn can start',async()=>{
 const f=fixture(),entered=Promise.withResolvers(),release=Promise.withResolvers(),native=[];
 const old=frame();let finished;
 f.output.onPlaybackFinished=e=>{finished=e};
 f.output.audioSource.captureFrame=async value=>{entered.resolve();await release.promise;native.push(value)};
 f.output.audioSource.clearQueue=()=>{native.length=0;release.resolve()};
 const capturing=f.output.captureFrame(old);await entered.promise;
 f.output.clearBuffer();await capturing;await f.output.flushTask.result;
 assert.equal(finished.interrupted,true);
 assert.deepEqual(native,[],'late native completion must be cleared before flush completes');
 assert.equal(f.output._dialogReplayFrames,0);
 assert.deepEqual(f.output.pendingQueueFrames,[]);
});

test('genuine barge-in discards a provisional replay tail and never restores it on the next turn',async()=>{
 const f=fixture(),frames=Array.from({length:15},(_,i)=>new AudioFrame(new Int16Array(2400).fill(i+1),24000,1,2400));
 for(const value of frames.slice(0,14)){f.output.audioSource.queuedDuration=194;await f.output.captureFrame(value)}
 const cleared=Promise.withResolvers();
 f.output.audioSource.clearQueue=()=>{f.output.audioSource.queuedDuration=0;cleared.resolve()};
 f.output.pause();const held=f.output.captureFrame(frames[14]);await cleared.promise;
 f.output.clearBuffer();f.output.resume();await held;await f.output.flushTask.result;
 assert.equal(f.output._dialogReplayFrames,0);
 assert.equal(f.captured.length,14);
 const current=new AudioFrame(new Int16Array(2400).fill(99),24000,1,2400);
 await f.output.captureFrame(current);assert.equal(f.captured.at(-1),current);
 assert.equal(f.captured.some(x=>x===frames[14]),false);
 f.output.flush();await f.output.flushTask.result;
});

test('repeated pause during queue restoration preserves sample order and accounts for each recapture',async()=>{
 const f=fixture(),frames=Array.from({length:31},(_,i)=>new AudioFrame(new Int16Array(2400).fill(i+1),24000,1,2400));
 for(const value of frames.slice(0,14)){f.output.audioSource.queuedDuration=194;await f.output.captureFrame(value)}
 const clears=[Promise.withResolvers(),Promise.withResolvers()],entered=Promise.withResolvers(),release=Promise.withResolvers();
 let clearCount=0,replaying=false,finished;
 f.output.onPlaybackFinished=e=>{finished=e};
 f.output.audioSource.clearQueue=()=>{f.output.audioSource.queuedDuration=0;clears[clearCount++]?.resolve()};
 f.output.audioSource.captureFrame=async value=>{
  validFrame(value);
  if(!replaying&&value.data[0]===13){replaying=true;entered.resolve();await release.promise;f.output.audioSource.queuedDuration=94}
  else f.output.audioSource.queuedDuration=0;
  f.captured.push(value);
 };
 f.output.pause();const held=f.output.captureFrame(frames[14]);await clears[0].promise;
 f.output.resume();await entered.promise;f.output.pause();release.resolve();await clears[1].promise;
 f.output.resume();await held;for(const value of frames.slice(15))await f.output.captureFrame(value);
 f.output.flush();await f.output.flushTask.result;
 assert.equal(Math.round(finished.playbackPosition*1000),3100);
 assert.equal(f.output._dialogReplayFrames,3);assert.equal(Math.round(f.output._dialogReplayMs),288);
 assert.equal(f.captured.length-f.output._dialogReplayFrames,31);
 assert.deepEqual(f.captured.slice(17),frames.slice(14));
});

test('retained queue is bounded and detached from caller-owned samples',async()=>{
 const f=fixture();let last;
 for(let i=0;i<100;i++){
  f.output.audioSource.queuedDuration=1000;
  last=new AudioFrame(new Int16Array(2400).fill(i),24000,1,2400);
  await f.output.captureFrame(last);assert.ok(f.output.pendingQueueFrames.length<=10);validFrame(f.output.pendingQueueFrames.at(-1));
 }
 last.data.fill(-1);assert.equal(f.output.pendingQueueFrames.at(-1).data[0],99);
 f.output.audioSource.waitForPlayout=async()=>{f.output.audioSource.queuedDuration=0};
 f.output.flush();await f.output.flushTask.result;assert.equal(f.output.pendingQueueFrames.length,0);
});

for (const order of ['capture-before-reset', 'reset-before-capture']) test(`STT end then delayed VAD and flush must release valid reply: ${order}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), frames = Array.from({ length: 31 }, frame);
  f.activity._currentSpeech = undefined;
  f.activity.onStartOfSpeech(); f.activity.onEndOfSpeech(); // STT ends before VAD catches up.
  f.activity._currentSpeech = f.handle;
  const vad = (speaking, speechDuration, rawAccumulatedSilence) => f.activity.onVADInferenceDone({ speaking, speechDuration, rawAccumulatedSilence });
  vad(true, 544, 0); vad(true, 1568, 256);
  assert.equal(f.activity.userSilenceEvent.isSet, true);
  assert.equal(f.activity.pausedSpeech.handle, f.handle);
  assert.equal(f.activity.falseInterruptionTimer, undefined);
  assert.equal(f.output.playbackEnabledFuture.done, false);
  let capture;
  const forward = async () => { for (const value of frames) await f.output.captureFrame(value); };
  t.after(async () => { f.output.clearBuffer(); await f.activity.cancelSpeechPause(); await capture; await f.output.flushTask?.result; });
  if (order === 'capture-before-reset') { capture = forward(); await f.cleared; assert.equal(f.captured.length, 0); }
  // Silero's queued FLUSH_SENTINEL resets speech state without an END_OF_SPEECH.
  vad(false, 0, 0);
  assert.ok(f.activity.falseInterruptionTimer, 'silent inference after flush must own a resume timer');
  if (!capture) { capture = forward(); await f.cleared; }
  t.mock.timers.tick(1999); assert.equal(f.captured.length, 0);
  t.mock.timers.tick(1); await capture;
  assert.deepEqual(f.captured, frames);
  assert.equal(f.activity.falseInterruptionTimer, undefined);
});

for (const order of ['capture-before-silence', 'silence-before-capture']) test(`installed SDK releases valid paused capture: ${order}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), frames = Array.from({ length: 31 }, frame);
  f.activity.onStartOfSpeech();
  assert.equal(f.output.playbackEnabledFuture.done, false);
  const forward = async () => { for (const value of frames) await f.output.captureFrame(value); };
  let capture;
  if (order === 'capture-before-silence') { capture = forward(); await f.cleared; assert.equal(f.captured.length, 0); }
  f.activity.onEndOfSpeech();
  assert.equal(f.activity.userSilenceEvent.isSet, true);
  assert.ok(f.activity.falseInterruptionTimer);
  t.mock.timers.tick(0);
  if (!capture) capture = forward();
  await capture;
  assert.deepEqual(f.captured, frames);
  assert.equal(f.output.playbackEnabledFuture.done, true);
  assert.equal(f.activity.pausedSpeech, undefined);
  assert.equal(f.activity.falseInterruptionTimer, undefined);
});

test('installed SDK cancellation discards held frames before resuming output', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.activity.onStartOfSpeech();
  const old = frame(), capture = f.output.captureFrame(old);
  await f.cleared;
  f.activity.onEndOfSpeech();
  f.output.clearBuffer();
  await f.activity.cancelSpeechPause();
  await capture; await f.output.flushTask?.result;
  t.mock.timers.tick(2000);
  assert.equal(f.handle.interrupted, true);
  assert.equal(f.activity.falseInterruptionTimer, undefined);
  assert.equal(f.captured.includes(old), false);
});

for(const alreadyInterrupted of [false,true])test(`final transcript cancellation invalidates held native capture before resume: previously interrupted=${alreadyInterrupted}`,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture(),old=frame();f.activity.onStartOfSpeech();
 const capture=f.output.captureFrame(old);await f.cleared;
 if(alreadyInterrupted)f.handle.interrupt();
 await f.activity.cancelSpeechPause();await capture;await f.output.flushTask?.result;
 assert.equal(f.handle.interrupted,true);
 assert.equal(f.captured.length,0,'cancelSpeechPause must not briefly forward the obsolete first frame');
 f.handle._markDone();
});

test('an older cancellation settling after a new pause cannot release the new speech gate',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture(),settled=Promise.withResolvers();f.activity.onStartOfSpeech();
 Object.defineProperty(f.handle,'_hasGenerations',{get:()=>true});
 f.handle._waitForGeneration=()=>settled.promise;
 f.handle.waitIfNotInterrupted=()=>settled.promise;
 const cancelling=f.activity.cancelSpeechPause();
 const next=SpeechHandle.create();f.activity._currentSpeech=next;f.activity.updatePausedSpeech(next,2000);f.output.pause();
 settled.resolve();await cancelling;
 assert.equal(f.activity.pausedSpeech.handle,next);
 assert.equal(f.output.playbackEnabledFuture.done,false);
 await f.activity.cancelSpeechPause();await f.output.flushTask?.result;f.handle._markDone();next._markDone();
});

test('installed SDK rapid speech restart cancels old resume; current silence releases once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); let resumes = 0;
  const resume = f.output.resume;
  f.output.resume = function () { resumes++; return resume.call(this); };
  f.activity.onStartOfSpeech();
  f.activity.onEndOfSpeech();
  f.activity.onStartOfSpeech();
  t.mock.timers.tick(0);
  assert.equal(resumes, 0);
  assert.equal(f.output.playbackEnabledFuture.done, false);
  f.activity.onEndOfSpeech(); t.mock.timers.tick(0);
  assert.equal(resumes, 1);
  t.mock.timers.tick(2000); assert.equal(resumes, 1);
  assert.equal(f.activity.falseInterruptionTimer, undefined);
});

test('installed SDK ignores an old turn-settlement callback after its pause is cancelled', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), callbacks = [];
  const decision = { done: false, cancelled: false, addDoneCallback(fn) { callbacks.push(fn); } };
  f.activity.audioRecognition.endOfTurnTask = decision;
  f.activity.onStartOfSpeech(); f.activity.onEndOfSpeech(); t.mock.timers.tick(0);
  assert.equal(f.activity.falseInterruptionPending, true);
  f.activity.onStartOfSpeech();
  decision.done = true; callbacks.forEach(fn => fn());
  assert.equal(f.output.playbackEnabledFuture.done, false);
  f.activity.onEndOfSpeech(); t.mock.timers.tick(0);
  assert.equal(f.output.playbackEnabledFuture.done, true);
  assert.equal(f.activity.falseInterruptionPending, false);
});

function flushedPause(f) {
  f.activity._currentSpeech = undefined;
  f.activity.onStartOfSpeech(); f.activity.onEndOfSpeech();
  f.activity._currentSpeech = f.handle;
  f.activity.onVADInferenceDone({ speaking: true, speechDuration: 544, rawAccumulatedSilence: 0 });
  f.activity.onVADInferenceDone({ speaking: false, speechDuration: 0, rawAccumulatedSilence: 0 });
}

test('repeated silent VAD inferences preserve the current resume timer and its original deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); flushedPause(f);
  const timer = f.activity.falseInterruptionTimer;
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(500);
    f.activity.onVADInferenceDone({ speaking: false, speechDuration: 0, rawAccumulatedSilence: 500 * (i + 1) });
    assert.equal(f.activity.falseInterruptionTimer, timer);
  }
  t.mock.timers.tick(500);
  assert.equal(f.output.playbackEnabledFuture.done, true);
  assert.equal(f.activity.falseInterruptionTimer, undefined);
});

test('cancelling a reply held across VAD flush never forwards its frame or leaves a resume timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); flushedPause(f);
  const old = frame(), capture = f.output.captureFrame(old);
  await f.cleared;
  f.output.clearBuffer(); await f.activity.cancelSpeechPause();
  await capture; await f.output.flushTask?.result;
  t.mock.timers.tick(10000);
  assert.equal(f.captured.includes(old), false);
  assert.equal(f.activity.falseInterruptionTimer, undefined);
  assert.equal(f.activity.pausedSpeech, undefined);
});

for (const invalid of ['interrupted', 'done', 'superseded', 'inactive', 'audio-disabled']) test(`silent VAD cannot arm a resume for ${invalid} speech`, t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.activity.onStartOfSpeech();
  if (invalid === 'interrupted') f.handle.interrupt();
  if (invalid === 'done') f.handle._markDone();
  if (invalid === 'superseded') f.activity._currentSpeech = SpeechHandle.create();
  if (invalid === 'inactive') f.activity.agentSession._activity = undefined;
  if (invalid === 'audio-disabled') f.activity.agentSession.output.audioEnabled = false;
  f.activity.onVADInferenceDone({ speaking: false, speechDuration: 0, rawAccumulatedSilence: 0 });
  assert.equal(f.activity.falseInterruptionTimer, undefined);
  t.mock.timers.tick(10000);
  assert.equal(f.output.playbackEnabledFuture.done, false);
});
