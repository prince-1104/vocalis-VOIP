import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reliabilityResults, lifecyclePassed } from '../../../scripts/voice-reliability-results.mjs';

const session = (iteration, outcome = 'ok') => ({ case: 'first_turn_session', iteration, outcome, genuineSession: true });
const turn = (name, outcome = 'ok', iteration = 1) => ({ case: name, outcome, iteration });

test('completed synthesis or a greeting cannot conceal a missing or failed first turn', () => {
  const result = reliabilityResults([session(1), turn('first_turn', 'timeout_no_response'), turn('second_turn')], 1);
  assert.equal(result.attemptedSessions, 1);
  assert.equal(result.populationPassed, false);
  assert.equal(result.failedRecords, 1);
  assert.equal(result.sessionFailures, 1);
  assert.equal(result.greetingFailures, 0);
  assert.equal(reliabilityResults([session(1), turn('second_turn')], 1).populationPassed, false);
});

test('lifecycle cleanup cannot conceal harness failure or failed restoration', () => {
  const result = { code: 0, attemptedSessions: 1, unaccounted: 0, harnessErrors: 0, nonSessionRecords: 0 };
  assert.equal(lifecyclePassed(result, true, true, true), true);
  assert.equal(lifecyclePassed({ ...result, harnessErrors: 1 }, true, true, true), false);
  assert.equal(lifecyclePassed({ ...result, reportMissing: true }, true, true, true), false);
  assert.equal(lifecyclePassed(result, true, true, false), false);
  assert.equal(lifecyclePassed(result, false, true, true), false);
});

test('browser shutdown records never fill the genuine population', () => {
  const result = reliabilityResults([session(1), turn('first_turn'), turn('second_turn'),
    { ...session(2, 'harness_error'), genuineSession: false }], 100);
  assert.equal(result.attemptedSessions, 1);
  assert.equal(result.nonSessionRecords, 1);
  assert.equal(result.unaccounted, 99);
  assert.equal(result.populationPassed, false);
});

test('all three outcomes are required for every genuine first-session attempt', () => {
  assert.equal(reliabilityResults([session(1), turn('first_turn'), turn('second_turn')], 1).populationPassed, true);
  assert.equal(reliabilityResults([session(1), session(2), turn('first_turn'), turn('first_turn'), turn('second_turn'), turn('second_turn', 'ok', 2)], 2).populationPassed, false, 'duplicate records cannot stand in for another session');
  assert.equal(reliabilityResults([{ ...session(1), retried: true }, turn('first_turn'), turn('second_turn')], 1).populationPassed, false, 'a replacement attempt cannot become first-attempt success');
});

test('regression fails on missing cases and unrecovered or unconfirmed fault injection', () => {
  assert.equal(reliabilityResults([], 0, true).populationPassed, false);
  const counts = { session: 3, short: 6, pause: 2, long: 2, silence: 2, interrupt: 2, false_interrupt: 2 };
  const records = Object.entries(counts).flatMap(([name, n]) => Array.from({ length: n }, () => turn(name)));
  for (const name of ['tts_refuse', 'tts_stall', 'stt_drop']) records.push({ case: name, outcome: 'session_closed', mockDelta: { injectedFailures: 1 } });
  assert.equal(reliabilityResults(records, 0, true).populationPassed, true);
  records.at(-1).outcome = 'turn_dropped_no_recovery';
  assert.equal(reliabilityResults(records, 0, true).populationPassed, false);
  records.at(-1).outcome = 'session_closed'; records.at(-1).mockDelta.injectedFailures = 0;
  assert.equal(reliabilityResults(records, 0, true).populationPassed, false);
});
