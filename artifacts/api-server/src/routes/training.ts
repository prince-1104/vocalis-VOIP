import { Router, type IRouter } from "express";
import { db, trainingDataTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import multer from "multer";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/json",
      "text/plain",
    ];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(pdf|docx|json|txt)$/i)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, DOCX, JSON, and TXT files are supported."));
    }
  },
});

async function extractText(file: Express.Multer.File): Promise<string> {
  const ext = file.originalname.split(".").pop()?.toLowerCase();

  if (file.mimetype === "application/pdf" || ext === "pdf") {
    const parsed = await pdfParse(file.buffer);
    return parsed.text;
  }

  if (
    file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value;
  }

  if (file.mimetype === "application/json" || ext === "json") {
    const obj = JSON.parse(file.buffer.toString("utf-8"));
    return JSON.stringify(obj, null, 2);
  }

  return file.buffer.toString("utf-8");
}

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

    const sections = [
      ansEn ? `English Answer:\n${ansEn}` : "",
      ansHi ? `Hindi Answer:\n${ansHi}` : "",
      ansKn ? `Kannada Answer:\n${ansKn}` : "",
      qEn.length ? `English Queries:\n${qEn.map(q => `- ${q}`).join("\n")}` : "",
      qHi.length ? `Hindi Queries:\n${qHi.map(q => `- ${q}`).join("\n")}` : "",
      qKn.length ? `Kannada Queries:\n${qKn.map(q => `- ${q}`).join("\n")}` : "",
      vEn ? `Suggested YouTube (English): ${vEn}` : "",
      vKn ? `Suggested YouTube (Kannada): ${vKn}` : "",
      "Rule: Suggest at most one best-fit video and never repeat the same link in one reply.",
    ].filter(Boolean);

    rows.push({
      type,
      title,
      content: sections.join("\n\n").trim(),
    });
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

router.delete("/training/:id", async (req, res) => {
  const userId = req.userId!;
  await db.delete(trainingDataTable).where(
    and(eq(trainingDataTable.id, parseInt(req.params.id)), eq(trainingDataTable.userId, userId))
  );
  res.status(204).send();
});

export default router;
