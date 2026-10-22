import type { NextFunction, Request, Response } from "express";

/**
 * Route-specific CORS. Every decision depends only on the request path and an
 * exact match of the Origin header against configuration; Host, forwarded
 * headers and other request input never widen access. No surface ever sends
 * Access-Control-Allow-Credentials: dashboard auth is a bearer token in the
 * Authorization header, and the public widget carries no ambient credentials.
 *
 *   widget     Public embed API used by the loader script on customer sites.
 *              Any origin, no credentials, GET/POST with Content-Type only.
 *              CORS is not access control here: widget keys, verification and
 *              rate limits are enforced server-side regardless of Origin.
 *   dashboard  Authenticated browser API. Same-origin by default; cross-origin
 *              only for origins listed in DASHBOARD_ORIGINS.
 *   server     CRM API-key routes, provider callbacks and health checks.
 *              Server-to-server; never granted to browsers.
 *   html       SPA and static assets; same-origin only.
 */
export type Surface = "widget" | "dashboard" | "server" | "html";

// Express routing is case-insensitive and ignores one trailing slash, so
// classification lowercases and allows the same slash.
const WIDGET_PUBLIC =
  /^\/api\/widget\/(?:config\/[^/]+|loader\.js|chat|tts|voice-token|crm\/[^/]+(?:\/[^/]+)?)\/?$/;
const SERVER = /^\/api\/(?:crm|twilio|exotel)(?:\/|$)|^\/api\/healthz\/?$/;

export function surfaceFor(path: string): Surface {
  const p = path.toLowerCase();
  if (p !== "/api" && !p.startsWith("/api/")) return "html";
  if (WIDGET_PUBLIC.test(p)) return "widget";
  if (SERVER.test(p)) return "server";
  return "dashboard";
}

export class CorsConfigError extends Error {
  constructor(detail: string) {
    super(`DASHBOARD_ORIGINS is misconfigured: ${detail}`);
    this.name = "CorsConfigError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * DASHBOARD_ORIGINS: comma-separated exact origins (scheme://host[:port]) that
 * may call the dashboard API from another origin. Empty or "none" means
 * same-origin only. Wildcards, "null", paths and credentials are refused; https
 * is required except for loopback hosts outside production. Errors name the
 * entry position, never its value.
 */
export function parseDashboardOrigins(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const raw = (env.DASHBOARD_ORIGINS ?? "").trim();
  if (!raw || raw === "none") return new Set();
  const production = env.NODE_ENV === "production";
  const origins = new Set<string>();
  raw.split(",").forEach((value, index) => {
    const entry = value.trim();
    const position = `entry ${index + 1}`;
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new CorsConfigError(`${position} is not a valid origin`);
    }
    if (entry.includes("*") || url.origin === "null" || url.origin !== entry) {
      throw new CorsConfigError(
        `${position} must be an exact lowercase origin (scheme://host[:port]) without wildcard, path, query or credentials`,
      );
    }
    const local = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
    if (url.protocol !== "https:" && !(local && !production)) {
      throw new CorsConfigError(`${position} must use https (http is allowed only for loopback hosts outside production)`);
    }
    origins.add(entry);
  });
  return origins;
}

interface Grant {
  allowOrigin: string;
  methods: readonly string[];
  headers: readonly string[];
}

const WIDGET_GRANT: Grant = { allowOrigin: "*", methods: ["GET", "POST"], headers: ["content-type"] };
const DASHBOARD_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const DASHBOARD_HEADERS = ["authorization", "content-type"] as const;
const PREFLIGHT_MAX_AGE_SECONDS = "600";

export function corsPolicy(options: { dashboardOrigins: ReadonlySet<string> }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const surface = surfaceFor(req.path);
    const origin = req.headers.origin;
    let grant: Grant | null = null;
    if (surface === "widget") {
      grant = WIDGET_GRANT;
    } else if (surface === "dashboard") {
      // The response differs by Origin, so caches must key on it.
      res.vary("Origin");
      if (typeof origin === "string" && options.dashboardOrigins.has(origin)) {
        grant = { allowOrigin: origin, methods: DASHBOARD_METHODS, headers: DASHBOARD_HEADERS };
      }
    }

    const requestedMethod = req.headers["access-control-request-method"];
    if (req.method === "OPTIONS" && typeof requestedMethod === "string") {
      res.vary("Access-Control-Request-Method").vary("Access-Control-Request-Headers");
      const requestedHeaders = String(req.headers["access-control-request-headers"] ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
      if (
        !grant ||
        !grant.methods.includes(requestedMethod) ||
        requestedHeaders.some((h) => !grant.headers.includes(h))
      ) {
        res.status(403).end();
        return;
      }
      res
        .set("Access-Control-Allow-Origin", grant.allowOrigin)
        .set("Access-Control-Allow-Methods", grant.methods.join(", "))
        .set("Access-Control-Allow-Headers", grant.headers.join(", "))
        .set("Access-Control-Max-Age", PREFLIGHT_MAX_AGE_SECONDS)
        .status(204)
        .end();
      return;
    }

    if (grant) {
      res.set("Access-Control-Allow-Origin", grant.allowOrigin).set("Access-Control-Expose-Headers", "Retry-After");
    }
    next();
  };
}
