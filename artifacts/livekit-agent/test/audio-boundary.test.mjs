import { test } from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import { completedResponseEnd, greetingCompletion, replyDelivery, interruptionAccounting } from '../../../scripts/voice-audio-boundary.mjs';

test('actual browser completion predicate waits through the historical 31/14 capture boundary',async()=>{
 const source=await readFile(process.env.DIALOG_AUDIO_BASELINE ?? new URL('../../../scripts/voice-smoke.mjs',import.meta.url),'utf8');
 const start=source.indexOf('const responseEnd = '),end=source.indexOf('  const segmentsBetween =',start);
 const expression=source.slice(start+'const responseEnd = '.length,end).trim().replace(/;$/,'');
 const now=performance.now(),from=now-10000,correlation='current';
 const event=(e,t,fields={})=>({e,t,rx:from+t,correlation,...fields});
 const events=[event('published_source_link',-2,{source:1,matched:true}),event('source_drained',-1,{source:1,frames:53,completed:53}),
  event('tts_start',10),event('tts_audio_summary',20,{frames:31,audioMs:3025,cancelled:false,failed:false}),event('source_captured',30,{source:1,frames:67,completed:67})];
 const previous=globalThis.window;
 globalThis.window={__bench:events,__media:[{e:'browser_track_subscribed',correlation}],
  __env:{audible:false,lastLoud:now-1000,segments:[[now-2000,now-1000]]},
  __completedResponseEnd:completedResponseEnd,__greetingCompletion:greetingCompletion,__replyDelivery:replyDelivery};
 try{
  const page={waitForFunction:async(fn,args)=>{const value=fn(args);if(value===false)throw new Error('still pending');return {jsonValue:async()=>value}}};
  const responseEnd=new Function('page',`return (${expression})`)(page);
  assert.equal(await responseEnd(now-2000,700,15000,null,from),null,'quiet gap with pending native frames must not finish the turn');
  events.push(event('source_drained',50,{source:1,frames:84,completed:84}),event('output_playback_finished',51,{interrupted:false,playbackMs:3025}));
  assert.equal(await responseEnd(now-2000,700,15000,null,from),now-1000);
 }finally{globalThis.window=previous}
});

test('a quiet gap inside a still-streaming greeting cannot schedule a first turn', () => {
  const env = { audible: false, lastLoud: 3100, segments: [[2800, 3100]] };
  // The previous predicate accepted this gap and scheduled speech at 3250,
  // while the cold trace still captured greeting frames until about 4875.
  assert.equal(completedResponseEnd(env, 3230, 2800, 120, false), false);
  env.audible = true; env.lastLoud = 5000;
  assert.equal(completedResponseEnd(env, 5050, 2800, 120, true), false);
  env.audible = false; env.segments.push([3250, 5250]); env.lastLoud = 5250;
  assert.equal(completedResponseEnd(env, 5370, 2800, 120, true), 5250);
});

test('31 generated / 14 captured and a quiet browser cannot complete a reply; drain must account for all frames', () => {
  const correlation='current', media=[{e:'browser_track_subscribed',correlation}];
  const event=(e,t,fields={})=>({e,t,rx:t,correlation,...fields});
  const events=[event('published_source_link',0,{source:1,matched:true}),
    event('source_drained',1,{source:1,frames:53,completed:53}),event('tts_start',10),
    event('tts_audio_summary',20,{frames:31,audioMs:3025,cancelled:false,failed:false}),
    event('source_captured',30,{source:1,frames:67,completed:67})];
  assert.equal(replyDelivery(events,media,5).complete,false);
  events.push(event('source_drained',40,{source:1,frames:67,completed:67}),event('output_playback_finished',41,{interrupted:false,playbackMs:3025}));
  assert.equal(replyDelivery(events,media,5).captured,14);
  assert.equal(replyDelivery(events,media,5).complete,false);
  events.push(event('source_drained',50,{source:1,frames:84,completed:84}),event('output_playback_finished',51,{interrupted:false,playbackMs:3025}));
  assert.equal(replyDelivery(events,media,5).complete,true);
  events.push(event('tts_start',60),event('tts_audio_summary',65,{frames:31,audioMs:3025,cancelled:false,failed:false}));
  assert.equal(replyDelivery(events,media,55).complete,false,'old turn drain must not release next turn');
  events.push(event('source_drained',70,{source:1,frames:115,completed:115}),event('output_playback_finished',71,{interrupted:true}));
  assert.equal(replyDelivery(events,media,55).cancelled,true);
  assert.equal(replyDelivery(events,media,55).complete,false,'legitimate barge-in is accounted for, never complete');
});

