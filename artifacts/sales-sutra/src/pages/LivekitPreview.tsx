import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, RemoteAudioTrack, ConnectionState } from "livekit-client";
import { adminAuthHeaders } from "@/lib/admin-fetch";
import { useAuth } from "@/hooks/use-auth";

export default function LivekitPreview() {
  const { role } = useAuth();
  const [status, setStatus] = useState("Ready");
  const room = useRef<Room | null>(null);
  const id = useRef<string | null>(null);
  const output = useRef<HTMLDivElement>(null);
  const [transcript, setTranscript] = useState<string[]>([]);
  async function stop() {
    const previous = id.current; id.current = null;
    await room.current?.disconnect(); room.current = null;
    output.current?.replaceChildren();
    if (previous) await fetch(`/api/dev/livekit/sessions/${previous}`, { method: "DELETE", headers: adminAuthHeaders() });
    setStatus("Stopped");
  }
  useEffect(() => () => { void stop(); }, []);
  if (!import.meta.env.DEV || !["admin", "superadmin"].includes(role ?? "")) return <p>Preview unavailable.</p>;
  async function start() {
    setStatus("Connecting"); setTranscript([]);
    try {
      const response = await fetch("/api/dev/livekit/sessions", { method: "POST", headers: { ...adminAuthHeaders(), "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error("Unavailable");
      const data = await response.json(); id.current = data.id;
      const connection = new Room({ adaptiveStream: false, dynacast: false }); room.current = connection;
      const diagnostic = (e: string, correlation?: string) => window.dispatchEvent(new CustomEvent("dialog-media", { detail: { e, t: performance.now(), correlation: /^[0-9a-f-]{36}$/.test(correlation ?? "") ? correlation : undefined } }));
      connection.on(RoomEvent.ParticipantDisconnected, participant => {
        if (/^[0-9a-f-]{36}$/.test(participant.attributes["dialog.diagnostic"] ?? "") && room.current === connection) {
          diagnostic("browser_agent_disconnected", participant.attributes["dialog.diagnostic"]);
          setStatus("Disconnected");
        }
      });
      connection.on(RoomEvent.TrackPublished, (_publication, participant) => diagnostic("browser_track_discovered", participant.attributes["dialog.diagnostic"]));
      connection.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        if (track.kind === Track.Kind.Audio) {
          diagnostic("browser_track_subscribed", participant.attributes["dialog.diagnostic"]);
          const element = track.attach();
          element.addEventListener("playing", () => diagnostic("browser_playing", participant.attributes["dialog.diagnostic"]), { once: true });
          output.current?.appendChild(element);
          if (track instanceof RemoteAudioTrack) {
            const deadline = performance.now() + 12000;
            const poll = async () => {
              if (connection.state !== ConnectionState.Connected || performance.now() >= deadline) return;
              try {
                const stats = await track.getReceiverStats();
                if ((stats?.totalSamplesDuration ?? 0) > 0) {
                  diagnostic("browser_first_audio_samples", participant.attributes["dialog.diagnostic"]); return;
                }
              } catch { return; }
              setTimeout(() => { void poll(); }, 100);
            };
            void poll();
          }
        }
      });
      connection.on(RoomEvent.TranscriptionReceived, segments => setTranscript(previous => [...previous, ...segments.filter(s => s.final).map(s => s.text)].slice(-30)));
      connection.on(RoomEvent.Disconnected, () => { setStatus("Disconnected"); });
      // Dev-only: hand local benchmark stage timings (numbers only) to the smoke harness.
      connection.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
        if (topic === "dialog.bench") window.dispatchEvent(new CustomEvent("dialog-bench", { detail: new TextDecoder().decode(payload) }));
      });
      await connection.connect(data.url, data.token);
      await connection.startAudio();
      // DTX stops packets during silence, which starves server-side endpointing of the
      // trailing silence it needs to close a turn; the preview always sends audio frames.
      await connection.localParticipant.setMicrophoneEnabled(true, undefined, { dtx: false, red: false });
      setStatus("Connected — mocked speech providers");
    } catch { await stop(); setStatus("Preview unavailable"); }
  }
  return <main className="p-8 space-y-4">
    <h1 className="text-2xl">Local voice preview</h1>
    <p>Development only. Audio stays in the local LiveKit room. Speech responses use deterministic fixtures.</p>
    <p role="status">{status}</p>
    <button onClick={() => void start()} disabled={!!room.current || status === "Connecting"}>Start preview</button>{" "}
    <button onClick={() => void stop()}>Stop preview</button>
    <div ref={output} /><div aria-label="Conversation">{transcript.map((text, i) => <p key={i}>{text}</p>)}</div>
  </main>;
}
