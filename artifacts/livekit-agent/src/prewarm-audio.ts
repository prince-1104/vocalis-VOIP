import { AudioSource, AudioFrame } from "@livekit/rtc-node";

/** Validate native audio before advertising a child as usable or claiming a session. */
export async function prewarmAudio(create: () => Pick<AudioSource, "captureFrame" | "waitForPlayout" | "close"> = () => new AudioSource(24000, 1)) {
  const source = create();
  try {
    await source.captureFrame(new AudioFrame(new Int16Array(2400), 24000, 1, 2400));
    await source.waitForPlayout();
  } finally { await source.close(); }
}
