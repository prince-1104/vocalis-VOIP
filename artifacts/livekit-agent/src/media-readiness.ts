/** Observe the public publication API without changing SDK track ownership or retrying it. */
export class MediaReadinessError extends Error {
  constructor(readonly reason: "media_timeout" | "publication_rejected" | "media_cancelled") { super(reason); }
}
export function observePublication<P extends { waitForSubscription(): Promise<void> }, A extends unknown[]>(
  participant: { publishTrack(...args: A): Promise<P> },
  mark: (event: "audio_track_created" | "publication_started" | "publication_resolved" | "publication_rejected" | "publication_timeout" | "subscription_timeout" | "subscription_ready", state?: { started: boolean; published: boolean }) => void,
  signal: AbortSignal, timeoutMs = 12000,
) {
  const original = participant.publishTrack;
  let settled = false, started = false, published = false;
  let resolve!: () => void, reject!: (error: Error) => void;
  const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // The SDK starts publication in a background task; callers may not yet be awaiting readiness.
  void ready.catch(() => undefined);
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true; clearTimeout(timer); signal.removeEventListener("abort", cancel);
    if (error) reject(error); else resolve();
  };
  const cancel = () => finish(new MediaReadinessError("media_cancelled"));
  const timer = setTimeout(() => { mark(published ? "subscription_timeout" : "publication_timeout", { started, published }); finish(new MediaReadinessError("media_timeout")); }, timeoutMs);
  participant.publishTrack = async function (...args: A): Promise<P> {
    // RoomIO owns exactly one output track. Never create a replacement on failure.
    if (started || settled) throw new MediaReadinessError("publication_rejected");
    started = true; mark("audio_track_created"); mark("publication_started");
    try {
      const publication = await original.apply(participant, args);
      published = true;
      mark("publication_resolved");
      if (!settled) void publication.waitForSubscription().then(() => {
        if (!settled) { mark("subscription_ready"); finish(); }
      }, () => finish(new MediaReadinessError("publication_rejected")));
      return publication;
    } catch (error) {
      mark("publication_rejected"); finish(new MediaReadinessError("publication_rejected")); throw error;
    }
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  return { ready, dispose() { cancel(); participant.publishTrack = original; } };
}
