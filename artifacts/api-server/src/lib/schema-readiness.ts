import {
  describeDatabaseError,
  inspectSchema,
  isDatabaseUnavailable,
  type Queryable,
  type SchemaReport,
} from "@workspace/db/migrations";

export type StartupBlockReason =
  | "database_unavailable"
  | "not_initialized"
  | "migrations_pending"
  | "schema_incomplete"
  | "schema_check_failed";

/** Startup refusal; `message` and `details` contain object names and codes only. */
export class StartupBlockedError extends Error {
  constructor(readonly reason: StartupBlockReason, message: string, readonly details: string[] = []) {
    super(message);
    this.name = "StartupBlockedError";
  }
}

const REMEDY = "run `pnpm --filter @workspace/api-server run db:migrate status` (see docs/production-readiness/database-migrations-and-startup.md)";

export interface SchemaWaitOptions {
  /** How long to keep retrying an unreachable database before giving up. */
  timeoutMs?: number;
  retryMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onRetry?: (attempt: number, error: string) => void;
}

/**
 * Resolves only when the database records every committed migration and has
 * every table, column and integrity rule the code relies on. An unreachable
 * database is retried until `timeoutMs`; an incompatible schema fails at once,
 * since waiting cannot fix it. Never changes the schema.
 */
export async function waitForCompatibleSchema(
  db: Queryable,
  options: SchemaWaitOptions = {},
): Promise<SchemaReport> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retryMs = options.retryMs ?? 2_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    let report: SchemaReport;
    try {
      report = await inspectSchema(db);
    } catch (err) {
      const description = describeDatabaseError(err);
      if (!isDatabaseUnavailable(err))
        throw new StartupBlockedError("schema_check_failed", `Schema check failed: ${description}`);
      if (now() + retryMs > deadline)
        throw new StartupBlockedError("database_unavailable", `Database unavailable after ${attempt} attempts: ${description}`);
      options.onRetry?.(attempt, description);
      await sleep(retryMs);
      continue;
    }
    switch (report.status) {
      case "ready":
        return report;
      case "not_initialized":
        throw new StartupBlockedError("not_initialized", `Database has no migration history; ${REMEDY}`, report.missing);
      case "migrations_pending":
        throw new StartupBlockedError("migrations_pending", `Database is missing committed migrations; ${REMEDY}`, report.pending);
      case "schema_incomplete":
        throw new StartupBlockedError("schema_incomplete", `Database schema lacks objects this build requires; ${REMEDY}`, report.missing);
    }
  }
}

export type ReadinessState = "starting" | "ready" | "blocked";

/**
 * Readiness (may this instance take traffic) as opposed to liveness (is the
 * process alive). Ready requires a passed startup schema check and a database
 * that currently answers; results are cached briefly so probes cannot load it.
 */
export function createReadiness(db: Queryable, { probeTimeoutMs = 2_000, cacheMs = 1_000, now = Date.now } = {}) {
  let state: ReadinessState = "starting";
  let cached: { at: number; ok: boolean } | null = null;
  let inflight: Promise<boolean> | null = null;

  async function probe(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        db.query("select 1").then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), probeTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    markReady() { state = "ready"; },
    markBlocked() { state = "blocked"; },
    get state() { return state; },
    async check(): Promise<{ ready: boolean; status: string }> {
      if (state !== "ready") return { ready: false, status: state };
      if (!cached || now() - cached.at >= cacheMs) {
        inflight ??= probe().finally(() => { inflight = null; });
        cached = { at: now(), ok: await inflight };
      }
      return cached.ok ? { ready: true, status: "ready" } : { ready: false, status: "database_unavailable" };
    },
  };
}

export interface StartupSteps {
  checkSchema: () => Promise<unknown>;
  /** Other dependency checks that must pass before serving (e.g. rate-limit store). */
  prepare: () => Promise<void>;
  listen: () => Promise<void>;
  startWorkers: () => void;
  markReady: () => void;
}

/** Schema first; nothing listens or runs background work against an incompatible database. */
export async function runStartup(steps: StartupSteps): Promise<void> {
  await steps.checkSchema();
  await steps.prepare();
  await steps.listen();
  steps.startWorkers();
  steps.markReady();
}
