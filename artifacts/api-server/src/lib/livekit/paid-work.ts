import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { currentRateCard, priceUsage } from "../billing/rate-card";
import { reserveBudget, releaseReservation } from "../billing/spend-budget";
import { recordUsage, type UsageRecord } from "../billing/usage-ledger";
import { VoiceDenied, type VoiceSession } from "./sessions";
import { requiredRate } from "./sip-orchestration";

type Outcome = "charged" | "not_charged" | "unknown";
export interface PaidWorkAdapter {
  rates(): Promise<Record<string, number>>;
  reserve(owner: number, key: string, amount: number): Promise<{ tenantId: number; key: string }>;
  record(record: UsageRecord): Promise<unknown>;
  release(tenant: number, key: string): Promise<unknown>;
}
export const apiPaidWorkAdapter: PaidWorkAdapter = {
  rates: async () => (await currentRateCard(db)).rates,
  reserve: (userId, key, amount) => reserveBudget({ userId, key, amount, source: "livekit", ttlMs: 180000 }),
  record: recordUsage,
  release: (tenant, key) => releaseReservation(tenant, key, "livekit_usage_recorded"),
};
/** API-owned financial boundary. Mock work bypasses BOTH reservations and provider usage. */
export class PaidVoiceWork {
  constructor(private adapter: PaidWorkAdapter = apiPaidWorkAdapter) {}
  async admit(session: VoiceSession, component: "stt" | "tts", quantity: number, operationId = randomUUID()) {
    if (session.mode === "mock") return { operationId, mode: "mock" as const };
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > (component === "stt" ? 120 : 6000)) throw new VoiceDenied(400);
    const rates = await this.adapter.rates();
    const provider = component === "stt" ? "deepgram" : "sarvam";
    requiredRate(rates, component === "stt" ? "stt:deepgram" : "tts:sarvam");
    const input = { category: component, provider, model: component === "stt" ? "nova-3" : "bulbul:v3",
      unit: component === "stt" ? "audio_seconds" as const : "characters" as const, quantity };
    const price = priceUsage(rates, input);
    if (!price.priced) throw new VoiceDenied(503);
    const key = `livekit:${session.id}:${operationId}`;
    const reservation = await this.adapter.reserve(session.owner_id, key, price.cost);
    const record: UsageRecord = { ...input, userId: session.owner_id, sessionRef: session.id, source: "livekit", idempotencyKey: key,
      measurement: "unknown", quantity: null, outcome: "unknown", final: false, provisionalAmount: price.cost };
    // Persist conservative exposure before provider admission. A lost response never means free work.
    await this.adapter.record(record);
    await this.adapter.release(reservation.tenantId, reservation.key);
    return { operationId, mode: "live" as const, record };
  }
  async reconcile(record: UsageRecord, outcome: Outcome, quantity?: number) {
    if (outcome === "charged" && (!Number.isFinite(quantity) || quantity! < 0)) throw new VoiceDenied(400);
    // Existing ledger idempotency accepts better evidence after cancellation, without reopening work.
    await this.adapter.record({ ...record, quantity: outcome === "charged" ? quantity! : null,
      measurement: outcome === "charged" ? "actual" : "unknown", outcome, final: outcome !== "unknown" });
  }
}
