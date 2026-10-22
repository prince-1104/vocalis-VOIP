import https from "node:https";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { IncomingHttpHeaders } from "node:http";

/**
 * HTTPS client for destinations chosen by tenants (CRM lookup and webhook
 * URLs). Each request resolves the hostname once, requires every answer to be
 * a public unicast address, and connects to exactly that validated address
 * while TLS still verifies the certificate against the original hostname.
 * Redirects are never followed.
 */

export type OutboundBlockReason =
  | "invalid_url"
  | "scheme"
  | "credentials"
  | "port"
  | "hostname"
  | "address"
  | "dns"
  | "redirect";
export type OutboundFailureReason = "timeout" | "too_large" | "tls" | "network";

export class OutboundRequestError extends Error {
  readonly reason: OutboundBlockReason | OutboundFailureReason;
  readonly blocked: boolean;
  readonly code: string;

  constructor(blocked: boolean, reason: OutboundBlockReason | OutboundFailureReason, detail?: string) {
    // Messages never include the URL, resolved address or remote content.
    super(`Outbound request ${blocked ? "blocked" : "failed"} (${reason}${detail ? `: ${detail}` : ""})`);
    this.name = blocked ? "OutboundRequestBlocked" : "OutboundRequestFailed";
    this.reason = reason;
    this.blocked = blocked;
    this.code = `OUTBOUND_${reason.toUpperCase()}`;
  }
}

const blocked = (reason: OutboundBlockReason) => new OutboundRequestError(true, reason);
const failed = (reason: OutboundFailureReason, detail?: string) =>
  new OutboundRequestError(false, reason, detail);

// ── Address classification ─────────────────────────────────────────────

const NON_PUBLIC_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];
// Global unicast is 2000::/3; loopback, unspecified, ULA, link-local,
// multicast, NAT64 and IPv4-compatible forms all fall outside it.
const NON_PUBLIC_V6: Array<[string, number]> = [
  ["2001::", 23], // IETF protocol assignments (Teredo, benchmarking, ORCHID)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 embeds arbitrary IPv4
  ["3fff::", 20], // documentation
];

const v4Blocked = new BlockList();
for (const [network, prefix] of NON_PUBLIC_V4) v4Blocked.addSubnet(network, prefix, "ipv4");
const v6Global = new BlockList();
v6Global.addSubnet("2000::", 3, "ipv6");
const v6Blocked = new BlockList();
for (const [network, prefix] of NON_PUBLIC_V6) v6Blocked.addSubnet(network, prefix, "ipv6");

/** Canonical lowercase IPv6 text, e.g. "::ffff:127.0.0.1" -> "::ffff:7f00:1". */
function canonicalV6(address: string): string | null {
  try {
    return new URL(`http://[${address}]`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/** The embedded IPv4 address of an IPv4-mapped IPv6 address (::ffff:0:0/96). */
function mappedV4(address: string): string | null {
  const canonical = canonicalV6(address);
  const match = canonical && /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!match) return null;
  const high = parseInt(match[1], 16);
  const low = parseInt(match[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/** True only for public unicast IPv4/IPv6 addresses. Anything unparsable is non-public. */
export function isPublicAddress(address: string): boolean {
  try {
    const family = isIP(address);
    if (family === 4) return !v4Blocked.check(address, "ipv4");
    if (family !== 6) return false;
    const v4 = mappedV4(address);
    if (v4) return isPublicAddress(v4);
    return v6Global.check(address, "ipv6") && !v6Blocked.check(address, "ipv6");
  } catch {
    return false;
  }
}

// ── URL policy ─────────────────────────────────────────────────────────

const MAX_URL_LENGTH = 2048;
const HOSTNAME_PATTERN = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/;

function urlHost(url: URL): string {
  const host = url.hostname.toLowerCase();
  return host.startsWith("[") ? host.slice(1, -1) : host.replace(/\.$/, "");
}

/**
 * Synchronous checks that need no DNS: HTTPS only, no embedded credentials,
 * port 443 or 1024-65535, and a hostname that is a public IP literal or a
 * multi-label DNS name. WHATWG parsing normalizes decimal, hex, octal and
 * shortened IPv4 forms (e.g. "0x7f.1") before the address check.
 */
function checkUrl(raw: unknown, isAllowedAddress: (address: string) => boolean): URL {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) throw blocked("invalid_url");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw blocked("invalid_url");
  }
  if (url.protocol !== "https:") throw blocked("scheme");
  if (url.username || url.password) throw blocked("credentials");
  if (url.port !== "") {
    const port = Number(url.port);
    if (port !== 443 && (port < 1024 || port > 65535)) throw blocked("port");
  }
  const host = urlHost(url);
  if (isIP(host)) {
    if (!isAllowedAddress(host)) throw blocked("address");
    return url;
  }
  if (!HOSTNAME_PATTERN.test(host) || host === "localhost" || host.endsWith(".localhost")) {
    throw blocked("hostname");
  }
  return url;
}

// ── Client ─────────────────────────────────────────────────────────────

export type OutboundResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface SafeHttpClientOptions {
  /** DNS resolver; defaults to the system resolver returning all answers. */
  resolve?: OutboundResolver;
  /** Address policy; defaults to public unicast only. */
  isAllowedAddress?: (address: string) => boolean;
  /** Extra trusted CA certificates. Production uses the default trust store. */
  ca?: string | Buffer;
}

export interface OutboundRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Overall deadline covering DNS, connect, TLS and the full response. */
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface OutboundResponse {
  status: number;
  ok: boolean;
  headers: IncomingHttpHeaders;
  text(): string;
  json(): unknown;
}

export interface SafeHttpClient {
  /** Validates a URL without resolving it (configuration-time checks). */
  assertUrl(raw: unknown): URL;
  request(raw: string, init?: OutboundRequestInit): Promise<OutboundResponse>;
}

export const MIN_TIMEOUT_MS = 250;
export const MAX_TIMEOUT_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

const STRIPPED_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "keep-alive",
  "expect",
  "proxy-authorization",
  "proxy-connection",
]);

const systemResolve: OutboundResolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

export function clampTimeout(timeoutMs: unknown): number {
  const value = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(value)));
}

