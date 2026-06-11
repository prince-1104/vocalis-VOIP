import { Router, type IRouter } from "express";
import { db, trainingDataTable, intentTrainingTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import multer from "multer";
import mammoth from "mammoth";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

async function extractText(file: Express.Multer.File): Promise<string> {
  const ext = file.originalname.split(".").pop()?.toLowerCase();

  if (ext === "txt" || file.mimetype === "text/plain") {
    return file.buffer.toString("utf-8");
  }

  if (ext === "json" || file.mimetype === "application/json") {
    const data = JSON.parse(file.buffer.toString("utf-8"));
    return typeof data === "string" ? data : JSON.stringify(data, null, 2);
  }

  if (ext === "docx" || file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value;
  }

  if (ext === "pdf" || file.mimetype === "application/pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    const parsed = await pdfParse(file.buffer);
    return parsed.text;
  }

  throw new Error(`Unsupported file type: .${ext}`);
}

// ── Types for structured multilingual JSON ──────────────────────────────
type JsonTrainingShape = {
  type?: string;
  title?: string;
  content?: string;
  queries?: { english?: string[]; hindi?: string[]; kannada?: string[] };
  answers?: { english?: string; hindi?: string; kannada?: string };
  videos?: { english_video?: string; kannada_video?: string };
};

function parseStructuredTrainingJson(jsonText: string, fallbackType: string): Array<{ type: string; title: string; content: string }> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  const list = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" ? [parsed] : []);
  if (!list.length) return null;

  const rows: Array<{ type: string; title: string; content: string }> = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as JsonTrainingShape;
    const title = (item.title || "").trim();
    if (!title) continue;

    const type = (item.type || fallbackType || "product_info").trim();

    // Direct format support: [{ type, title, content }]
    if (typeof item.content === "string" && item.content.trim()) {
      rows.push({ type, title, content: item.content.trim() });
      continue;
    }

    // Rich multilingual format support:
    // [{ type, title, queries, answers, videos }]
    const ansEn = (item.answers?.english || "").trim();
    const ansHi = (item.answers?.hindi || "").trim();
    const ansKn = (item.answers?.kannada || "").trim();
    if (!ansEn && !ansHi && !ansKn) continue;

    const qEn = item.queries?.english || [];
    const qHi = item.queries?.hindi || [];
    const qKn = item.queries?.kannada || [];
    const vEn = (item.videos?.english_video || "").trim();
    const vKn = (item.videos?.kannada_video || "").trim();

    // Build a combined query variations block with ALL languages.
    // This is the KEY to multilingual matching: by embedding Hindi
    // and Kannada queries inside the English entry (and vice versa),
    // the relevance scorer can match ANY query variant regardless
    // of which language the user types in.
    const allQueries = [...qEn, ...qHi, ...qKn].filter(q => q.trim());
    const queryBlock = allQueries.length
      ? `--- Query Variations (${allQueries.length}) ---\n${allQueries.map(q => `• ${q}`).join("\n")}`
      : "";

    if (ansEn) {
      const sections = [
        `Language: English (en-US)`,
        `Answer:\n${ansEn}`,
        qEn.length ? `Common Queries:\n${qEn.map(q => `- ${q}`).join("\n")}` : "",
        vEn ? `Suggested YouTube (English): ${vEn}` : "",
        vKn ? `Suggested YouTube (Kannada): ${vKn}` : "",
        queryBlock,
      ].filter(Boolean);

      rows.push({
        type,
        title: `${title} [English]`,
        content: sections.join("\n\n").trim(),
      });
    }

    if (ansHi) {
      const sections = [
        `भाषा: हिंदी — देवनागरी`,
        `उत्तर:\n${ansHi}`,
        qHi.length ? `सामान्य प्रश्न:\n${qHi.map(q => `- ${q}`).join("\n")}` : "",
        vEn ? `YouTube (English): ${vEn}` : "",
        vKn ? `YouTube (Kannada): ${vKn}` : "",
        queryBlock,
      ].filter(Boolean);

      rows.push({
        type,
        title: `${title} [Hindi Native]`,
        content: sections.join("\n\n").trim(),
      });
    }

    if (ansKn) {
      const sections = [
        `ಭಾಷೆ: ಕನ್ನಡ`,
        `ಉತ್ತರ:\n${ansKn}`,
        qKn.length ? `ಸಾಮಾನ್ಯ ಪ್ರಶ್ನೆಗಳು:\n${qKn.map(q => `- ${q}`).join("\n")}` : "",
        vEn ? `YouTube (English): ${vEn}` : "",
        vKn ? `YouTube (ಕನ್ನಡ): ${vKn}` : "",
        queryBlock,
      ].filter(Boolean);

      rows.push({
        type,
        title: `${title} [Kannada Native]`,
        content: sections.join("\n\n").trim(),
      });
    }

    // ── Auto-extract video_link entries ──────────────────────────────
    // The widget's video suggestion engine (findRelevantVideo) looks
    // ONLY for type='video_link' rows with a specific JSON structure.
    if (vEn || vKn) {
      const searchTerms: string[] = [];
      for (const q of qEn) { const t = q.trim().toLowerCase(); if (t) searchTerms.push(t); }
      for (const q of qHi) { const t = q.trim(); if (t) searchTerms.push(t); }
      for (const q of qKn) { const t = q.trim(); if (t) searchTerms.push(t); }
      searchTerms.push(title.toLowerCase());

      rows.push({
        type: "video_link",
        title: `Video: ${title}`,
        content: JSON.stringify({
          title,
          link_en: vEn || "",
          link_kn: vKn || "",
          search_terms: [...new Set(searchTerms)],
        }),
      });
    }
  }

  return rows.length ? rows : null;
}

