import { LocalAudioTrack, type AudioFrame, type AudioSource } from "@livekit/rtc-node";
import { voice } from "@livekit/agents";
import type { StageClock } from "./bench";

/** Numeric measurements only. No audio samples or native handles leave the process. */
export function frameMeasure(frame: AudioFrame) {
  let peak = 0;
  for (const sample of frame.data) peak = Math.max(peak, Math.abs(sample) / 32768);
  return { samples: frame.samplesPerChannel, ms: frame.samplesPerChannel / frame.sampleRate * 1000, peak };
}

/** Local benchmark observer of public methods; preserves track ownership and frame flow. */
export function observeAudioPipeline(clock: StageClock, signal: AbortSignal) {
  const restore: (() => void)[] = [];
  const sources = new WeakMap<AudioSource, number>();
  const tracks = new WeakMap<LocalAudioTrack, number>();
  const nativeSnapshots = new WeakMap<AudioSource, () => Record<string, number | boolean>>();
  let sourceCount = 0, events = 0;
  const mark: StageClock["mark"] = (event, fields) => events++ < 2000 ? clock.mark(event, fields) : clock.now();
  const observeCapture = (target: { captureFrame(frame: AudioFrame): Promise<void> }, source: number, native: boolean) => {
    const original = target.captureFrame;
    let frames = 0, completed = 0, failed = 0, durationMs = 0, peak = 0, last = 0;
    const snapshot = () => ({ source, frames, completed, failed, durationMs: Math.round(durationMs), peak, aborted: signal.aborted });
    target.captureFrame = async function (frame) {
      const m = frameMeasure(frame); frames++; durationMs += m.ms; peak = Math.max(peak, m.peak);
      const capture = frames;
      const report = frames === 1 || clock.now() - last >= 500;
      if (report) { last = clock.now(); mark(native ? "source_capture" : "output_capture", { ...snapshot(), capture }); }
      try { await original.call(this, frame); completed++; }
      catch (error) { failed++; mark(native ? "source_capture_error" : "output_capture_error", { ...snapshot(), capture }); throw error; }
      if (report) mark(native ? "source_captured" : "output_captured", { ...snapshot(), capture });
    };
    restore.push(() => { target.captureFrame = original; });
    return snapshot;
  };
  const create = LocalAudioTrack.createAudioTrack;
  LocalAudioTrack.createAudioTrack = function (name, source) {
    let ordinal = sources.get(source);
    if (ordinal === undefined) {
      ordinal = ++sourceCount; sources.set(source, ordinal);
      const snapshot = observeCapture(source, ordinal, true);
      nativeSnapshots.set(source, snapshot);
      const clear = source.clearQueue, drain = source.waitForPlayout;
      source.clearQueue = function () { mark("source_clear", snapshot()); return clear.call(this); };
      source.waitForPlayout = async function () { mark("source_drain_started", snapshot()); await drain.call(this); mark("source_drained", snapshot()); };
      restore.push(() => { source.clearQueue = clear; source.waitForPlayout = drain; });
    }
    const track = create.call(this, name, source);
    tracks.set(track, ordinal); mark("track_source_link", { source: ordinal });
    return track;
  };
  restore.push(() => { LocalAudioTrack.createAudioTrack = create; });
  return {
    published(track: LocalAudioTrack) { mark("published_source_link", { source: tracks.get(track) ?? 0, matched: tracks.has(track) }); },
    output(output: voice.AudioOutput) {
      const snapshot = observeCapture(output, 0, false);
      const nativeState = () => {
        let node: unknown = output;
        for (let i = 0; node && i < 8; i++) {
          const current = node as { audioSource?: AudioSource; nextInChain?: unknown };
          const state = current.audioSource && nativeSnapshots.get(current.audioSource)?.();
          if (state) return { nativeSource: Number(state.source), nativeFrames: Number(state.frames), nativeCompleted: Number(state.completed), nativeFailed: Number(state.failed) };
          node = current.nextInChain;
        }
        return { nativeSource: 0, nativeFrames: 0, nativeCompleted: 0, nativeFailed: 0 };
      };
      const replayState = () => {
        let node: unknown = output;
        for (let i = 0; node && i < 8; i++) {
          const current = node as { _dialogReplayFrames?: number; _dialogReplayMs?: number; nextInChain?: unknown };
          if (Number.isFinite(current._dialogReplayFrames) && Number.isFinite(current._dialogReplayMs))
            return { replayedFrames: current._dialogReplayFrames!, replayedMs: current._dialogReplayMs! };
          node = current.nextInChain;
        }
        return { replayedFrames: 0, replayedMs: 0 };
      };
      const flush = output.flush, clear = output.clearBuffer, pause = output.pause, resume = output.resume;
      output.flush = function () { mark("output_flush", snapshot()); return flush.call(this); };
      output.clearBuffer = function () { mark("output_clear", snapshot()); return clear.call(this); };
      output.pause = function () { mark("output_pause", snapshot()); return pause.call(this); };
      output.resume = function () { mark("output_resume", snapshot()); return resume.call(this); };
      const started = () => mark("output_playback_started", { ...snapshot(), ...nativeState(), ...replayState() });
      const finished = (event: voice.PlaybackFinishedEvent) => mark("output_playback_finished", { ...snapshot(), ...nativeState(), ...replayState(), playbackMs: event.playbackPosition * 1000, interrupted: event.interrupted });
      output.on(voice.AudioOutput.EVENT_PLAYBACK_STARTED, started);
      output.on(voice.AudioOutput.EVENT_PLAYBACK_FINISHED, finished);
      restore.push(() => {
        output.flush = flush; output.clearBuffer = clear; output.pause = pause; output.resume = resume;
        output.off(voice.AudioOutput.EVENT_PLAYBACK_STARTED, started); output.off(voice.AudioOutput.EVENT_PLAYBACK_FINISHED, finished);
      });
    },
    dispose() { for (const undo of restore.reverse()) undo(); restore.length = 0; },
  };
}
