import { Router, type IRouter } from "express";
import { db, campaignsTable, campaignContactsTable, contactsTable } from "@workspace/db";
import { eq, and, inArray, notInArray, sql } from "drizzle-orm";
import { IN_FLIGHT_STATUSES, triggerDialingForCampaign } from "../lib/campaign-dialer";
import { normalizeCampaignTransferConfig, type CampaignTransferConfig } from "../lib/campaign-transfer";
import { callingWindowProblem, DEFAULT_CAMPAIGN_TIMEZONE } from "../lib/calling-window";
import { logger } from "../lib/logger";
import { campaignLaunchRateLimit } from "../lib/rate-limit-policies";

const router: IRouter = Router();

const MAX_CAMPAIGN_CONTACTS = 10_000;
/** Shared with claimNextCampaignContact: rerun and claims for one campaign serialize. */
const CLAIM_LOCK_NAMESPACE = 727_301;

function getBaseUrl(req: any): string {
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) {
    const first = domains.split(",")[0].trim();
    return `https://${first}`;
  }
  const host = req.headers.host || "localhost";
  return `https://${host}`;
}

function parseTransferConfig(raw: unknown): CampaignTransferConfig | null {
  const normalized = normalizeCampaignTransferConfig(raw);
  if (!normalized) {
    if (raw && typeof raw === "object" && (raw as CampaignTransferConfig).enabled) {
      throw new Error("Set at least one limit: max Q&A exchanges or max call duration (minutes)");
    }
    return null;
  }
  if (normalized.handoffMode === "crm_agent" && !normalized.crmAgentId) {
    throw new Error("Select a CRM agent when using transfer-to-agent mode");
  }
  return normalized;
}

const INVALID_CONTACTS = "contactIds must reference your own contacts.";

/** undefined when absent; null when malformed; otherwise unique positive integers. */
function parseContactIds(raw: unknown): number[] | null | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_CAMPAIGN_CONTACTS) return null;
  const ids = new Set<number>();
  for (const value of raw) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
    ids.add(value);
  }
  return [...ids];
}

async function ownsAllContacts(userId: number, ids: number[]): Promise<boolean> {
  if (!ids.length) return true;
  const owned = await db.select({ id: contactsTable.id }).from(contactsTable)
    .where(and(eq(contactsTable.userId, userId), inArray(contactsTable.id, ids)));
  return new Set(owned.map((row) => row.id)).size === ids.length;
}

async function campaignContactIds(campaignId: number): Promise<number[]> {
  const links = await db.select().from(campaignContactsTable).where(eq(campaignContactsTable.campaignId, campaignId));
  return links.map((link) => link.contactId);
}

router.get("/campaigns", async (req, res) => {
  const userId = req.userId!;
  const campaigns = await db.select().from(campaignsTable).where(eq(campaignsTable.userId, userId)).orderBy(campaignsTable.createdAt);

  const contactLinks = campaigns.length
    ? await db.select().from(campaignContactsTable)
        .where(inArray(campaignContactsTable.campaignId, campaigns.map((c) => c.id)))
    : [];
  const campaignContactMap: Record<number, number[]> = {};
  for (const link of contactLinks) {
    if (!campaignContactMap[link.campaignId]) {
      campaignContactMap[link.campaignId] = [];
    }
    campaignContactMap[link.campaignId].push(link.contactId);
  }

  const result = campaigns.map(c => ({
    ...c,
    contactIds: campaignContactMap[c.id] || [],
  }));

  res.json(result);
});

router.post("/campaigns", async (req, res) => {
  const userId = req.userId!;
  const { name, description, scriptId, startTime, endTime, timezone, maxConcurrentCalls, dialParallel, isAutomatic, maxRetries, retryIntervalMinutes, transferConfig } = req.body;

  const contactIds = parseContactIds(req.body.contactIds);
  if (contactIds === null || (contactIds && !(await ownsAllContacts(userId, contactIds)))) {
    res.status(400).json({ error: INVALID_CONTACTS });
    return;
  }

  const window = {
    startTime: startTime || "09:00",
    endTime: endTime || "17:00",
    timezone: timezone || DEFAULT_CAMPAIGN_TIMEZONE,
  };
  const windowProblem = callingWindowProblem(window);
  if (windowProblem) {
    res.status(400).json({ error: windowProblem });
    return;
  }

  let parsedTransferConfig: CampaignTransferConfig | null = null;
  try {
    if (transferConfig) {
      parsedTransferConfig = parseTransferConfig(transferConfig);
    }
  } catch (err: any) {
    res.status(400).json({ error: err.message });
    return;
  }

  const [campaign] = await db.insert(campaignsTable).values({
    userId, name, description, scriptId,
    totalContacts: contactIds?.length || 0,
    ...window,
    maxConcurrentCalls: maxConcurrentCalls || 1,
    dialParallel: dialParallel || false,
    isAutomatic: isAutomatic || false,
    maxRetries: maxRetries !== undefined ? parseInt(maxRetries, 10) : 0,
    retryIntervalMinutes: retryIntervalMinutes !== undefined ? parseInt(retryIntervalMinutes, 10) : 10,
    transferConfig: parsedTransferConfig,
    status: "draft",
  }).returning();

  if (contactIds?.length) {
    await db.insert(campaignContactsTable).values(
      contactIds.map((contactId: number) => ({ campaignId: campaign.id, contactId }))
    );
  }

  res.status(201).json({
    ...campaign,
    contactIds: contactIds || [],
  });
});

