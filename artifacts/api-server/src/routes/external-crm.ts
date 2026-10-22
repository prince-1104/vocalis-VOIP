import { Router, type IRouter } from "express";
import { db, externalCrmConfigsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { invalidateExternalCrmConfigCache, testExternalCrmLookup } from "../lib/external-crm-lookup";
import { crmHttp } from "../lib/crm-http";
import { sealCredential } from "../lib/credential-crypto";
import { crmTestRateLimit } from "../lib/rate-limit-policies";

const router: IRouter = Router();

const PHONE_PLACEHOLDER = "phoneplaceholder0";

const RESERVED_AUTH_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "content-type",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "keep-alive",
  "expect",
  "proxy-authorization",
  "proxy-connection",
]);

// GET /api/external-crm/config — Get current CRM config
router.get("/external-crm/config", async (req, res) => {
  const userId = req.userId!;

  const config = await db.query.externalCrmConfigsTable.findFirst({
    where: eq(externalCrmConfigsTable.userId, userId),
  });

  if (!config) {
    res.json({ config: null });
    return;
  }

  res.json({
    config: {
      id: config.id,
      name: config.name,
      isEnabled: config.isEnabled,
      lookupUrl: config.lookupUrl,
      httpMethod: config.httpMethod,
      authType: config.authType,
      authValue: config.authValue ? "***configured***" : null,
      authHeaderName: config.authHeaderName,
      phoneParamName: config.phoneParamName,
      phoneParamLocation: config.phoneParamLocation,
      responseMapping: config.responseMapping,
      useRawResponse: config.useRawResponse,
      maxContextChars: config.maxContextChars,
      timeoutMs: config.timeoutMs,
      cacheTtlSeconds: config.cacheTtlSeconds,
      openingPitch: config.openingPitch,
      endingPitch: config.endingPitch,
      unknownCallerPitch: config.unknownCallerPitch,
      endingNote: config.endingNote,
      maxAiInteractionSeconds: config.maxAiInteractionSeconds,
      endingNoteLeadSeconds: config.endingNoteLeadSeconds,
      callInstructions: config.callInstructions,
      verifyIdentity: config.verifyIdentity,
      widgetChatWebhookUrl: config.widgetChatWebhookUrl,
      widgetChatSyncEnabled: config.widgetChatSyncEnabled,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    },
  });
});

