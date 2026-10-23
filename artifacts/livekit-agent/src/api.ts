export type Claim = { credential: string; mode: "mock" | "live"; participant: string; language: string; speaker: string; sttLanguage: string; ttsLanguage: string; greeting: string; heartbeatMs: number };
export function reference(metadata: string | undefined): string {
  const parsed: unknown = JSON.parse(metadata ?? "{}");
  if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length !== 1
    || !("reference" in parsed) || typeof parsed.reference !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(parsed.reference)) throw new Error("Unauthorized dispatch");
  return parsed.reference;
}
export class DialogApi {
  readonly base: string;
  constructor(readonly secret = process.env.LIVEKIT_WORKER_SECRET, base = process.env.DIALOG_API_URL) {
    if (!secret || secret.length < 43 || !base) throw new Error("Worker configuration missing");
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid API URL");
    this.base = base.replace(/\/$/, "") + "/api/internal/livekit";
  }
  async request(path: string, body: unknown, claim?: string, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(this.base + path, { method: "POST", headers: {
      authorization: `Bearer ${this.secret}`, "Content-Type": "application/json", ...(claim ? { "x-dialog-claim": claim } : {}),
    }, body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]) });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Dialog authorization unavailable"); }
    return response;
  }
  async json<T>(path: string, body: unknown, claim?: string, signal?: AbortSignal): Promise<T> {
    return (await this.request(path, body, claim, signal)).json() as Promise<T>;
  }
}