router.get("/campaigns/:id", async (req, res) => {
  const userId = req.userId!;
  const campaign = await db.query.campaignsTable.findFirst({
    where: and(eq(campaignsTable.id, parseInt(req.params.id)), eq(campaignsTable.userId, userId)),
  });
  if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }

  res.json({
    ...campaign,
    contactIds: await campaignContactIds(campaign.id),
  });
});

router.put("/campaigns/:id", async (req, res) => {
  const userId = req.userId!;
  const campaignId = parseInt(req.params.id);
  const { name, description, scriptId, startTime, endTime, timezone, maxConcurrentCalls, dialParallel, isAutomatic, maxRetries, retryIntervalMinutes, transferConfig } = req.body;

  const existingCampaign = await db.query.campaignsTable.findFirst({
    where: and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId)),
  });
  if (!existingCampaign) { res.status(404).json({ error: "Campaign not found" }); return; }

  const contactIds = parseContactIds(req.body.contactIds);
  if (contactIds === null || (contactIds && !(await ownsAllContacts(userId, contactIds)))) {
    res.status(400).json({ error: INVALID_CONTACTS });
    return;
  }

  if (startTime !== undefined || endTime !== undefined || timezone !== undefined) {
    const windowProblem = callingWindowProblem({
      startTime: startTime !== undefined ? startTime : existingCampaign.startTime,
      endTime: endTime !== undefined ? endTime : existingCampaign.endTime,
      timezone: timezone !== undefined ? timezone : existingCampaign.timezone,
    });
    if (windowProblem) {
      res.status(400).json({ error: windowProblem });
      return;
    }
  }

  let parsedTransferConfig = existingCampaign.transferConfig;
  if (transferConfig !== undefined) {
    try {
      parsedTransferConfig = transferConfig ? parseTransferConfig(transferConfig) : null;
    } catch (err: any) {
      res.status(400).json({ error: err.message });
      return;
    }
  }

  let totalContacts = existingCampaign.totalContacts;
  if (contactIds !== undefined) {
    // Diff instead of delete-and-reinsert: attempt history is kept and links
    // with a call in flight are never removed underneath the dialer.
    totalContacts = contactIds.length;
    const desired = new Set(contactIds);
    const links = await db.select().from(campaignContactsTable).where(eq(campaignContactsTable.campaignId, campaignId));
    const removable = links
      .filter((link) => !desired.has(link.contactId) && !(IN_FLIGHT_STATUSES as readonly string[]).includes(link.status))
      .map((link) => link.id);
    if (removable.length) {
      await db.delete(campaignContactsTable).where(and(
        eq(campaignContactsTable.campaignId, campaignId),
        inArray(campaignContactsTable.id, removable),
        notInArray(campaignContactsTable.status, [...IN_FLIGHT_STATUSES]),
      ));
    }
    const present = new Set(links.map((link) => link.contactId));
    const added = contactIds.filter((contactId) => !present.has(contactId));
    if (added.length) {
      await db.insert(campaignContactsTable).values(added.map((contactId) => ({ campaignId, contactId })));
    }
  }

  const [campaign] = await db.update(campaignsTable)
    .set({
      name,
      description,
      scriptId,
      startTime,
      endTime,
      timezone,
      maxConcurrentCalls,
      dialParallel: dialParallel !== undefined ? dialParallel : existingCampaign.dialParallel,
      isAutomatic: isAutomatic !== undefined ? isAutomatic : existingCampaign.isAutomatic,
      maxRetries: maxRetries !== undefined ? parseInt(maxRetries, 10) : existingCampaign.maxRetries,
      retryIntervalMinutes: retryIntervalMinutes !== undefined ? parseInt(retryIntervalMinutes, 10) : existingCampaign.retryIntervalMinutes,
      transferConfig: parsedTransferConfig,
      totalContacts,
      updatedAt: new Date()
    })
    .where(and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId)))
    .returning();

  if (campaign.status === "active" && campaign.isAutomatic) {
    const baseUrl = getBaseUrl(req);
    triggerDialingForCampaign(campaignId, userId, baseUrl).catch((err) => {
      logger.error({ err, campaignId, trigger: "update" }, "Campaign auto dialing failed");
    });
  }

  res.json({
    ...campaign,
    contactIds: await campaignContactIds(campaignId),
  });
});

