import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completedResponseEnd, greetingCompletion } from '../../../scripts/voice-audio-boundary.mjs';

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

test('completion alone proves neither sound nor the end of client playback', () => {
  assert.equal(completedResponseEnd({ audible: false, lastLoud: 0, segments: [] }, 10000, 100, 120, true), false);
  assert.equal(completedResponseEnd({ audible: false, lastLoud: 500, segments: [[100, 500]] }, 550, 100, 120, true), false);
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
