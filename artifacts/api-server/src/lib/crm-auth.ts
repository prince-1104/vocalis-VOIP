import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { db, crmApiKeysTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { resolveCrmCredential, AuthorizationError } from "./crm-authorization";

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
      /** Stored (encrypted) representation; decrypt with openCredential. */
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

    const identity = await resolveCrmCredential(authHeader.slice(7).trim());
    const apiKey = await db.query.crmApiKeysTable.findFirst({ where: eq(crmApiKeysTable.id, identity.apiKeyId) });
    if (!apiKey?.isActive || apiKey.userId !== identity.userId || apiKey.tenantId !== identity.tenantId) throw new AuthorizationError(401);

    // Update last used timestamp (fire and forget)
    db.update(crmApiKeysTable)
      .set({ lastUsedAt: new Date() })
      .where(eq(crmApiKeysTable.id, apiKey.id))
      .catch((err) => logger.error({ err }, "Failed to update API key lastUsedAt"));

    // Inject CRM context into request
    req.userId = identity.userId;
    req.tenantId = identity.tenantId;
    req.crmApiKeyId = apiKey.id;
    req.crmApiKeyScopes = identity.scopes;
    req.crmWebhookUrl = apiKey.webhookUrl || undefined;
    req.crmWebhookSecret = apiKey.webhookSecret || undefined;

    next();
  } catch (err) {
    if (err instanceof AuthorizationError) { res.status(err.status).json({ error: "Access denied" }); return; }
    logger.error("CRM API key authorization unavailable");
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