function chunkText(text: string, maxChars = 1500): string[] {
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if ((current + "\n\n" + para).length > maxChars && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text.slice(0, maxChars)];
}

function inferType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.includes("faq")) return "faq";
  if (lower.includes("competitor") || lower.includes("competition")) return "competitor_info";
  if (lower.includes("objection")) return "objection_handling";
  return "product_info";
}

router.get("/training", async (req, res) => {
  const userId = req.userId!;
  const data = await db.select().from(trainingDataTable).where(eq(trainingDataTable.userId, userId)).orderBy(trainingDataTable.createdAt);
  res.json(data);
});

router.post("/training", async (req, res) => {
  const userId = req.userId!;
  const { type, title, content } = req.body;
  if (!type || !title || !content) {
    res.status(400).json({ error: "type, title, and content are required" });
    return;
  }
  const [item] = await db.insert(trainingDataTable).values({ userId, type, title, content }).returning();
  res.status(201).json(item);
});

router.post("/training/upload", upload.single("file"), async (req, res) => {
  const userId = req.userId!;

  if (!req.file) {
    res.status(400).json({ error: "No file uploaded." });
    return;
  }

  const file = req.file;
  const overrideType = (req.body.type as string) || inferType(file.originalname);
  const baseName = file.originalname.replace(/\.[^.]+$/, "");
  const ext = file.originalname.split(".").pop()?.toLowerCase();

  if (file.mimetype === "application/json" || ext === "json") {
    try {
      const jsonText = file.buffer.toString("utf-8");
      const structuredRows = parseStructuredTrainingJson(jsonText, overrideType);
      if (structuredRows && structuredRows.length) {
        const insertedRows = await Promise.all(
          structuredRows.map(row =>
            db.insert(trainingDataTable).values({
              userId,
              type: row.type,
              title: row.title,
              content: row.content,
            }).returning()
          )
        );
        res.status(201).json({
          created: insertedRows.length,
          items: insertedRows.map(r => r[0]),
          message: `Created ${insertedRows.length} knowledge base ${insertedRows.length === 1 ? "entry" : "entries"} from structured JSON "${file.originalname}".`,
        });
        return;
      }
    } catch (err: any) {
      res.status(422).json({ error: `Could not parse JSON file: ${err.message}` });
      return;
    }
  }

  let rawText: string;
  try {
    rawText = await extractText(file);
  } catch (err: any) {
    res.status(422).json({ error: `Could not parse file: ${err.message}` });
    return;
  }

  rawText = rawText.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();

  if (!rawText || rawText.length < 3) {
    res.status(422).json({ error: "File contains no extractable text. If this is a scanned PDF, please upload a text-based PDF instead." });
    return;
  }

  const chunks = chunkText(rawText, 1500);

  const inserted = await Promise.all(
    chunks.map((chunk, idx) => {
      const title = chunks.length === 1
        ? baseName
        : `${baseName} (part ${idx + 1} of ${chunks.length})`;

      return db.insert(trainingDataTable).values({
        userId,
        type: overrideType,
        title,
        content: chunk,
      }).returning();
    })
  );

  res.status(201).json({
    created: inserted.length,
    items: inserted.map(r => r[0]),
    message: `Created ${inserted.length} knowledge base ${inserted.length === 1 ? "entry" : "entries"} from "${file.originalname}".`,
  });
});

