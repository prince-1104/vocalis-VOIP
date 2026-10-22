import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { NextFunction, Request, Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Request rate limiting backed by a shared counter store.
 *
 * Counting is a sliding-window approximation: each policy window has a fixed
 * counter, and a request is allowed while
 *   previousWindow * (1 - elapsedFraction) + currentWindow <= max.
 * Every request increments the current counter atomically in the store before
 * it is evaluated, so concurrent requests on any number of application
 * instances cannot overrun a budget. Policies that should only count failures
 * (logins, API-key authentication) refund the increment when the response
 * succeeds.
 *
 * Counter keys are HMACs of the policy and identity; raw IPs, emails, tokens
 * and phone numbers never reach the store or the logs.
 */

export type StoreFailureMode = "closed" | "open";

export interface RateLimitPolicy {
  /** Stable identifier; part of every counter key and log line. */
  readonly name: string;
  readonly windowMs: number;
  readonly max: number;
  /**
   * When the shared store is unreachable: "closed" rejects with 503 (logins,
   * verification, provider-billed operations); "open" serves the request.
   */
  readonly onStoreFailure: StoreFailureMode;
  /** Refund the request's hit when the final status satisfies this predicate. */
  readonly refundWhen?: (status: number) => boolean;
}

export interface LimitRule {
  policy: RateLimitPolicy;
  /** Identity parts for this request, or null when the rule does not apply. */
  identify: (req: Request) => Array<string | number> | null;
}

export interface RateLimitStore {
  readonly kind: "postgres" | "memory";
  /**
   * Atomically adds `delta` to the counter (key, windowStart), never below
   * zero, and returns it together with the previous window's counter.
   */
  add(key: string, windowStart: number, windowMs: number, delta: number): Promise<{ current: number; previous: number }>;
}

// ── Configuration ──────────────────────────────────────────────────────

export class RateLimitConfigError extends Error {
  constructor(detail: string) {
    super(`Rate limiting is misconfigured: ${detail}`);
    this.name = "RateLimitConfigError";
  }
}

export interface RateLimitSettings {
  storeKind: "postgres" | "memory";
  hashKey: Buffer;
}

/**
 * RATE_LIMIT_STORE: "postgres" (default) or "memory". The memory store is
 * process-local and is refused in production, where several instances must
 * share one budget.
 * RATE_LIMIT_HASH_KEY: base64, at least 32 bytes; keys counter identities.
 * Required in production so every instance derives the same counter keys.
 */
export function parseRateLimitSettings(env: NodeJS.ProcessEnv): RateLimitSettings {
  const production = env.NODE_ENV === "production";
  const storeKind = (env.RATE_LIMIT_STORE ?? "postgres").trim() || "postgres";
  if (storeKind !== "postgres" && storeKind !== "memory") {
    throw new RateLimitConfigError("RATE_LIMIT_STORE must be 'postgres' or 'memory'");
  }
  if (storeKind === "memory" && production) {
    throw new RateLimitConfigError("RATE_LIMIT_STORE=memory is process-local and not allowed in production");
  }
  const rawKey = (env.RATE_LIMIT_HASH_KEY ?? "").trim();
  if (!rawKey) {
    if (production) throw new RateLimitConfigError("RATE_LIMIT_HASH_KEY must be set in production");
    return { storeKind, hashKey: randomBytes(32) };
  }
  const key = /^[A-Za-z0-9+/]+={0,2}$/.test(rawKey) ? Buffer.from(rawKey, "base64") : null;
  if (!key || key.toString("base64") !== rawKey || key.length < 32) {
    throw new RateLimitConfigError("RATE_LIMIT_HASH_KEY must be base64 encoding at least 32 bytes");
  }
  return { storeKind, hashKey: key };
}

// ── Stores ─────────────────────────────────────────────────────────────

/** Process-local store for development and tests. */
export function createMemoryRateLimitStore(clock: () => number = Date.now): RateLimitStore {
  const counters = new Map<string, { hits: number; expiresAt: number }>();
  let writes = 0;
  return {
    kind: "memory",
    async add(key, windowStart, windowMs, delta) {
      const id = `${key}@${windowStart}`;
      const entry = counters.get(id) ?? { hits: 0, expiresAt: windowStart + 2 * windowMs };
      entry.hits = Math.max(0, entry.hits + delta);
      counters.set(id, entry);
      if (++writes % 1000 === 0) {
        const now = clock();
        for (const [k, v] of counters) if (v.expiresAt <= now) counters.delete(k);
      }
      return { current: entry.hits, previous: counters.get(`${key}@${windowStart - windowMs}`)?.hits ?? 0 };
    },
  };
}

class StoreTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StoreTimeoutError("rate limit store timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * PostgreSQL store. The insert-or-increment is one statement; concurrent
 * callers on any instance serialize on the counter row.
 */
export function createPostgresRateLimitStore(
  database: { execute: (query: any) => Promise<any> } = db,
  options: { timeoutMs?: number } = {},
): RateLimitStore {
  const timeoutMs = options.timeoutMs ?? 1500;
  let writes = 0;
  return {
    kind: "postgres",
    async add(key, windowStart, windowMs, delta) {
      const expiresAt = new Date(windowStart + 2 * windowMs);
      const result = await withTimeout(
        database.execute(sql`
          with hit as (
            insert into rate_limit_counters as c (bucket_key, window_start, hits, expires_at)
            values (${key}, ${windowStart}, ${Math.max(delta, 0)}, ${expiresAt})
            on conflict (bucket_key, window_start)
            do update set hits = greatest(c.hits + ${delta}, 0)
            returning hits
          )
          select (select hits from hit) as current,
            coalesce((select hits from rate_limit_counters
              where bucket_key = ${key} and window_start = ${windowStart - windowMs}), 0) as previous`),
        timeoutMs,
      );
      const row = (result?.rows ?? result)?.[0];
      if (!row || row.current === null || row.current === undefined) throw new Error("rate limit store returned no row");
      if (++writes % 500 === 0) {
        database
          .execute(sql`delete from rate_limit_counters where ctid in (
            select ctid from rate_limit_counters where expires_at < now() limit 1000)`)
          .catch(() => {});
      }
      return { current: Number(row.current), previous: Number(row.previous) };
    },
  };
}

// ── Process state ──────────────────────────────────────────────────────

let settings: RateLimitSettings | null = null;
let store: RateLimitStore | null = null;
let clock: () => number = Date.now;

/** Validates configuration; called at startup and on first use. */
export function rateLimitSettings(): RateLimitSettings {
  settings ??= parseRateLimitSettings(process.env);
  return settings;
}

export function rateLimitStore(): RateLimitStore {
  store ??=
    rateLimitSettings().storeKind === "memory"
      ? createMemoryRateLimitStore(() => clock())
      : createPostgresRateLimitStore();
  return store;
}

/** Test hooks: inject a store or clock; reset restores defaults. */
export function configureRateLimitingForTests(options: { store?: RateLimitStore; clock?: () => number }): void {
  if (options.store) store = options.store;
  if (options.clock) clock = options.clock;
}
export function resetRateLimitingForTests(): void {
  store = null;
  clock = Date.now;
  loggedRejections.clear();
  lastFailureLog = 0;
}

/** Startup probe: confirms the shared store accepts writes. Never throws. */
export async function probeRateLimitStore(): Promise<boolean> {
  try {
    const now = clock();
    await rateLimitStore().add(counterKey({ name: "probe" }, ["startup"]), now - (now % 60_000), 60_000, 0);
    return true;
  } catch (err) {
    logger.error({ event: "rate_limit_store_unavailable", context: "startup", err }, "Rate limit store unavailable at startup");
    return false;
  }
}

// ── Identity ───────────────────────────────────────────────────────────

function expandIPv6(address: string): string[] {
  const [head, tail] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail ? tail.split(":") : [];
  const fill = address.includes("::") ? Array(8 - left.length - right.length).fill("0") : [];
  return [...left, ...fill, ...right].map((group) => group.padStart(4, "0").toLowerCase());
}

/**
 * Client address as resolved by Express under the configured trust-proxy
 * policy. IPv6 clients are grouped by /64, the smallest block an end user
 * normally controls, so rotating addresses inside it does not reset budgets.
 */
export function clientAddress(req: Request): string {
  let ip = (req.ip ?? req.socket?.remoteAddress ?? "").split("%")[0];
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  const family = isIP(ip);
  if (family === 4) return ip;
  if (family === 6) return `${expandIPv6(ip).slice(0, 4).join(":")}::/64`;
  return "unknown";
}

export function counterKey(policy: { name: string }, parts: Array<string | number>): string {
  const digest = createHmac("sha256", rateLimitSettings().hashKey)
    .update([policy.name, ...parts.map(String)].join("\u0000"))
    .digest("base64url")
    .slice(0, 32);
  return `${policy.name}:${digest}`;
}

// ── Evaluation ─────────────────────────────────────────────────────────

export type RateLimitDecision =
  | { outcome: "allowed"; key: string; windowStart: number }
  | { outcome: "limited"; key: string; windowStart: number; retryAfterSeconds: number; firstRejection: boolean }
  | { outcome: "unavailable" };

/** Seconds until one more request would be admitted. */
function retryAfter(policy: RateLimitPolicy, elapsed: number, current: number, previous: number): number {
  const { max, windowMs } = policy;
  let waitMs: number;
  if (current + 1 <= max && previous > 0) {
    // Wait for the previous window's weight to decay enough.
    waitMs = windowMs * (1 - (max - current - 1) / previous) - elapsed;
  } else {
    // This window is exhausted; in the next one it becomes the previous window.
    waitMs = windowMs - elapsed + windowMs * Math.max(0, 1 - (max - 1) / Math.max(current, 1));
  }
  return Math.min(Math.max(Math.ceil(waitMs / 1000), 1), Math.ceil((2 * windowMs) / 1000));
}

export async function consume(policy: RateLimitPolicy, parts: Array<string | number>): Promise<RateLimitDecision> {
  const key = counterKey(policy, parts);
  const now = clock();
  const windowStart = now - (now % policy.windowMs);
  const elapsed = now - windowStart;
  let counts: { current: number; previous: number };
  try {
    counts = await rateLimitStore().add(key, windowStart, policy.windowMs, 1);
  } catch (err) {
    storeFailure(policy, err);
    return policy.onStoreFailure === "open" ? { outcome: "allowed", key, windowStart } : { outcome: "unavailable" };
  }
  const estimate = counts.previous * (1 - elapsed / policy.windowMs) + counts.current;
  if (estimate <= policy.max) return { outcome: "allowed", key, windowStart };
  return {
    outcome: "limited",
    key,
    windowStart,
    retryAfterSeconds: retryAfter(policy, elapsed, counts.current, counts.previous),
    firstRejection: firstRejection(`${key}@${windowStart}`),
  };
}

// Only the first rejection per counter window (per instance) is logged, so a
// flood cannot flood the logs.
const loggedRejections = new Set<string>();
function firstRejection(id: string): boolean {
  if (loggedRejections.has(id)) return false;
  if (loggedRejections.size >= 10_000) loggedRejections.clear();
  loggedRejections.add(id);
  return true;
}

let lastFailureLog = 0;
function storeFailure(policy: RateLimitPolicy, err: unknown) {
  const now = Date.now();
  if (now - lastFailureLog < 30_000) return;
  lastFailureLog = now;
  logger.error(
    {
      event: "rate_limit_store_unavailable",
      policy: policy.name,
      failMode: policy.onStoreFailure,
      reason: err instanceof StoreTimeoutError ? "timeout" : "error",
    },
    "Rate limit store unavailable",
  );
}

// ── HTTP integration ───────────────────────────────────────────────────

export type RejectResponder = (res: Response, retryAfterSeconds: number) => void;

export const defaultReject: RejectResponder = (res, retryAfterSeconds) => {
  res
    .set("Retry-After", String(retryAfterSeconds))
    .status(429)
    .json({ error: "rate_limited", message: "Too many requests. Please try again later.", retryAfterSeconds });
};

function unavailable(res: Response) {
  res
    .set("Retry-After", "30")
    .status(503)
    .json({ error: "temporarily_unavailable", message: "Service temporarily unavailable. Please try again shortly." });
}

const APPLIED = Symbol("rateLimitPolicies");
const STOPPED = Symbol("rateLimitStopped");

function refund(policy: RateLimitPolicy, key: string, windowStart: number) {
  rateLimitStore().add(key, windowStart, policy.windowMs, -1).catch(() => {});
}

/**
 * Applies `rules` in order. Returns true when the request may proceed;
 * otherwise a 429 (or 503 for a fail-closed store outage) has been sent.
 * A policy already applied to this request (e.g. by an earlier router) is
 * not counted twice. Failure-only policies (those with `refundWhen`) are also
 * refunded when the limiter itself stops the request, since the protected
 * check (password, API key) never ran.
 */
export async function enforceRateLimit(
  req: Request,
  res: Response,
  rules: LimitRule[],
  reject: RejectResponder = defaultReject,
): Promise<boolean> {
  const applied: Set<string> = ((req as any)[APPLIED] ??= new Set<string>());
  for (const rule of rules) {
    if (applied.has(rule.policy.name)) continue;
    const parts = rule.identify(req);
    if (!parts) continue;
    applied.add(rule.policy.name);
    const decision = await consume(rule.policy, parts);
    const { refundWhen } = rule.policy;
    if (decision.outcome === "allowed") {
      if (refundWhen) {
        res.once("finish", () => {
          if ((req as any)[STOPPED] || refundWhen(res.statusCode)) refund(rule.policy, decision.key, decision.windowStart);
        });
      }
      continue;
    }
    (req as any)[STOPPED] = true;
    if (decision.outcome === "unavailable") {
      unavailable(res);
      return false;
    }
    if (refundWhen) refund(rule.policy, decision.key, decision.windowStart);
    if (decision.firstRejection) {
      logger.warn({ event: "rate_limited", policy: rule.policy.name, method: req.method }, "Request rate limited");
    }
    reject(res, decision.retryAfterSeconds);
    return false;
  }
  return true;
}

// Request params are typed `any` so Express still infers route params for the
// handlers that follow this middleware.
export function rateLimit(
  rules: LimitRule[],
  options: { reject?: RejectResponder; methods?: string[] } = {},
): (req: Request<any>, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    if (options.methods && !options.methods.includes(req.method)) return next();
    enforceRateLimit(req, res, rules, options.reject).then((ok) => ok && next(), next);
  };
}