router.post("/campaigns/:id/start", campaignLaunchRateLimit, async (req, res) => {
  const userId = req.userId!;
  const campaignId = parseInt(req.params.id);

  const existing = await db.query.campaignsTable.findFirst({
    where: and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId)),
  });
  if (!existing) { res.status(404).json({ error: "Campaign not found" }); return; }

  if (existing.status === "completed") {
    res.status(400).json({
      error: "Campaign is completed. Use Rerun to reset contacts and dial again.",
    });
    return;
  }

  const windowProblem = callingWindowProblem(existing);
  if (windowProblem) {
    res.status(400).json({ error: `Calling window is not configured correctly: ${windowProblem}` });
    return;
  }

  const [campaign] = await db.update(campaignsTable)
    .set({ status: "active", updatedAt: new Date() })
    .where(and(
      eq(campaignsTable.id, campaignId),
      eq(campaignsTable.userId, userId),
      inArray(campaignsTable.status, ["draft", "paused", "active"]),
    ))
    .returning();
  if (!campaign) {
    res.status(409).json({ error: "Campaign status changed; refresh and retry." });
    return;
  }

  if (campaign.isAutomatic) {
    const baseUrl = getBaseUrl(req);
    triggerDialingForCampaign(campaignId, userId, baseUrl).catch((err) => {
      logger.error({ err, campaignId, trigger: "start" }, "Campaign auto dialing failed");
    });
  }

  res.json({
    ...campaign,
    contactIds: await campaignContactIds(campaign.id),
  });
});

router.post("/campaigns/:id/pause", async (req, res) => {
  const userId = req.userId!;
  const campaignId = parseInt(req.params.id);
  const [campaign] = await db.update(campaignsTable)
    .set({ status: "paused", updatedAt: new Date() })
    .where(and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId)))
    .returning();
  if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }

  res.json({
    ...campaign,
    contactIds: await campaignContactIds(campaign.id),
  });
});

class RerunConflict extends Error {}

// Reset all contacts and metrics so the campaign can be dialed again.
router.post("/campaigns/:id/rerun", campaignLaunchRateLimit, async (req, res) => {
  const userId = req.userId!;
  const campaignId = parseInt(req.params.id);
  const autoStart = req.body?.autoStart === true;

  const existing = await db.query.campaignsTable.findFirst({
    where: and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId)),
  });
  if (!existing) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  if (existing.status === "active") {
    res.status(400).json({ error: "Pause the campaign before rerunning." });
    return;
  }

  if (autoStart) {
    const windowProblem = callingWindowProblem(existing);
    if (windowProblem) {
      res.status(400).json({ error: `Calling window is not configured correctly: ${windowProblem}` });
      return;
    }
  }

  let campaign: typeof campaignsTable.$inferSelect;
  try {
    campaign = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${CLAIM_LOCK_NAMESPACE}, ${campaignId})`);
      // Calls still in flight would be counted against the reset counters and
      // could be redialed; the rerun waits until they finish.
      const inFlight = await tx.select().from(campaignContactsTable).where(and(
        eq(campaignContactsTable.campaignId, campaignId),
        inArray(campaignContactsTable.status, [...IN_FLIGHT_STATUSES]),
      ));
      if (inFlight.length) throw new RerunConflict("Calls from the previous run are still in progress. Retry when they finish.");

      const [updated] = await tx
        .update(campaignsTable)
        .set({
          status: autoStart ? "active" : "draft",
          calledCount: 0,
          answeredCount: 0,
          interestedCount: 0,
          updatedAt: new Date(),
        })
        .where(and(
          eq(campaignsTable.id, campaignId),
          eq(campaignsTable.userId, userId),
          inArray(campaignsTable.status, ["draft", "paused", "completed"]),
        ))
        .returning();
      if (!updated) throw new RerunConflict("Campaign status changed; refresh and retry.");

      await tx
        .update(campaignContactsTable)
        .set({
          status: "pending",
          attempts: 0,
          nextAttemptAt: null,
          lastAttemptAt: null,
          claimToken: null,
          claimedAt: null,
          callLogId: null,
        })
        .where(and(
          eq(campaignContactsTable.campaignId, campaignId),
          notInArray(campaignContactsTable.status, [...IN_FLIGHT_STATUSES]),
        ));
      return updated;
    });
  } catch (err) {
    if (err instanceof RerunConflict) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }

  if (autoStart && campaign.isAutomatic) {
    const baseUrl = getBaseUrl(req);
    triggerDialingForCampaign(campaignId, userId, baseUrl).catch((err) => {
      logger.error({ err, campaignId, trigger: "rerun" }, "Campaign auto dialing failed");
    });
  }

  res.json({
    ...campaign,
    contactIds: await campaignContactIds(campaignId),
    message: autoStart
      ? "Campaign reset and dialing started."
      : "Campaign reset. Activate to start dialing again.",
  });
});

router.delete("/campaigns/:id", async (req, res) => {
  const userId = req.userId!;
  const campaignId = parseInt(req.params.id);

  const existingCampaign = await db.query.campaignsTable.findFirst({
    where: and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId)),
  });

  if (!existingCampaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  // Delete from DB (related campaign_contacts will be deleted due to cascade)
  await db.delete(campaignsTable).where(
    and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId))
  );

  res.status(204).end();
});

export default router;
