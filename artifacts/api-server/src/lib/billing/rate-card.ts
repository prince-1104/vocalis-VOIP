import { createHash } from "node:crypto";
import { db, billingRateCardsTable, platformSettingsTable, DEFAULT_API_RATES, CONFIGURABLE_RATE_KEYS } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { UsageCategory } from "@workspace/db";

import type { Connection } from "./connection";

export const PLATFORM_CURRENCY = "USD";

export interface RateCard {
  id: number;
  version: string;
  currency: string;
  rates: Record<string, number>;
}

const CACHE_TTL_MS = 5 * 60_000;
let cached: { card: RateCard; at: number } | null = null;

export function invalidateRateCard(): void {
  cached = null;
}

/** Defaults overridden by `rate:*` platform settings; only known keys, only finite non-negative values. */
export async function effectiveRates(connection: Connection = db): Promise<Record<string, number>> {
  const rows = await connection.select().from(platformSettingsTable);
  const known = new Set(CONFIGURABLE_RATE_KEYS);
  const rates: Record<string, number> = { ...DEFAULT_API_RATES };
  for (const row of rows) {
    if (!row.key.startsWith("rate:")) continue;
    const key = row.key.slice(5);
    const value = Number(row.value);
    if (known.has(key) && Number.isFinite(value) && value >= 0) rates[key] = value;
  }
  return rates;
}

function versionOf(rates: Record<string, number>): string {
  const canonical = JSON.stringify(Object.keys(rates).sort().map((key) => [key, rates[key]]));
  return `rc-${createHash("sha256").update(`${PLATFORM_CURRENCY}|${canonical}`).digest("hex").slice(0, 16)}`;
}

/**
 * The rate card in force now. Identical rates always map to the same immutable
 * version, so concurrent instances converge on one row.
 */
export async function currentRateCard(connection: Connection = db): Promise<RateCard> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.card;
  const rates = await effectiveRates(connection);
  const version = versionOf(rates);
  await connection.insert(billingRateCardsTable)
    .values({ version, currency: PLATFORM_CURRENCY, rates, source: "platform_settings" })
    .onConflictDoNothing();
  const row = await connection.query.billingRateCardsTable.findFirst({
    where: eq(billingRateCardsTable.version, version),
  });
  if (!row) throw new Error("Rate card could not be stored");
  const card = { id: row.id, version: row.version, currency: row.currency, rates: row.rates };
  cached = { card, at: Date.now() };
  return card;
}

export interface PricingInput {
  category: UsageCategory;
  provider: string;
  model: string;
  unit: string;
  quantity: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  /** Telephony leg: outbound | inbound | client | conference. */
  leg?: string;
}

export type PricingResult =
  | { priced: true; cost: number; billedUnits: number; rateKeys: string[] }
  | { priced: false; missing: string[] };

const PER_MILLION = 1_000_000;

export function sttRateKey(provider: string): string {
  return provider === "openai" ? "stt:whisper" : `stt:${provider}`;
}

export function ttsRateKey(provider: string): string {
  return `tts:${provider}`;
}

export function telephonyRateKey(provider: string, leg: string): string {
  return `telephony:${provider}:${leg}`;
}

/** Started-minute rounding used by the platform's telephony rates. */
export function billedCallMinutes(seconds: number): number {
  return seconds > 0 ? Math.ceil(seconds / 60) : 0;
}

/** Prices one usage record. A missing rate is reported, never treated as zero. */
export function priceUsage(rates: Record<string, number>, input: PricingInput): PricingResult {
  const need = (keys: string[]): PricingResult | null => {
    const missing = keys.filter((key) => !(key in rates));
    return missing.length ? { priced: false, missing } : null;
  };
  switch (input.category) {
    case "llm": {
      const inKey = `llm:${input.model}:input`;
      const outKey = `llm:${input.model}:output`;
      const absent = need([inKey, outKey]);
      if (absent) return absent;
      const cached = Math.max(0, input.cachedInputTokens ?? 0);
      const inputTokens = Math.max(0, input.inputTokens ?? 0);
      const uncached = Math.max(0, inputTokens - cached);
      // Cached input is priced at the full input rate unless a cached rate is configured.
      const cachedKey = `llm:${input.model}:cached_input`;
      const cachedRate = cachedKey in rates ? rates[cachedKey] : rates[inKey];
      const cost = (uncached * rates[inKey] + cached * cachedRate + Math.max(0, input.outputTokens ?? 0) * rates[outKey]) / PER_MILLION;
      return { priced: true, cost, billedUnits: inputTokens + Math.max(0, input.outputTokens ?? 0), rateKeys: cached && cachedKey in rates ? [inKey, outKey, cachedKey] : [inKey, outKey] };
    }
    case "tts": {
      const key = ttsRateKey(input.provider);
      const absent = need([key]);
      if (absent) return absent;
      return { priced: true, cost: (input.quantity * rates[key]) / PER_MILLION, billedUnits: input.quantity, rateKeys: [key] };
    }
    case "stt": {
      const key = sttRateKey(input.provider);
      const absent = need([key]);
      if (absent) return absent;
      if (input.unit === "requests") return { priced: true, cost: input.quantity * rates[key], billedUnits: input.quantity, rateKeys: [key] };
      const minutes = input.quantity / 60;
      return { priced: true, cost: minutes * rates[key], billedUnits: minutes, rateKeys: [key] };
    }
    case "telephony": {
      const key = telephonyRateKey(input.provider, input.leg ?? "outbound");
      const absent = need([key]);
      if (absent) return absent;
      const minutes = billedCallMinutes(input.quantity);
      return { priced: true, cost: minutes * rates[key], billedUnits: minutes, rateKeys: [key] };
    }
    default:
      return { priced: false, missing: [`${input.category}:${input.provider}`] };
  }
}

export function roundMoney(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}