// PUT /api/external-crm/config — Create or update CRM config
router.put("/external-crm/config", async (req, res) => {
  const userId = req.userId!;
  const {
    name,
    isEnabled,
    lookupUrl,
    httpMethod,
    authType,
    authValue,
    authHeaderName,
    phoneParamName,
    phoneParamLocation,
    responseMapping,
    useRawResponse,
    maxContextChars,
    timeoutMs,
    cacheTtlSeconds,
    openingPitch,
    endingPitch,
    unknownCallerPitch,
    endingNote,
    maxAiInteractionSeconds,
    endingNoteLeadSeconds,
    callInstructions,
    verifyIdentity,
    widgetChatWebhookUrl,
    widgetChatSyncEnabled,
  } = req.body;

  if (!lookupUrl || !name) {
    res.status(400).json({ error: "name and lookupUrl are required" });
    return;
  }

  // Request time re-validates the final URL and every resolved address; this
  // only rejects unusable destinations before they are stored.
  try {
    const parsed = crmHttp.assertUrl(String(lookupUrl).replace(/\{phone\}/g, PHONE_PLACEHOLDER));
    // The caller's phone may only be substituted into the path or query.
    if (parsed.host.includes(PHONE_PLACEHOLDER)) throw new Error("phone placeholder in host");
  } catch {
    res.status(400).json({ error: "lookupUrl must be a public HTTPS URL without embedded credentials" });
    return;
  }
  const chatWebhookUrl = typeof widgetChatWebhookUrl === "string" ? widgetChatWebhookUrl.trim() : "";
  if (chatWebhookUrl) {
    try {
      crmHttp.assertUrl(chatWebhookUrl);
    } catch {
      res.status(400).json({ error: "widgetChatWebhookUrl must be a public HTTPS URL without embedded credentials" });
      return;
    }
  }
  if (
    authHeaderName &&
    (typeof authHeaderName !== "string" ||
      !/^[A-Za-z0-9-]{1,64}$/.test(authHeaderName) ||
      RESERVED_AUTH_HEADERS.has(authHeaderName.toLowerCase()))
  ) {
    res.status(400).json({ error: "authHeaderName is not a valid custom header name" });
    return;
  }

  const existing = await db.query.externalCrmConfigsTable.findFirst({
    where: eq(externalCrmConfigsTable.userId, userId),
  });

  const data: Record<string, unknown> = {
    name,
    isEnabled: isEnabled !== false,
    lookupUrl,
    httpMethod: httpMethod || "GET",
    authType: authType || "bearer",
    authHeaderName: authHeaderName || null,
    phoneParamName: phoneParamName || "phone",
    phoneParamLocation: phoneParamLocation || "query",
    responseMapping: responseMapping || null,
    useRawResponse: useRawResponse || false,
    maxContextChars: maxContextChars || 2000,
    timeoutMs: timeoutMs || 3000,
    cacheTtlSeconds: cacheTtlSeconds || 300,
    openingPitch: openingPitch?.trim() || null,
    endingPitch: endingPitch?.trim() || null,
    unknownCallerPitch: unknownCallerPitch?.trim() || null,
    endingNote: endingNote?.trim() || null,
    maxAiInteractionSeconds: Math.max(0, Number(maxAiInteractionSeconds) || 0),
    endingNoteLeadSeconds: Math.max(0, Number(endingNoteLeadSeconds) ?? 2),
    callInstructions: callInstructions?.trim() || null,
    verifyIdentity: verifyIdentity === true,
    widgetChatWebhookUrl: chatWebhookUrl || null,
    widgetChatSyncEnabled: widgetChatSyncEnabled === true,
    updatedAt: new Date(),
  };

  // Only update authValue if a new non-masked value is provided
  if (authValue && authValue !== "***configured***") {
    data.authValue = sealCredential("crmAuthValue", userId, String(authValue));
  } else if (!existing) {
    data.authValue = null;
  }

  if (existing) {
    const [updated] = await db.update(externalCrmConfigsTable)
      .set(data)
      .where(eq(externalCrmConfigsTable.id, existing.id))
      .returning();

    invalidateExternalCrmConfigCache(userId);
    res.json({ config: maskConfig(updated), created: false });
  } else {
    const [created] = await db.insert(externalCrmConfigsTable)
      .values({ userId, ...data } as any)
      .returning();

    invalidateExternalCrmConfigCache(userId);
    res.status(201).json({ config: maskConfig(created), created: true });
  }
});

// DELETE /api/external-crm/config — Remove CRM config
router.delete("/external-crm/config", async (req, res) => {
  const userId = req.userId!;

  const existing = await db.query.externalCrmConfigsTable.findFirst({
    where: eq(externalCrmConfigsTable.userId, userId),
  });

  if (!existing) {
    res.status(404).json({ error: "No external CRM configuration found" });
    return;
  }

  await db.delete(externalCrmConfigsTable)
    .where(eq(externalCrmConfigsTable.id, existing.id));

  invalidateExternalCrmConfigCache(userId);
  res.json({ success: true, message: "External CRM configuration deleted" });
});

// POST /api/external-crm/test — Test the CRM lookup with a phone number
router.post("/external-crm/test", crmTestRateLimit, async (req, res) => {
  const userId = req.userId!;
  const { phone } = req.body;

  if (!phone) {
    res.status(400).json({ error: "phone is required" });
    return;
  }

  const result = await testExternalCrmLookup(userId, phone);
  res.json(result);
});

function maskConfig(config: any) {
  return {
    ...config,
    authValue: config.authValue ? "***configured***" : null,
  };
}

export default router;