test('completion alone proves neither sound nor the end of client playback', () => {
  assert.equal(completedResponseEnd({ audible: false, lastLoud: 0, segments: [] }, 10000, 100, 120, true), false);
  assert.equal(completedResponseEnd({ audible: false, lastLoud: 500, segments: [[100, 500]] }, 550, 100, 120, true), false);
});

test('queue restoration is explicit accounting, never permission to accept missing frames or short playback',()=>{
 const correlation='current',media=[{e:'browser_track_subscribed',correlation}];
 const event=(e,t,fields={})=>({e,t,rx:t,correlation,...fields});
 const events=[event('published_source_link',0,{source:1,matched:true}),
  event('source_drained',1,{source:1,frames:53,completed:53}),event('output_playback_finished',2,{replayedFrames:5,replayedMs:400}),
  event('tts_start',10),event('tts_audio_summary',20,{frames:31,audioMs:3100,cancelled:false,failed:false}),
  event('source_drained',30,{source:1,frames:86,completed:86}),
  event('output_playback_finished',31,{interrupted:false,playbackMs:3100,replayedFrames:7,replayedMs:594})];
 assert.equal(replyDelivery(events,media,5).complete,true);
 assert.equal(replyDelivery(events,media,5).replayedFrames,2);
 events.at(-1).playbackMs=2906;assert.equal(replyDelivery(events,media,5).complete,false);
 events.at(-1).playbackMs=3100;events.at(-1).replayedFrames=5;assert.equal(replyDelivery(events,media,5).complete,false);
 events.at(-1).replayedFrames=7;events.at(-2).frames=events.at(-2).completed=67;
 assert.equal(replyDelivery(events,media,5).complete,false);
});

test('recovery uses the new playback native boundary and excludes a late obsolete TTS terminal callback',()=>{
 const correlation='current',media=[{e:'browser_track_subscribed',correlation}];
 const event=(e,t,fields={})=>({e,t,rx:t,correlation,...fields});
 const events=[event('published_source_link',0,{source:1,matched:true}),event('source_captured',1,{source:1,completed:28}),
  event('tts_start',10,{stream:2}),event('output_playback_started',20,{nativeSource:1,nativeCompleted:43,replayedFrames:0,replayedMs:0}),
  event('tts_audio_summary',21,{stream:1,frames:133,audioMs:13255,cancelled:true,failed:false}),
  event('tts_audio_summary',22,{stream:2,frames:31,audioMs:3025,cancelled:false,failed:false}),
  event('source_drained',30,{source:1,frames:74,completed:74}),event('output_playback_finished',31,{interrupted:false,playbackMs:3025})];
 assert.equal(replyDelivery(events,media,5).complete,true);
 assert.equal(replyDelivery(events,media,5).generated,31);
 assert.equal(replyDelivery(events,media,5).captured,31);
});

test('barge-in must have an interrupted terminal event and explicit submitted/unsubmitted frame accounting',()=>{
 const correlation='current',media=[{e:'browser_track_subscribed',correlation}],event=(e,t,fields={})=>({e,t,rx:t,correlation,...fields});
 const events=[event('tts_start',10,{stream:1}),event('output_playback_started',11,{nativeSource:1,nativeCompleted:22,replayedFrames:0}),
  event('tts_audio_summary',12,{stream:1,frames:133,audioMs:13255}),
  event('output_playback_finished',20,{nativeSource:1,nativeCompleted:49,replayedFrames:1,playbackMs:2500,interrupted:true})];
 const result=interruptionAccounting(events,media,5);
 assert.equal(result.confirmed,true);assert.equal(result.reason,'barge_in');assert.equal(result.notCaptured,107);assert.equal(result.notPlayedMs,10755);
 events.at(-1).interrupted=false;assert.equal(interruptionAccounting(events,media,5).confirmed,false);
 events.at(-1).interrupted=true;events.at(-1).nativeSource=2;assert.equal(interruptionAccounting(events,media,5).confirmed,false);
});

