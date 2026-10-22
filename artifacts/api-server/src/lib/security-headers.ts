import type { Express, NextFunction, Request, Response } from "express";
import { corsPolicy, parseDashboardOrigins, surfaceFor } from "./cors-policy";

export class SecurityHeadersConfigError extends Error {
  constructor(detail: string) {
    super(`Security header configuration is invalid: ${detail}`);
    this.name = "SecurityHeadersConfigError";
  }
}

export interface SecurityHeaderSettings {
  production: boolean;
  /** Strict-Transport-Security max-age in seconds; null leaves HSTS to the proxy (or off). */
  hstsMaxAge: number | null;
}

/**
 * HSTS_MAX_AGE (seconds, 300..63072000) enables Strict-Transport-Security in
 * production only, and only when PUBLIC_BASE_URL is https. It is opt-in so a
 * reverse proxy that already sends HSTS does not get a conflicting duplicate.
 * includeSubDomains/preload are never sent: sibling hosts are not under
 * this application's control.
 */
export function parseSecurityHeaderSettings(env: NodeJS.ProcessEnv): SecurityHeaderSettings {
  const production = env.NODE_ENV === "production";
  const raw = (env.HSTS_MAX_AGE ?? "").trim();
  if (!raw || raw === "0") return { production, hstsMaxAge: null };
  const value = /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= 300 && value <= 63_072_000)) {
    throw new SecurityHeadersConfigError("HSTS_MAX_AGE must be a whole number of seconds between 300 and 63072000");
  }
  if (!production) return { production, hstsMaxAge: null };
  if (!(env.PUBLIC_BASE_URL ?? "").trim().startsWith("https://")) {
    throw new SecurityHeadersConfigError("HSTS_MAX_AGE requires an https PUBLIC_BASE_URL");
  }
  return { production, hstsMaxAge: value };
}

/**
 * Policy for the dashboard SPA and static pages, derived from what they load:
 * hashed same-origin bundles; Google Fonts; inline styles (React style
 * blocks, chart themes, and the widget loader's injected markup on the demo
 * pages); the same-origin widget loader, which pulls the Twilio Voice SDK from
 * sdk.twilio.com and plays data: audio; OpenAI voice samples on the agent page.
 * No inline or eval'd script is allowed.
 */
export function htmlContentSecurityPolicy(production: boolean): string {
  return [
    "default-src 'self'",
    "script-src 'self' https://sdk.twilio.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://www.transparenttextures.com",
    "media-src 'self' data: blob: https://cdn.openai.com https://sdk.twilio.com https://media.twiliocdn.com",
    "connect-src 'self' https://*.twilio.com wss://*.twilio.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // Development previews (e.g. the Replit workspace) embed the app in a frame.
    ...(production ? ["frame-ancestors 'none'"] : []),
  ].join("; ");
}

/** API responses are data, never documents: nothing may load or frame them. */
export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const HTML_PERMISSIONS_POLICY = "camera=(), geolocation=(), payment=(), usb=(), microphone=(self)";

export function securityHeaders(settings: SecurityHeaderSettings) {
  const htmlCsp = htmlContentSecurityPolicy(settings.production);
  return (req: Request, res: Response, next: NextFunction) => {
    res.set("X-Content-Type-Options", "nosniff");
    if (settings.hstsMaxAge) res.set("Strict-Transport-Security", `max-age=${settings.hstsMaxAge}`);
    if (surfaceFor(req.path) === "html") {
      res
        .set("Content-Security-Policy", htmlCsp)
        .set("Referrer-Policy", "same-origin")
        .set("Cross-Origin-Opener-Policy", "same-origin")
        .set("Permissions-Policy", HTML_PERMISSIONS_POLICY);
      if (settings.production) res.set("X-Frame-Options", "DENY");
    } else {
      // Covers JSON, the widget loader script, TwiML and audio. A document CSP
      // on these would be meaningless; this one stops them rendering as pages.
      res
        .set("Content-Security-Policy", API_CONTENT_SECURITY_POLICY)
        .set("Referrer-Policy", "no-referrer")
        .set("X-Frame-Options", "DENY")
        // Auth tokens, customer data and per-tenant config must not be stored
        // by browsers or shared caches. Routes may override when safe.
        .set("Cache-Control", "no-store");
    }
    next();
  };
}

/**
 * Installs response headers and CORS. Must run before body parsing and routing
 * so preflights, parse errors and every error response carry the same
 * headers. Invalid configuration throws, so the server does not start.
 */
export function installHttpSecurity(app: Express, env: NodeJS.ProcessEnv): void {
  const headerSettings = parseSecurityHeaderSettings(env);
  const dashboardOrigins = parseDashboardOrigins(env);
  app.disable("x-powered-by");
  app.use(securityHeaders(headerSettings));
  app.use(corsPolicy({ dashboardOrigins }));
}
