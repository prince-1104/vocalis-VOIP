export type Claim = { credential: string; mode: "mock" | "live"; participant: string; language: string; speaker: string; sttLanguage: string; ttsLanguage: string; greeting: string; heartbeatMs: number };
export function reference(metadata: string | undefined): string {
  const parsed: unknown = JSON.parse(metadata ?? "{}");
  if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length !== 1
    || !("reference" in parsed) || typeof parsed.reference !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(parsed.reference)) throw new Error("Unauthorized dispatch");
  return parsed.reference;
}
/** A response from Dialog that refused the request; carries only the HTTP status. */
export class DialogDenied extends Error {
  constructor(readonly status: number) { super("Dialog authorization unavailable"); }
}
/**
 * Whether a failed lease renewal ends the session. Only Dialog can revoke a lease, so a 4xx
 * answer is final; timeouts, transport errors and 5xx retry until the lease could have lapsed.
 * Dialog still rejects every request once the lease has expired server-side.
 */
export function leaseLost(error: unknown, now: number, leaseDeadline: number): boolean {
  return (error instanceof DialogDenied && error.status < 500) || now >= leaseDeadline;
}
export class DialogApi {
  readonly base: string;
  constructor(readonly secret = process.env.LIVEKIT_WORKER_SECRET, base = process.env.DIALOG_API_URL) {
    if (!secret || secret.length < 43 || !base) throw new Error("Worker configuration missing");
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid API URL");
    this.base = base.replace(/\/$/, "") + "/api/internal/livekit";
  }
  async request(path: string, body: unknown, claim?: string, signal?: AbortSignal, timeoutMs = 8000): Promise<Response> {
    const response = await fetch(this.base + path, { method: "POST", headers: {
      authorization: `Bearer ${this.secret}`, "Content-Type": "application/json", ...(claim ? { "x-dialog-claim": claim } : {}),
    }, body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]) });
    if (!response.ok) { await response.body?.cancel(); throw new DialogDenied(response.status); }
    return response;
  }
  async json<T>(path: string, body: unknown, claim?: string, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    return (await this.request(path, body, claim, signal, timeoutMs)).json() as Promise<T>;
  }
}
