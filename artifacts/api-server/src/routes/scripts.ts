import { Router, type IRouter } from "express";
import { db, callingScriptsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router: IRouter = Router();

router.get("/scripts", async (req, res) => {
  const userId = req.userId!;
  const scripts = await db.select().from(callingScriptsTable).where(eq(callingScriptsTable.userId, userId)).orderBy(callingScriptsTable.createdAt);
  res.json(scripts);
});

router.post("/scripts", async (req, res) => {
  const userId = req.userId!;
  const { name, description, openingLine, pitchPoints, closingLine, fullScript, isDefault } = req.body;
  if (!name || !openingLine || !fullScript) { res.status(400).json({ error: "name, openingLine, and fullScript are required" }); return; }

  if (isDefault) {
    await db.update(callingScriptsTable).set({ isDefault: false }).where(eq(callingScriptsTable.userId, userId));
  }

  const [script] = await db.insert(callingScriptsTable).values({
    userId, name, description, openingLine, pitchPoints: pitchPoints || [], closingLine, fullScript, isDefault: isDefault || false,
  }).returning();
  res.status(201).json(script);
});

router.put("/scripts/:id", async (req, res) => {
  const userId = req.userId!;
  const { name, description, openingLine, pitchPoints, closingLine, fullScript, isDefault } = req.body;

  if (isDefault) {
    await db.update(callingScriptsTable).set({ isDefault: false }).where(eq(callingScriptsTable.userId, userId));
  }

  const [script] = await db.update(callingScriptsTable)
    .set({ name, description, openingLine, pitchPoints, closingLine, fullScript, isDefault, updatedAt: new Date() })
    .where(and(eq(callingScriptsTable.id, parseInt(req.params.id)), eq(callingScriptsTable.userId, userId)))
    .returning();
  if (!script) { res.status(404).json({ error: "Script not found" }); return; }
  res.json(script);
});

router.delete("/scripts/:id", async (req, res) => {
  const userId = req.userId!;
  await db.delete(callingScriptsTable).where(and(eq(callingScriptsTable.id, parseInt(req.params.id)), eq(callingScriptsTable.userId, userId)));
  res.status(204).send();
});

export default router;
