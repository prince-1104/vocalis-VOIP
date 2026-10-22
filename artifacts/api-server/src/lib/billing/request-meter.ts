import { randomUUID } from "node:crypto";
import { logger } from "../logger";
import { aiWorkHold, type AiWorkEstimate } from "./estimates";
import { releaseReservation, reserveBudget, SpendLimitError, type Reservation } from "./spend-budget";
import { createUsageScope, type UsageScope } from "./usage-ledger";

const REQUEST_HOLD_TTL_MS = 10 * 60_000;

/**
 * Usage and budget for one HTTP request that may or may not do paid work.
 * Free paths never touch the budget; the first paid provider request takes a
 * single hold (refused with SpendLimitError over a hard limit or when budget
 * state is unavailable), released once the request's usage is recorded.
 */
export interface RequestMeter {
  readonly usage: UsageScope;
  ensureBudget(): Promise<void>;
  finish(): Promise<void>;
}

export function createRequestMeter(params: {
  userId: number;
  source: string;
  estimate: AiWorkEstimate;
  sessionRef?: string | null;
}): RequestMeter {
  const requestId = randomUUID();
  const usage = createUsageScope({
    userId: params.userId,
    source: params.source,
    sessionRef: params.sessionRef ?? null,
    keyPrefix: `${params.source}:${requestId}`,
  });
  let hold: Promise<Reservation> | null = null;
  return {
    usage,
    ensureBudget() {
      hold ??= aiWorkHold(params.estimate)
        .catch((err) => {
          logger.error({ err, source: params.source }, "Request hold could not be sized");
          throw new SpendLimitError("budget_unavailable");
        })
        .then((amount) => reserveBudget({
          userId: params.userId,
          key: `${params.source}:${requestId}`,
          amount,
          source: params.source,
          ttlMs: REQUEST_HOLD_TTL_MS,
        }));
      return hold.then(() => undefined);
    },
    async finish() {
      await usage.flush();
      const held = await hold?.catch(() => null);
      if (!held) return;
      await releaseReservation(held.tenantId, held.key, "request_complete")
        .catch((err) => logger.error({ err, source: params.source }, "Request budget release failed"));
    },
  };
}