// Delete a single training entry
router.delete("/training/:id", async (req, res) => {
  const userId = req.userId!;
  await db.delete(trainingDataTable).where(
    and(eq(trainingDataTable.id, parseInt(req.params.id)), eq(trainingDataTable.userId, userId))
  );
  res.status(204).send();
});

// Delete ALL training entries for the current tenant
router.delete("/training", async (req, res) => {
  const userId = req.userId!;
  const deleted = await db.delete(trainingDataTable)
    .where(eq(trainingDataTable.userId, userId))
    .returning({ id: trainingDataTable.id });
  res.json({ deleted: deleted.length, message: `Deleted ${deleted.length} training entries.` });
});

// ── Intent-Specific Training CRUD ──────────────────────────────────────────

// GET all intent training configurations for the current user
router.get("/intent-training", async (req, res) => {
  const userId = req.userId!;
  try {
    const data = await db.select().from(intentTrainingTable)
      .where(eq(intentTrainingTable.userId, userId))
      .orderBy(intentTrainingTable.intent);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: `Failed to fetch intent training: ${err.message}` });
  }
});

// Create or update (upsert) an intent training configuration
router.post("/intent-training", async (req, res) => {
  const userId = req.userId!;
  const { intent, trainingContent, maxTurns, autoTransfer, transferTo, crmAgentId } = req.body;

  if (!intent || trainingContent === undefined) {
    res.status(400).json({ error: "intent and trainingContent are required" });
    return;
  }

  try {
    const existing = await db.query.intentTrainingTable.findFirst({
      where: and(
        eq(intentTrainingTable.userId, userId),
        eq(intentTrainingTable.intent, intent)
      )
    });

    if (existing) {
      const [updated] = await db.update(intentTrainingTable)
        .set({
          trainingContent,
          maxTurns: maxTurns !== undefined ? parseInt(maxTurns, 10) : existing.maxTurns,
          autoTransfer: autoTransfer !== undefined ? !!autoTransfer : existing.autoTransfer,
          transferTo: transferTo !== undefined ? (transferTo || null) : existing.transferTo,
          crmAgentId: crmAgentId !== undefined ? (crmAgentId || null) : existing.crmAgentId,
          updatedAt: new Date(),
        })
        .where(eq(intentTrainingTable.id, existing.id))
        .returning();
      res.json(updated);
    } else {
      const [inserted] = await db.insert(intentTrainingTable)
        .values({
          userId,
          intent,
          trainingContent,
          maxTurns: maxTurns !== undefined ? parseInt(maxTurns, 10) : 8,
          autoTransfer: autoTransfer !== undefined ? !!autoTransfer : true,
          transferTo: transferTo || null,
          crmAgentId: crmAgentId || null,
        })
        .returning();
      res.status(201).json(inserted);
    }
  } catch (err: any) {
    res.status(500).json({ error: `Failed to save intent training: ${err.message}` });
  }
});

// Delete an intent training configuration
router.delete("/intent-training/:id", async (req, res) => {
  const userId = req.userId!;
  try {
    await db.delete(intentTrainingTable).where(
      and(
        eq(intentTrainingTable.id, parseInt(req.params.id, 10)),
        eq(intentTrainingTable.userId, userId)
      )
    );
    res.status(204).send();
  } catch (err: any) {
    res.status(500).json({ error: `Failed to delete intent training: ${err.message}` });
  }
});

export default router;
