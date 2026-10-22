/**
 * Campaign calling windows. A window is a campaign-level local wall-clock
 * range (HH:MM–HH:MM, same day, every day) in an IANA time zone, evaluated
 * with the time-zone database bundled in Node's ICU so DST and zone rule
 * changes follow the runtime's tzdata. Calls are not started in the last
 * DISPATCH_SAFETY_MARGIN_MINUTES of a window.
 */

export const DEFAULT_CAMPAIGN_TIMEZONE = "Asia/Kolkata";
export const DISPATCH_SAFETY_MARGIN_MINUTES = 5;

export interface CallingWindowConfig {
  startTime: string | null;
  endTime: string | null;
  timezone: string | null;
}

export type CallingWindowDecision =
  | { status: "open"; closesAt: Date }
  | { status: "closed"; opensAt: Date }
  | { status: "invalid"; reason: string };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOf(value: string | null | undefined): number | null {
  const m = typeof value === "string" ? HHMM.exec(value) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

let zones: Set<string> | null = null;
/** Only IANA zone names (or their aliases) known to the runtime; no fixed offsets or abbreviations. */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || !timeZone || timeZone.length > 64) return false;
  zones ??= new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return false;
  }
  return zones.has(timeZone) || zones.has(canonical);
}

/** Save-time validation. Returns the problem in admin-readable form, or null. */
export function callingWindowProblem(config: CallingWindowConfig): string | null {
  const start = minutesOf(config.startTime);
  const end = minutesOf(config.endTime);
  if (start === null || end === null) return "Calling hours must be HH:MM (24-hour), e.g. 09:00 and 17:00.";
  if (end <= start) return "The calling window must end after it starts on the same day (overnight windows are not supported).";
  if (end - start <= DISPATCH_SAFETY_MARGIN_MINUTES) {
    return `The calling window must be longer than ${DISPATCH_SAFETY_MARGIN_MINUTES} minutes.`;
  }
  if (!isValidTimeZone(config.timezone)) return "Time zone must be an IANA name such as Asia/Kolkata.";
  return null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function localParts(at: Date, timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(at)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { year: p.year, month: p.month, day: p.day, minutes: p.hour * 60 + p.minute + p.second / 60 };
}

function offsetMs(at: number, timeZone: string): number {
  const p = localParts(new Date(at), timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0) + Math.round(p.minutes * 60) * 1000;
  return wall - Math.floor(at / 1000) * 1000;
}

/**
 * Instant of local wall time (y-m-d, minutes) in the zone. An ambiguous time
 * (DST fall-back) resolves to its first occurrence; a time skipped by a DST
 * gap is shifted forward by the gap (02:30 → 03:30).
 */
export function zonedWallTimeToUtc(year: number, month: number, day: number, minutes: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day, 0, minutes);
  const candidates = new Set<number>();
  for (const probe of [wall - 36 * 3600_000, wall, wall + 36 * 3600_000]) {
    candidates.add(wall - offsetMs(probe, timeZone));
  }
  const exact = [...candidates].filter((t) => wall - offsetMs(t, timeZone) === t).sort((a, b) => a - b);
  if (exact.length) return new Date(exact[0]);
  // Nonexistent local time: the earliest candidate whose wall clock is past it.
  const after = [...candidates]
    .filter((t) => t + offsetMs(t, timeZone) >= wall)
    .sort((a, b) => a - b);
  return new Date(after[0] ?? wall);
}

function addDays(year: number, month: number, day: number, days: number) {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Decision for starting a call at `now`. Missing or invalid configuration is
 * "invalid": no default window is substituted.
 */
export function evaluateCallingWindow(
  config: CallingWindowConfig,
  now: Date,
  marginMinutes = DISPATCH_SAFETY_MARGIN_MINUTES,
): CallingWindowDecision {
  const problem = callingWindowProblem(config);
  if (problem) return { status: "invalid", reason: problem };
  const tz = config.timezone!;
  const start = minutesOf(config.startTime)!;
  const end = minutesOf(config.endTime)!;
  const local = localParts(now, tz);
  if (local.minutes >= start && local.minutes < end - marginMinutes) {
    return { status: "open", closesAt: zonedWallTimeToUtc(local.year, local.month, local.day, end, tz) };
  }
  const day = local.minutes < start ? local : addDays(local.year, local.month, local.day, 1);
  return { status: "closed", opensAt: zonedWallTimeToUtc(day.year, day.month, day.day, start, tz) };
}
