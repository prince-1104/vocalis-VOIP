import { db, campaignsTable, crmAgentsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import type { Campaign } from "@workspace/db";
import type { TransferRules } from "./intent-classifier";

// ── Campaign CRM Handoff Configuration ─────────────────────────────────
// Configured per campaign in the Campaigns UI. Limits AI turns/time to control
// cost, then hands off to a CRM agent (dashboard webhook + optional phone bridge).

export interface CampaignTransferConfig {
  enabled: boolean;
  /** Max caller Q&A exchanges before closing (0 = no turn limit) */
  maxAiTurns?: number;
  /** Max AI conversation minutes before closing (0 = no time limit) */
  maxAiMinutes?: number;
  /** end_call = hang up with closing message; crm_agent = transfer to CRM */
  handoffMode?: "end_call" | "crm_agent";
  crmAgentId?: string;
  transferMessage?: string;
  transferOnHumanRequest?: boolean;
}

export const DEFAULT_CAMPAIGN_CLOSING_MESSAGE =
  "Thank you for being with us. Our specialists will get in touch with you as soon as possible. Goodbye.";

/** @deprecated use DEFAULT_CAMPAIGN_CLOSING_MESSAGE */
export const DEFAULT_CAMPAIGN_TRANSFER_MESSAGE = DEFAULT_CAMPAIGN_CLOSING_MESSAGE;

export function normalizeCampaignTransferConfig(
  raw: unknown,
): CampaignTransferConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as CampaignTransferConfig;
  if (!c.enabled) return null;

  const maxAiTurns = c.maxAiTurns ?? 0;
  const maxAiMinutes = c.maxAiMinutes ?? 0;
  if (maxAiTurns <= 0 && maxAiMinutes <= 0) return null;

  const handoffMode = c.handoffMode === "crm_agent" ? "crm_agent" : "end_call";

  return {
    enabled: true,
    maxAiTurns: maxAiTurns > 0 ? maxAiTurns : undefined,
    maxAiMinutes: maxAiMinutes > 0 ? maxAiMinutes : undefined,
    handoffMode,
    crmAgentId: handoffMode === "crm_agent" ? (c.crmAgentId || undefined) : undefined,
    transferMessage: c.transferMessage?.trim() || DEFAULT_CAMPAIGN_CLOSING_MESSAGE,
    transferOnHumanRequest: c.transferOnHumanRequest !== false,
  };
}

export async function resolveAgentPhone(
  userId: number,
  crmAgentId?: string,
): Promise<{ phone: string | null; agentId: string | null }> {
  if (!crmAgentId) return { phone: null, agentId: null };

  const agent = await db.query.crmAgentsTable.findFirst({
    where: and(
      eq(crmAgentsTable.userId, userId),
      eq(crmAgentsTable.crmAgentId, crmAgentId),
    ),
  });

  if (!agent) return { phone: null, agentId: crmAgentId };
  return {
    phone: agent.phone || agent.sipUri || null,
    agentId: agent.crmAgentId,
  };
}

/** Build runtime transfer rules injected into call crmMetadata.__transferRules */
export async function buildCampaignTransferRules(
  config: CampaignTransferConfig,
  userId: number,
): Promise<TransferRules> {
  const useCrmAgent = config.handoffMode === "crm_agent" && !!config.crmAgentId;
  const { phone } = useCrmAgent
    ? await resolveAgentPhone(userId, config.crmAgentId)
    : { phone: null };

  return {
    intents: [],
    maxAiTurns: config.maxAiTurns,
    maxAiMinutes: config.maxAiMinutes,
    crmAgentId: useCrmAgent ? config.crmAgentId : undefined,
    transferTo: phone || undefined,
    transferMessage: config.transferMessage || DEFAULT_CAMPAIGN_CLOSING_MESSAGE,
    humanRequestThreshold: config.transferOnHumanRequest !== false ? 1 : 999,
    campaignHandoff: true,
    endCallOnly: !useCrmAgent,
  };
}

export async function buildTransferRulesForCampaign(
  campaign: Campaign,
  userId: number,
): Promise<TransferRules | null> {
  const config = normalizeCampaignTransferConfig(campaign.transferConfig);
  if (!config) return null;
  return buildCampaignTransferRules(config, userId);
}

export async function buildCallCrmMetadataForCampaign(
  campaign: Campaign,
  userId: number,
): Promise<Record<string, unknown> | null> {
  const rules = await buildTransferRulesForCampaign(campaign, userId);
  if (!rules) return null;

  return {
    __transferRules: rules,
    __campaignId: campaign.id,
    __campaignName: campaign.name,
  };
}

/** Load campaign transfer rules for an active call (used when metadata wasn't pre-set). */
export async function loadCampaignTransferRulesForCall(
  campaignId: number,
  userId: number,
): Promise<TransferRules | null> {
  const campaign = await db.query.campaignsTable.findFirst({
    where: and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId)),
  });
  if (!campaign) return null;
  return buildTransferRulesForCampaign(campaign, userId);
}

/** Count completed user Q&A turns (each user utterance = one exchange). */
export function countUserTurns(history: { role: string; content: string }[]): number {
  return history.filter(h => h.role === "user").length;
}
