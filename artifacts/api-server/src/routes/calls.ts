import { Router, type IRouter } from "express";
import { db, callLogsTable, contactsTable } from "@workspace/db";
import { eq, and, sql, desc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/calls", async (req, res) => {
  const userId = req.userId!;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = (page - 1) * limit;
  const campaignId = req.query.campaignId ? parseInt(req.query.campaignId as string) : undefined;
  const outcome = req.query.outcome as string;

  const conditions: any[] = [eq(callLogsTable.userId, userId)];
  if (campaignId) conditions.push(eq(callLogsTable.campaignId, campaignId));
  if (outcome) conditions.push(eq(callLogsTable.outcome, outcome));

  const where = and(...conditions);

  const [calls, countResult] = await Promise.all([
    db.select().from(callLogsTable).where(where).limit(limit).offset(offset).orderBy(desc(callLogsTable.startedAt)),
    db.select({ count: sql<number>`count(*)` }).from(callLogsTable).where(where),
  ]);

  const callsWithContacts = await Promise.all(calls.map(async (call) => {
    let contact = null;
    if (call.contactId) {
      contact = await db.query.contactsTable.findFirst({ where: eq(contactsTable.id, call.contactId) });
    }

    const displayName = contact
      ? [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.phone
      : call.phone;

    // Costs are mirrored from the usage ledger; null means not yet priced
    // (never a guess). A cost on a call that has not finalized may still change.
    return {
      ...call,
      contact,
      displayName,
      costIsEstimated: call.estimatedCostUsd != null && !call.finalizedAt,
    };
  }));

  res.json({ calls: callsWithContacts, total: Number(countResult[0]?.count || 0), page, limit });
});

router.get("/calls/:id", async (req, res) => {
  const userId = req.userId!;
  const call = await db.query.callLogsTable.findFirst({
    where: and(eq(callLogsTable.id, parseInt(req.params.id)), eq(callLogsTable.userId, userId)),
  });
  if (!call) { res.status(404).json({ error: "Call not found" }); return; }

  let contact = null;
  if (call.contactId) {
    contact = await db.query.contactsTable.findFirst({ where: eq(contactsTable.id, call.contactId) });
  }
  res.json({ ...call, contact });
});

export default router;
