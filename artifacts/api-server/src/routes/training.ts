import { Router, type IRouter } from "express";
import { db, trainingDataTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router: IRouter = Router();

router.get("/training", async (req, res) => {
  const userId = req.userId!;
  const data = await db.select().from(trainingDataTable).where(eq(trainingDataTable.userId, userId)).orderBy(trainingDataTable.createdAt);
  res.json(data);
});

router.post("/training", async (req, res) => {
  const userId = req.userId!;
  const { type, title, content } = req.body;
  if (!type || !title || !content) { res.status(400).json({ error: "type, title, and content are required" }); return; }

  const [item] = await db.insert(trainingDataTable).values({ userId, type, title, content }).returning();
  res.status(201).json(item);
});

router.delete("/training/:id", async (req, res) => {
  const userId = req.userId!;
  await db.delete(trainingDataTable).where(and(eq(trainingDataTable.id, parseInt(req.params.id)), eq(trainingDataTable.userId, userId)));
  res.status(204).send();
});

export default router;
