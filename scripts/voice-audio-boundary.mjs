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
