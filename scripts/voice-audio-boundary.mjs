/** Browser-clock values only. A streaming gap is not a terminal response boundary. */
export function completedResponseEnd(env, now, after, quiet, completionConfirmed = true) {
  if (!completionConfirmed || env.audible || now - env.lastLoud < quiet) return false;
  const last = env.segments.at(-1);
  return last && last[1] > after ? last[1] : false;
}

export function greetingCompletion(events, media, clicked) {
  const correlation = media.filter(event => event.e === 'browser_track_subscribed' && event.t >= clicked).at(-1)?.correlation;
  return Boolean(correlation && events.some(event => event.e === 'greeting_done' && event.rx >= clicked
    && event.correlation === correlation && event.interrupted === false));
}

/** Full-session counters, with browser receipt time selecting this user turn only. */
export function replyDelivery(events, media, from) {
  const correlation = media.filter(e => e.e === 'browser_track_subscribed').at(-1)?.correlation;
  const session = events.filter(e => e.correlation === correlation);
  const turn = session.filter(e => e.rx >= from);
  const start = turn.find(e => e.e === 'tts_start');
  const streams = new Set(turn.filter(e => e.e === 'tts_start' && Number.isSafeInteger(e.stream)).map(e => e.stream));
  const summaries = turn.filter(e => e.e === 'tts_audio_summary' && (!streams.size || streams.has(e.stream)));
  const starts = turn.filter(e => e.e === 'tts_start');
  const discarded = new Set();
  for (let i = 0; i + 1 < starts.length; i++) {
    const candidate = starts[i], next = starts[i+1];
    if (!Number.isSafeInteger(candidate.stream)) continue;
    const terminal = turn.find(e => e.e === 'output_playback_finished' && e.t >= candidate.t && e.t < next.t);
    const prior = session.filter(e => e.e === 'output_playback_finished' && e.t < candidate.t).at(-1);
    const generated = summaries.filter(e => e.stream === candidate.stream);
    if (terminal?.interrupted === true && terminal.playbackMs === 0 && generated.length && !generated.some(e => e.failed)
      && Number.isFinite(terminal.nativeFrames) && terminal.nativeFrames === prior?.nativeFrames
      && terminal.nativeSource > 0 && terminal.nativeSource === prior?.nativeSource
      && !turn.some(e => e.e === 'output_playback_started' && e.t >= candidate.t && e.t < next.t)) discarded.add(candidate.stream);
  }
  const intended = summaries.filter(e => !discarded.has(e.stream));
  const generated = summaries.reduce((n, e) => n + e.frames, 0);
  const generatedMs = summaries.reduce((n, e) => n + e.audioMs, 0);
  const intendedFrames = intended.reduce((n,e) => n+e.frames,0), intendedMs = intended.reduce((n,e) => n+e.audioMs,0);
  const source = session.find(e => e.e === 'published_source_link' && e.matched)?.source;
  const playbackStart = start ? turn.find(e => e.e === 'output_playback_started' && e.t >= start.t && e.nativeSource === source) : null;
  const baseline = playbackStart?.nativeCompleted ?? (start ? session.filter(e => e.source === source && e.t < start.t && Number.isFinite(e.completed)).at(-1)?.completed ?? 0 : 0);
  const drain = turn.filter(e => e.e === 'source_drained' && e.source === source).at(-1);
  const finished = turn.filter(e => e.e === 'output_playback_finished').at(-1);
  const previous = start ? session.filter(e => e.e === 'output_playback_finished' && e.t < start.t).at(-1) : null;
  const replayedFrames = (finished?.replayedFrames ?? 0) - (playbackStart?.replayedFrames ?? previous?.replayedFrames ?? 0);
  const replayedMs = (finished?.replayedMs ?? 0) - (playbackStart?.replayedMs ?? previous?.replayedMs ?? 0);
  const captured = drain ? drain.completed - baseline : null;
  const cancelled = intended.some(e => e.cancelled || e.failed) || finished?.interrupted === true;
  const captureError = turn.some(e => {
    if (!/capture_error$/.test(e.e)) return false;
    if (playbackStart && Number.isSafeInteger(e.capture)) {
      if (e.source === source) return e.capture > playbackStart.nativeFrames;
      if (e.source === 0) return e.capture >= playbackStart.frames;
    }
    return e.t >= (playbackStart?.t ?? start?.t ?? -Infinity);
  });
  const complete = Boolean(correlation && source && start && intended.length && intendedFrames > 0 && !cancelled
    && starts.filter(e => !discarded.has(e.stream)).length === 1
    && drain && drain.frames === drain.completed + (drain.failed ?? 0) && captured - replayedFrames === intendedFrames && replayedFrames >= 0 && replayedMs >= 0 && finished?.interrupted === false
    && Number.isFinite(intendedMs) && intendedMs > 0 && Math.round(finished.playbackMs) >= intendedMs
    && finished.t >= drain.t && !captureError);
  return { complete, generated, generatedMs, intendedFrames, intendedMs, cancelledBeforeAudioStreams: discarded.size,
    cancelledBeforeAudioFrames: generated-intendedFrames, cancelledBeforeAudioMs: generatedMs-intendedMs,
    captured, replayedFrames, replayedMs, cancelled, drained: Boolean(drain), playbackFinished: Boolean(finished),
    playbackMs: finished?.playbackMs ?? null, source: source ?? null };
}

/** An obsolete reply may be partial only with an explicit interrupted terminal event. */
export function interruptionAccounting(events, media, from) {
  const correlation = media.filter(e => e.e === 'browser_track_subscribed').at(-1)?.correlation;
  const turn = events.filter(e => e.correlation === correlation && e.rx >= from);
  const start = turn.find(e => e.e === 'tts_start');
  const begun = start && turn.find(e => e.e === 'output_playback_started' && e.t >= start.t);
  const stopped = start && turn.find(e => e.e === 'output_playback_finished' && e.t >= start.t && e.interrupted === true);
  const summaries = start ? turn.filter(e => e.e === 'tts_audio_summary' && (start.stream === undefined || e.stream === start.stream)) : [];
  const generated = summaries.reduce((n,e) => n+e.frames,0), generatedMs = summaries.reduce((n,e) => n+e.audioMs,0);
  const captured = begun && stopped ? stopped.nativeCompleted-begun.nativeCompleted : NaN;
  const replayedFrames = begun && stopped ? (stopped.replayedFrames ?? 0)-(begun.replayedFrames ?? 0) : 0;
  const notCaptured = generated-(captured-replayedFrames);
  const confirmed = Boolean(correlation && begun?.nativeSource > 0 && begun.nativeSource === stopped?.nativeSource
    && summaries.length && generated > 0 && Number.isFinite(captured) && captured >= replayedFrames && replayedFrames >= 0
    && notCaptured >= 0 && Number.isFinite(stopped?.playbackMs));
  return { confirmed, reason: confirmed ? 'barge_in' : 'unconfirmed', generated, generatedMs,
    captured: Number.isFinite(captured) ? captured : null, replayedFrames, notCaptured: Number.isFinite(notCaptured) ? notCaptured : null,
    playbackMs: stopped?.playbackMs ?? null, notPlayedMs: stopped ? Math.max(0,generatedMs-stopped.playbackMs) : null };
}