function isTlsError(err: any): boolean {
  return /CERT|TLS|SSL|SELF_SIGNED|ALTNAME|UNABLE_TO|VERIFY|EPROTO/i.test(String(err?.code ?? ""));
}

export function createSafeHttpClient(options: SafeHttpClientOptions = {}): SafeHttpClient {
  const resolve = options.resolve ?? systemResolve;
  const isAllowedAddress = options.isAllowedAddress ?? isPublicAddress;

  async function resolveTarget(url: URL): Promise<{ address: string; family: 4 | 6 }> {
    const host = urlHost(url);
    if (isIP(host)) return { address: host, family: isIP(host) as 4 | 6 };
    let answers: Array<{ address: string; family: number }>;
    try {
      answers = await resolve(host);
    } catch {
      throw blocked("dns");
    }
    if (!Array.isArray(answers) || answers.length === 0) throw blocked("dns");
    // A single non-public answer rejects the name, so a mixed answer cannot
    // steer a later connection attempt to an internal address.
    for (const answer of answers) {
      if (!answer || typeof answer.address !== "string" || !isAllowedAddress(answer.address)) {
        throw blocked("address");
      }
    }
    const chosen = answers[0].address;
    const v4 = isIP(chosen) === 6 ? mappedV4(chosen) : null;
    return v4 ? { address: v4, family: 4 } : { address: chosen, family: isIP(chosen) as 4 | 6 };
  }

  function send(
    url: URL,
    target: { address: string; family: 4 | 6 },
    init: OutboundRequestInit,
    deadline: number,
  ): Promise<OutboundResponse> {
    const maxBytes = init.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      const key = name.toLowerCase();
      if (!STRIPPED_HEADERS.has(key) && !key.startsWith("proxy-")) headers[key] = value;
    }
    headers.host = url.host;
    headers.connection = "close";
    if (init.body !== undefined) headers["content-length"] = String(Buffer.byteLength(init.body));
    const host = urlHost(url);

    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      let request: ReturnType<typeof https.request> | undefined;
      const finish = (err: OutboundRequestError | null, response?: OutboundResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          request?.destroy();
          rejectPromise(err);
        } else {
          resolvePromise(response!);
        }
      };
      const timer = setTimeout(() => finish(failed("timeout")), Math.max(0, deadline - Date.now()));

      try {
        request = https.request(
          {
            // Connect to the validated IP literal: no second DNS lookup happens.
            host: target.address,
            family: target.family,
            port: url.port ? Number(url.port) : 443,
            method: (init.method ?? "GET").toUpperCase(),
            path: `${url.pathname}${url.search}`,
            // TLS SNI and certificate identity use the configured hostname.
            servername: isIP(host) ? undefined : host,
            headers,
            agent: false,
            ca: options.ca,
            rejectUnauthorized: true,
          },
          (res) => {
            const status = res.statusCode ?? 0;
            // Settle before destroying so abort events cannot replace the reason.
            if (status >= 300 && status < 400) {
              finish(blocked("redirect"));
              res.destroy();
              return;
            }
            const declared = Number(res.headers["content-length"]);
            if (Number.isFinite(declared) && declared > maxBytes) {
              finish(failed("too_large"));
              res.destroy();
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > maxBytes) {
                finish(failed("too_large"));
                res.destroy();
                return;
              }
              chunks.push(chunk);
            });
            res.on("end", () => {
              const body = Buffer.concat(chunks);
              finish(null, {
                status,
                ok: status >= 200 && status < 300,
                headers: res.headers,
                text: () => body.toString("utf8"),
                json: () => JSON.parse(body.toString("utf8")),
              });
            });
            res.on("error", (err: any) => finish(failed("network", err?.code)));
            res.on("aborted", () => finish(failed("network", "aborted")));
          },
        );
      } catch {
        // Invalid header names/values or options are rejected synchronously.
        finish(failed("network", "invalid_request"));
        return;
      }
      request.on("error", (err: any) => {
        finish(isTlsError(err) ? failed("tls", err?.code) : failed("network", err?.code));
      });
      request.end(init.body);
    });
  }

  return {
    assertUrl: (raw) => checkUrl(raw, isAllowedAddress),
    async request(raw, init = {}) {
      const deadline = Date.now() + clampTimeout(init.timeoutMs);
      const url = checkUrl(raw, isAllowedAddress);
      let timer: NodeJS.Timeout | undefined;
      const target = await Promise.race([
        resolveTarget(url),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(failed("timeout")), Math.max(0, deadline - Date.now()));
        }),
      ]).finally(() => clearTimeout(timer));
      return send(url, target, init, deadline);
    },
  };
}

/** Error text safe to show tenants: no address, port, URL or remote content. */
export function describeOutboundError(err: unknown): string {
  if (!(err instanceof OutboundRequestError)) return "CRM request failed";
  switch (err.reason) {
    case "timeout":
      return "Request timed out";
    case "too_large":
      return "CRM response exceeded the size limit";
    case "redirect":
      return "CRM responded with a redirect, which is not followed";
    case "tls":
      return "CRM TLS certificate could not be verified";
    case "network":
      return "CRM request failed";
    default:
      return "CRM URL is not allowed: it must be a public HTTPS address";
  }
}