test('a failed capture from an explicitly cancelled old turn cannot poison a complete recovery or conceal a new error',()=>{
 const correlation='current',media=[{e:'browser_track_subscribed',correlation}],event=(e,t,fields={})=>({e,t,rx:t,correlation,...fields});
 const events=[event('published_source_link',0,{source:1,matched:true}),event('tts_start',10,{stream:6}),
  event('output_playback_started',20,{frames:241,nativeSource:1,nativeFrames:240,nativeCompleted:239,nativeFailed:1,replayedFrames:0,replayedMs:0}),
  event('source_capture_error',21,{source:1,capture:240,frames:240,completed:239,failed:1}),
  event('tts_audio_summary',22,{stream:6,frames:31,audioMs:3025,cancelled:false,failed:false}),
  event('source_drained',30,{source:1,frames:271,completed:270,failed:1}),
  event('output_playback_finished',31,{interrupted:false,playbackMs:3025,replayedFrames:0,replayedMs:0})];
 assert.equal(replyDelivery(events,media,5).complete,true);
 assert.equal(replyDelivery(events,media,5).captured,31);
 events[3].capture=241;assert.equal(replyDelivery(events,media,5).complete,false,'a failure in the replacement reply must still fail');
 events[3].capture=240;events[5].failed=0;assert.equal(replyDelivery(events,media,5).complete,false,'an unexplained counter gap must still fail');
});

test('only positively cancelled candidates with zero native requests and zero playback can precede a complete reply',()=>{
 const correlation='current',media=[{e:'browser_track_subscribed',correlation}],event=(e,t,fields={})=>({e,t,rx:t,correlation,...fields});
 const events=[event('published_source_link',0,{source:1,matched:true}),
  event('output_playback_finished',1,{nativeSource:1,nativeFrames:22,nativeCompleted:22,interrupted:false,playbackMs:2145}),
  event('tts_start',10,{stream:2}),event('tts_audio_summary',12,{stream:2,frames:31,audioMs:3025,failed:false,cancelled:false}),
  event('output_playback_finished',15,{nativeSource:1,nativeFrames:22,nativeCompleted:22,interrupted:true,playbackMs:0}),
  event('tts_start',20,{stream:3}),event('tts_audio_summary',22,{stream:3,frames:31,audioMs:3025,failed:false,cancelled:false}),
  event('output_playback_started',23,{nativeSource:1,nativeFrames:22,nativeCompleted:22}),
  event('source_drained',30,{source:1,frames:53,completed:53}),
  event('output_playback_finished',31,{nativeSource:1,nativeFrames:53,nativeCompleted:53,interrupted:false,playbackMs:3025})];
 const delivery=replyDelivery(events,media,5);
 assert.equal(delivery.complete,true);assert.equal(delivery.generated,62);assert.equal(delivery.intendedFrames,31);
 assert.equal(delivery.cancelledBeforeAudioFrames,31);assert.equal(delivery.cancelledBeforeAudioStreams,1);
 events[4].nativeFrames=23;events[4].playbackMs=4;
 assert.equal(replyDelivery(events,media,5).complete,false,'the historical leaked first frame must remain a failed response');
 events[4].nativeFrames=22;events[4].playbackMs=0;events[4].interrupted=false;
 assert.equal(replyDelivery(events,media,5).complete,false,'a missing cancellation cannot be inferred from a quiet gap');
});

test('late completion from another session and interrupted greetings cannot open the gate', () => {
  const media = [{ e: 'browser_track_subscribed', t: 100, correlation: 'current-session' }];
  const event = { e: 'greeting_done', rx: 200, correlation: 'old-session', interrupted: false };
  assert.equal(greetingCompletion([event], media, 50), false);
  event.correlation = 'current-session'; event.interrupted = true;
  assert.equal(greetingCompletion([event], media, 50), false);
  event.interrupted = false;
  assert.equal(greetingCompletion([event], media, 50), true);
});
