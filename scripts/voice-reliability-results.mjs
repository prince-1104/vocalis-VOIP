// Outcomes, rather than command exit status, determine whether a population passed.
export function reliabilityResults(records, plannedAttempts, regression = false) {
  const all = records.filter(record => record.case === 'first_turn_session');
  const sessions = all.filter(record => record.genuineSession === true);
  const successful = name => records.filter(record => record.case === name && record.outcome === 'ok').length;
  const expectedFaults = new Set(['session_closed', 'turn_dropped_then_recovered']);
  const failures = records.filter(record => {
    if (['tts_refuse', 'tts_stall', 'stt_drop'].includes(record.case))
      return !expectedFaults.has(record.outcome) || record.mockDelta?.injectedFailures !== 1;
    return record.outcome !== 'ok';
  });
  // The existing regression configuration: one six-turn repeat session, two mixed
  // sessions with five cases each, and one run of each of the three fault cases.
  const required = regression ? { session: 3, short: 6, pause: 2, long: 2, silence: 2, interrupt: 2, false_interrupt: 2, tts_refuse: 1, tts_stall: 1, stt_drop: 1 } : {};
  const missingRegressionRecords = Object.entries(required).reduce((sum, [name, count]) => sum + Math.max(0, count - records.filter(record => record.case === name).length), 0);
  const unaccounted = Math.max(0, plannedAttempts - sessions.length);
  const completeSessions = Array.from({ length: plannedAttempts }, (_, index) => index + 1).every(iteration =>
    ['first_turn_session', 'first_turn', 'second_turn'].every(name => {
      const matches = records.filter(record => record.iteration === iteration && record.case === name);
      return matches.length === 1 && matches[0].outcome === 'ok';
    }));
  return {
    attemptedSessions: sessions.length, nonSessionRecords: all.length - sessions.length, unaccounted,
    greetingSuccess: sessions.filter(record => record.outcome === 'ok').length,
    firstTurnSuccess: successful('first_turn'), secondTurnSuccess: successful('second_turn'),
    greetingFailures: sessions.filter(record => record.outcome !== 'ok').length,
    sessionFailures: sessions.filter(record => record.outcome !== 'ok' || ['first_turn', 'second_turn'].some(name =>
      !records.some(turn => turn.case === name && turn.iteration === record.iteration && turn.outcome === 'ok'))).length,
    sessionOutcomes: sessions.reduce((out, record) => { out[record.outcome] = (out[record.outcome] ?? 0) + 1; return out; }, {}),
    harnessErrors: records.filter(record => record.outcome === 'harness_error').length,
    failedRecords: failures.length, missingRegressionRecords,
    retries: sessions.filter(record => record.retried).length,
    populationPassed: unaccounted === 0 && failures.length === 0 && missingRegressionRecords === 0
      && !sessions.some(record => record.retried)
      && (plannedAttempts === 0 || (sessions.length === plannedAttempts && completeSessions)),
  };
}

export function lifecyclePassed(result, injected, cleanupConfirmed, restored) {
  return injected && cleanupConfirmed && restored && result.code === 0 && !result.timedOut
    && !result.reportMissing && result.attemptedSessions === 1 && !result.unaccounted
    && !result.harnessErrors && !result.nonSessionRecords;
}
