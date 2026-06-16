import { Router, type IRouter } from "express";
import { db, campaignsTable, campaignContactsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router: IRouter = Router();

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
  const { name, description, scriptId, contactIds, startTime, endTime, timezone, maxConcurrentCalls, isAutomatic } = req.body;
  const [campaign] = await db.insert(campaignsTable).values({
    userId, name, description, scriptId,
    totalContacts: contactIds?.length || 0,
    startTime, endTime, timezone,
    maxConcurrentCalls: maxConcurrentCalls || 1,
    isAutomatic: isAutomatic || false,
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
  const { name, description, scriptId, startTime, endTime, timezone, maxConcurrentCalls, isAutomatic, contactIds } = req.body;
  
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

  const [campaign] = await db.update(campaignsTable)
    .set({
      name,
      description,
      scriptId,
      startTime,
      endTime,
      timezone,
      maxConcurrentCalls,
      isAutomatic: isAutomatic !== undefined ? isAutomatic : existingCampaign.isAutomatic,
      totalContacts,
      updatedAt: new Date()
    })
    .where(and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId)))
    .returning();

  const finalContactLinks = await db.select().from(campaignContactsTable).where(eq(campaignContactsTable.campaignId, campaignId));
  const finalContactIds = finalContactLinks.map(c => c.contactId);

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

export default router;
