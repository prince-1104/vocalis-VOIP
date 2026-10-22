/**
 * `drizzle-kit push` diffs src/schema against a live database and applies the
 * difference. On a migration-managed database it drops integrity rules that
 * only migrations create (0008's CHECK constraints). It is therefore allowed
 * only against a database positively identified as a throwaway local one:
 *
 * - DATABASE_URL is a postgres:// or postgresql:// URL with an explicit
 *   loopback host (localhost, 127.0.0.1, [::1]) and no query parameters
 *   (which could redirect the host or change connection behavior);
 * - the database name matches dialog_test_* or dialog_scratch_*;
 * - DIALOG_SCHEMA_PUSH_DATABASE names that same database (explicit consent);
 * - NODE_ENV is not "production".
 *
 * Everything else is refused, including anything that cannot be parsed or
 * classified. Reasons never include the URL or its credentials.
 */
export const PUSH_DATABASE_NAME = /^dialog_(test|scratch)_[a-z0-9_]+$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type PushDecision = { allowed: true; database: string } | { allowed: false; reason: string };

export function classifyPushTarget(env: Record<string, string | undefined>): PushDecision {
  const refuse = (reason: string): PushDecision => ({ allowed: false, reason });
  if (env.NODE_ENV === "production") return refuse("NODE_ENV is production");
  const raw = env.DATABASE_URL;
  if (!raw) return refuse("DATABASE_URL is not set");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("DATABASE_URL is not a valid URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    return refuse("DATABASE_URL is not a postgres:// URL");
  if (!url.hostname) return refuse("DATABASE_URL has no explicit host");
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return refuse("database host is not loopback");
  if (url.search || url.hash) return refuse("DATABASE_URL has query parameters, which can redirect the connection");
  let database: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    return refuse("database name cannot be decoded");
  }
  if (!PUSH_DATABASE_NAME.test(database))
    return refuse("database name is not an approved throwaway name (dialog_test_* or dialog_scratch_*)");
  if (env.DIALOG_SCHEMA_PUSH_DATABASE !== database)
    return refuse("DIALOG_SCHEMA_PUSH_DATABASE must name the target database to confirm the push");
  return { allowed: true, database };
}

/** True when the drizzle-kit command line is a schema push. */
export function isPushCommand(argv: readonly string[]): boolean {
  return argv.slice(2).some((arg) => arg === "push");
}
