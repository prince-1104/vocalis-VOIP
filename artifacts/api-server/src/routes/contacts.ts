import { Router, type IRouter } from "express";
import { db, contactsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/contacts", async (req, res) => {
  const userId = req.userId!;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = (page - 1) * limit;
  const search = req.query.search as string;
  const status = req.query.status as string;

  const conditions: any[] = [eq(contactsTable.userId, userId)];
  if (status) conditions.push(eq(contactsTable.status, status));
  if (search) {
    conditions.push(
      sql`(${contactsTable.firstName} ILIKE ${'%' + search + '%'} OR ${contactsTable.lastName} ILIKE ${'%' + search + '%'} OR ${contactsTable.phone} ILIKE ${'%' + search + '%'} OR ${contactsTable.company} ILIKE ${'%' + search + '%'})`
    );
  }

  const where = and(...conditions);

  const [contacts, countResult] = await Promise.all([
    db.select().from(contactsTable).where(where).limit(limit).offset(offset).orderBy(contactsTable.createdAt),
    db.select({ count: sql<number>`count(*)` }).from(contactsTable).where(where),
  ]);

  res.json({ contacts, total: Number(countResult[0]?.count || 0), page, limit });
});

router.post("/contacts", async (req, res) => {
  const userId = req.userId!;
  const { firstName, lastName, phone, email, company, notes } = req.body;
  if (!phone) { res.status(400).json({ error: "Phone number is required" }); return; }

  const [contact] = await db.insert(contactsTable).values({
    userId, firstName, lastName, phone, email, company, notes, status: "pending",
  }).returning();

  res.status(201).json(contact);
});

router.post("/contacts/import", async (req, res) => {
  const userId = req.userId!;
  const { csvData, mapping } = req.body;
  if (!csvData) { res.status(400).json({ error: "CSV data is required" }); return; }

  const lines = csvData.trim().split("\n");
  const headers = lines[0].split(",").map((h: string) => h.trim().replace(/"/g, ""));

  const fieldMap = mapping || {};
  const getCol = (field: string) => {
    const col = fieldMap[field] || field;
    return headers.findIndex((h: string) => h.toLowerCase() === col.toLowerCase());
  };

  const phoneIdx = getCol("phone");
  if (phoneIdx === -1) { res.status(400).json({ error: "Could not find phone column in CSV" }); return; }

  const firstNameIdx = getCol("firstName");
  const lastNameIdx = getCol("lastName");
  const emailIdx = getCol("email");
  const companyIdx = getCol("company");

  let imported = 0, skipped = 0;
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c: string) => c.trim().replace(/"/g, ""));
    const phone = cols[phoneIdx];
    if (!phone) { skipped++; continue; }
    try {
      await db.insert(contactsTable).values({
        userId, phone,
        firstName: firstNameIdx >= 0 ? cols[firstNameIdx] : undefined,
        lastName: lastNameIdx >= 0 ? cols[lastNameIdx] : undefined,
        email: emailIdx >= 0 ? cols[emailIdx] : undefined,
        company: companyIdx >= 0 ? cols[companyIdx] : undefined,
        status: "pending",
      });
      imported++;
    } catch (e: any) {
      errors.push(`Row ${i}: ${e.message}`);
      skipped++;
    }
  }

  res.json({ imported, skipped, errors });
});

router.get("/contacts/:id", async (req, res) => {
  const userId = req.userId!;
  const contact = await db.query.contactsTable.findFirst({
    where: and(eq(contactsTable.id, parseInt(req.params.id)), eq(contactsTable.userId, userId)),
  });
  if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }
  res.json(contact);
});

router.put("/contacts/:id", async (req, res) => {
  const userId = req.userId!;
  const { firstName, lastName, phone, email, company, status, notes, callbackAt } = req.body;
  const [contact] = await db.update(contactsTable)
    .set({ firstName, lastName, phone, email, company, status, notes, callbackAt: callbackAt ? new Date(callbackAt) : undefined, updatedAt: new Date() })
    .where(and(eq(contactsTable.id, parseInt(req.params.id)), eq(contactsTable.userId, userId)))
    .returning();
  if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }
  res.json(contact);
});

router.delete("/contacts/:id", async (req, res) => {
  const userId = req.userId!;
  await db.delete(contactsTable).where(and(eq(contactsTable.id, parseInt(req.params.id)), eq(contactsTable.userId, userId)));
  res.status(204).send();
});

export default router;
