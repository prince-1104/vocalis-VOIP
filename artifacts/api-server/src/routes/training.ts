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

  let rawText: string;
  try {
    rawText = await extractText(file);
  } catch (err: any) {
    res.status(422).json({ error: `Could not parse file: ${err.message}` });
    return;
  }

  rawText = rawText.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();

  if (!rawText || rawText.length < 10) {
    res.status(422).json({ error: "File appears to be empty or unreadable." });
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
