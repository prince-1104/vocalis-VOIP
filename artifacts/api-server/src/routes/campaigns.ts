import { Router, type IRouter } from "express";
import { db, campaignsTable, campaignContactsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router: IRouter = Router();

router.get("/campaigns", async (req, res) => {
  const userId = req.userId!;
  const campaigns = await db.select().from(campaignsTable).where(eq(campaignsTable.userId, userId)).orderBy(campaignsTable.createdAt);
  res.json(campaigns);
});

router.post("/campaigns", async (req, res) => {
  const userId = req.userId!;
  const { name, description, scriptId, contactIds, startTime, endTime, timezone, maxConcurrentCalls } = req.body;
  const [campaign] = await db.insert(campaignsTable).values({
    userId, name, description, scriptId,
    totalContacts: contactIds?.length || 0,
    startTime, endTime, timezone,
    maxConcurrentCalls: maxConcurrentCalls || 1,
    status: "draft",
  }).returning();

  if (contactIds?.length) {
    await db.insert(campaignContactsTable).values(
      contactIds.map((contactId: number) => ({ campaignId: campaign.id, contactId }))
    );
  }

  res.status(201).json(campaign);
});

router.get("/campaigns/:id", async (req, res) => {
  const userId = req.userId!;
  const campaign = await db.query.campaignsTable.findFirst({
    where: and(eq(campaignsTable.id, parseInt(req.params.id)), eq(campaignsTable.userId, userId)),
  });
  if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }
  res.json(campaign);
});

router.put("/campaigns/:id", async (req, res) => {
  const userId = req.userId!;
  const { name, description, scriptId, startTime, endTime, timezone, maxConcurrentCalls } = req.body;
  const [campaign] = await db.update(campaignsTable)
    .set({ name, description, scriptId, startTime, endTime, timezone, maxConcurrentCalls, updatedAt: new Date() })
    .where(and(eq(campaignsTable.id, parseInt(req.params.id)), eq(campaignsTable.userId, userId)))
    .returning();
  if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }
  res.json(campaign);
});

router.post("/campaigns/:id/start", async (req, res) => {
  const userId = req.userId!;
  const [campaign] = await db.update(campaignsTable)
    .set({ status: "active", updatedAt: new Date() })
    .where(and(eq(campaignsTable.id, parseInt(req.params.id)), eq(campaignsTable.userId, userId)))
    .returning();
  if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }
  res.json(campaign);
});

router.post("/campaigns/:id/pause", async (req, res) => {
  const userId = req.userId!;
  const [campaign] = await db.update(campaignsTable)
    .set({ status: "paused", updatedAt: new Date() })
    .where(and(eq(campaignsTable.id, parseInt(req.params.id)), eq(campaignsTable.userId, userId)))
    .returning();
  if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }
  res.json(campaign);
});

export default router;
