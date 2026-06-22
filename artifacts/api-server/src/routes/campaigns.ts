import { Router, type IRouter } from "express";
import { db, campaignsTable, campaignContactsTable, callLogsTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { dialNextForCampaign, triggerDialingForCampaign } from "../lib/campaign-dialer";
import { normalizeCampaignTransferConfig, type CampaignTransferConfig } from "../lib/campaign-transfer";

const router: IRouter = Router();

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

router.get("/campaigns", async (req, res) => {
  const userId = req.userId!;
  const campaigns = await db.select().from(campaignsTable).where(eq(campaignsTable.userId, userId)).orderBy(campaignsTable.createdAt);
  
  const contactLinks = await db.select().from(campaignContactsTable);
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
  const { name, description, scriptId, contactIds, startTime, endTime, timezone, maxConcurrentCalls, dialParallel, isAutomatic, maxRetries, retryIntervalMinutes, transferConfig } = req.body;

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
    startTime, endTime, timezone,
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
  
  const contacts = await db.select().from(campaignContactsTable).where(eq(campaignContactsTable.campaignId, campaign.id));
  const contactIds = contacts.map(c => c.contactId);

  res.json({
    ...campaign,
    contactIds,
  });
});

router.put("/campaigns/:id", async (req, res) => {
  const userId = req.userId!;
  const campaignId = parseInt(req.params.id);
  const { name, description, scriptId, startTime, endTime, timezone, maxConcurrentCalls, dialParallel, isAutomatic, maxRetries, retryIntervalMinutes, contactIds, transferConfig } = req.body;
  
  const existingCampaign = await db.query.campaignsTable.findFirst({
    where: and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId)),
  });
  if (!existingCampaign) { res.status(404).json({ error: "Campaign not found" }); return; }

  let totalContacts = existingCampaign.totalContacts;
  if (contactIds !== undefined) {
    totalContacts = contactIds.length;
    await db.delete(campaignContactsTable).where(eq(campaignContactsTable.campaignId, campaignId));
    if (contactIds.length > 0) {
      await db.insert(campaignContactsTable).values(
        contactIds.map((contactId: number) => ({ campaignId, contactId }))
      );
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

  const finalContactLinks = await db.select().from(campaignContactsTable).where(eq(campaignContactsTable.campaignId, campaignId));
  const finalContactIds = finalContactLinks.map(c => c.contactId);

  if (campaign.status === "active" && campaign.isAutomatic) {
    const baseUrl = getBaseUrl(req);
    triggerDialingForCampaign(campaignId, userId, baseUrl).catch((err) => {
      console.error(`[campaigns/update] Auto dialing failed:`, err);
    });
  }

  res.json({
    ...campaign,
    contactIds: finalContactIds,
  });
});

router.post("/campaigns/:id/start", async (req, res) => {
  const userId = req.userId!;
  const campaignId = parseInt(req.params.id);
  const [campaign] = await db.update(campaignsTable)
    .set({ status: "active", updatedAt: new Date() })
    .where(and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId)))
    .returning();
  if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }

  const contacts = await db.select().from(campaignContactsTable).where(eq(campaignContactsTable.campaignId, campaign.id));
  const contactIds = contacts.map(c => c.contactId);

  if (campaign.isAutomatic) {
    const baseUrl = getBaseUrl(req);
    triggerDialingForCampaign(campaignId, userId, baseUrl).catch((err) => {
      console.error(`[campaigns/start] Auto dialing failed:`, err);
    });
  }

  res.json({
    ...campaign,
    contactIds,
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

  const contacts = await db.select().from(campaignContactsTable).where(eq(campaignContactsTable.campaignId, campaign.id));
  const contactIds = contacts.map(c => c.contactId);

  res.json({
    ...campaign,
    contactIds,
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
