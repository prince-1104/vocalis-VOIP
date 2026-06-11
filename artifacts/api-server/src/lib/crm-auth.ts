import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { db, crmApiKeysTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "./logger";

// ── API Key Authentication for CRM Integration ────────────────────────
//
// CRM sends: Authorization: Bearer dk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//
// We hash the key with SHA-256 and look it up in crm_api_keys. If found
// and active, we inject userId/tenantId into the request and proceed.

declare global {
  namespace Express {
    interface Request {
      crmApiKeyId?: number;
      crmApiKeyScopes?: string[];
      crmWebhookUrl?: string;
      crmWebhookSecret?: string;
    }
  }
}

const CRM_KEY_PREFIX = "dk_live_";

function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export function generateCrmApiKey(): { key: string; hash: string; prefix: string } {
  const randomPart = crypto.randomBytes(32).toString("hex");
  const key = `${CRM_KEY_PREFIX}${randomPart}`;
  const hash = hashApiKey(key);
  const prefix = key.slice(0, 16);
  return { key, hash, prefix };
}

export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function signWebhookPayload(payload: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
}

export async function resolveCrmApiKey(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers["authorization"] as string | undefined;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing API key. Use Authorization: Bearer dk_live_xxx" });
      return;
    }

    const rawKey = authHeader.slice(7).trim();

    if (!rawKey.startsWith(CRM_KEY_PREFIX)) {
      res.status(401).json({ error: "Invalid API key format. Keys must start with dk_live_" });
      return;
    }

    const hash = hashApiKey(rawKey);

    const apiKey = await db.query.crmApiKeysTable.findFirst({
      where: and(
        eq(crmApiKeysTable.keyHash, hash),
        eq(crmApiKeysTable.isActive, true),
      ),
    });

    if (!apiKey) {
      res.status(401).json({ error: "Invalid or inactive API key" });
      return;
    }

    // Update last used timestamp (fire and forget)
    db.update(crmApiKeysTable)
      .set({ lastUsedAt: new Date() })
      .where(eq(crmApiKeysTable.id, apiKey.id))
      .catch((err) => logger.error({ err }, "Failed to update API key lastUsedAt"));

    // Inject CRM context into request
    req.userId = apiKey.userId;
    req.tenantId = apiKey.tenantId;
    req.crmApiKeyId = apiKey.id;
    req.crmApiKeyScopes = (apiKey.scopes as string[]) || [];
    req.crmWebhookUrl = apiKey.webhookUrl || undefined;
    req.crmWebhookSecret = apiKey.webhookSecret || undefined;

    next();
  } catch (err) {
    logger.error({ err }, "CRM API key auth error");
    next(err);
  }
}

export function requireScope(...scopes: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const keyScopes = req.crmApiKeyScopes || [];
    const hasWildcard = keyScopes.includes("*");
    if (hasWildcard) return next();

    const missing = scopes.filter(s => !keyScopes.includes(s));
    if (missing.length > 0) {
      res.status(403).json({
        error: `Insufficient scope. Required: ${scopes.join(", ")}. Your key has: ${keyScopes.join(", ")}`,
        missing,
      });
      return;
    }
    next();
  };
}
