import { Router, type IRouter } from "express";
import {
  db,
  callLogsTable,
  contactsTable,
  agentConfigsTable,
  campaignsTable,
  campaignContactsTable,
  crmApiKeysTable,
  crmAgentsTable,
  webhookDeliveriesTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { resolveCrmApiKey, requireScope, generateCrmApiKey, generateWebhookSecret } from "../lib/crm-auth";
import { crmEventBus } from "../lib/crm-event-bus";
import { executeTransfer, findBestAgent } from "../lib/transfer-manager";
import { placeOutboundCall, TelephonyNotConfiguredError } from "../lib/telephony/place-outbound-call";
import { SpendLimitError, spendLimitHttpStatus } from "../lib/billing/spend-budget";
import { addSuppression, DialBlockedError, dialBlockedHttpStatus, SUPPRESSION_REASONS, type SuppressionReason } from "../lib/call-suppression";
import { callingWindowProblem, DEFAULT_CAMPAIGN_TIMEZONE } from "../lib/calling-window";
import { hangupCall } from "../lib/telephony/hangup-call";
import { logger } from "../lib/logger";
import { crmHttp } from "../lib/crm-http";
import { CredentialError, openCredential, sealCredential } from "../lib/credential-crypto";
import {
  adminMutationRateLimit,
  crmAuthFailureRateLimit,
  crmCallCreateRateLimit,
  crmCampaignCreateRateLimit,
  crmCampaignStartRateLimit,
  crmKeyRateLimit,
  crmTransferRateLimit,
  crmWebhookConfigRateLimit,
} from "../lib/rate-limit-policies";

const router: IRouter = Router();

// ── All CRM routes require API key auth ────────────────────────────────
router.use("/crm", crmAuthFailureRateLimit, resolveCrmApiKey, crmKeyRateLimit);

// ═══════════════════════════════════════════════════════════════════════
// CALLS
// ═══════════════════════════════════════════════════════════════════════

function getBaseUrl(req: any): string {
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) {
    const first = domains.split(",")[0].trim();
    return `https://${first}`;
  }
  const host = req.headers.host || "localhost";
  return `https://${host}`;
}

// POST /api/crm/calls — Initiate an outbound AI call
router.post("/crm/calls", requireScope("calls:write"), crmCallCreateRateLimit, async (req, res) => {
  const userId = req.userId!;

  const {
    phone,
    campaignId,
    crmContactId,
    scriptId,
    metadata,
    transferRules,
  } = req.body;

  if (!phone) {
    res.status(400).json({ error: "phone is required" });
    return;
  }

  let ownedCampaign: number | null = null;
  if (campaignId !== undefined && campaignId !== null && campaignId !== "") {
    const id = typeof campaignId === "number" ? campaignId
      : typeof campaignId === "string" && /^\d{1,9}$/.test(campaignId) ? Number(campaignId) : NaN;
    const campaign = Number.isSafeInteger(id) && id > 0
      ? await db.query.campaignsTable.findFirst({
          where: and(eq(campaignsTable.id, id), eq(campaignsTable.userId, userId)),
        })
      : undefined;
    if (!campaign) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    ownedCampaign = campaign.id;
  }

  const agentConfig = await db.query.agentConfigsTable.findFirst({
    where: eq(agentConfigsTable.userId, userId),
  });

  const baseUrl = getBaseUrl(req);
  const mergedMetadata = transferRules
    ? { ...(metadata || {}), __transferRules: transferRules }
    : (metadata || null);

  try {
    // Routes through Exotel or Twilio based on the tenant's telephonyType.
    const placed = await placeOutboundCall({
      userId,
      campaignId: ownedCampaign,
      phone,
      aiModel: agentConfig?.aiModel || undefined,
      baseUrl,
      crmContactId: crmContactId || null,
      crmMetadata: mergedMetadata,
    });

    // Emit ringing event
    crmEventBus.emitCallEvent({
      type: "call.ringing",
      callId: placed.callLogId,
      callSid: placed.providerCallId,
      userId,
      data: { phone, campaignId: ownedCampaign, provider: placed.provider },
      metadata,
      timestamp: new Date().toISOString(),
    });

    res.json({
      callId: placed.callLogId,
      callSid: placed.providerCallId,
      status: "dialing",
      provider: placed.provider,
      streamUrl: `wss://${req.headers.host}/ws/crm/calls/${placed.callLogId}`,
    });
  } catch (err: any) {
    if (err instanceof DialBlockedError) {
      logger.warn({ reason: err.code }, "CRM call blocked before dispatch");
      res.status(dialBlockedHttpStatus(err)).json({ error: err.message, reason: err.code });
      return;
    }
    if (err instanceof SpendLimitError) {
      logger.warn({ reason: err.code }, "CRM call blocked by spend limit");
      res.status(spendLimitHttpStatus(err)).json({ error: err.message, reason: err.code });
      return;
    }
    logger.error({ err }, "CRM call initiation failed");

    if (err instanceof TelephonyNotConfiguredError) {
      res.status(400).json({ error: err.message });
      return;
    }

    res.status(500).json({
      error: "Failed to initiate call",
      detail: err.message,
    });
  }
});

// GET /api/crm/calls/:id — Get call details + transcript
router.get("/crm/calls/:id", requireScope("calls:read"), async (req, res) => {
  const userId = req.userId!;
  const callId = parseInt(req.params.id as string);

  if (isNaN(callId)) {
    res.status(400).json({ error: "Invalid call ID" });
    return;
  }

  const call = await db.query.callLogsTable.findFirst({
    where: and(eq(callLogsTable.id, callId), eq(callLogsTable.userId, userId)),
  });

  if (!call) {
    res.status(404).json({ error: "Call not found" });
    return;
  }

  res.json({
    callId: call.id,
    callSid: call.callSid,
    phone: call.phone,
    direction: call.direction,
    status: call.endedAt ? "completed" : "active",
    outcome: call.outcome,
    duration: call.duration,
    transcript: call.transcript,
    liveTranscript: call.liveTranscript,
    aiSummary: call.aiSummary,
    recordingUrl: call.recordingUrl,
    crmContactId: call.crmContactId,
    crmMetadata: call.crmMetadata,
    transferredTo: call.transferredTo,
    transferReason: call.transferReason,
    transferredAt: call.transferredAt,
    conferenceSid: call.conferenceSid,
    estimatedCostUsd: call.estimatedCostUsd,
    billedCostUsd: call.billedCostUsd,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
  });
});

// GET /api/crm/calls/:id/transcript — Get live transcript (polling fallback)
router.get("/crm/calls/:id/transcript", requireScope("calls:read"), async (req, res) => {
  const userId = req.userId!;
  const callId = parseInt(req.params.id as string);

  if (isNaN(callId)) {
    res.status(400).json({ error: "Invalid call ID" });
    return;
  }

  const call = await db.query.callLogsTable.findFirst({
    where: and(eq(callLogsTable.id, callId), eq(callLogsTable.userId, userId)),
  });

  if (!call) {
    res.status(404).json({ error: "Call not found" });
    return;
  }

  res.json({
    callId: call.id,
    isActive: !call.endedAt,
    liveTranscript: call.liveTranscript || [],
    fullTranscript: call.transcript,
  });
});

// POST /api/crm/calls/:id/transfer — Transfer an active call to a CRM agent
router.post("/crm/calls/:id/transfer", requireScope("calls:write"), crmTransferRateLimit, async (req, res) => {
  const userId = req.userId!;
  const callId = parseInt(req.params.id as string);

  if (isNaN(callId)) {
    res.status(400).json({ error: "Invalid call ID" });
    return;
  }

  const call = await db.query.callLogsTable.findFirst({
    where: and(eq(callLogsTable.id, callId), eq(callLogsTable.userId, userId)),
  });

  if (!call) {
    res.status(404).json({ error: "Call not found" });
    return;
  }

  if (call.endedAt) {
    res.status(400).json({ error: "Call has already ended" });
    return;
  }

  if (!call.callSid) {
    res.status(400).json({ error: "Call SID not available — call may not have connected yet" });
    return;
  }

  const {
    transferTo,
    crmAgentId,
    reason,
    transferType = "cold",
    briefingMessage,
  } = req.body;

  // Resolve transfer target
  let targetPhone = transferTo;
  let resolvedAgentId = crmAgentId;

  if (!targetPhone && crmAgentId) {
    const agent = await db.query.crmAgentsTable.findFirst({
      where: and(
        eq(crmAgentsTable.userId, userId),
        eq(crmAgentsTable.crmAgentId, crmAgentId),
      ),
    });

    if (!agent) {
      res.status(404).json({ error: `CRM agent ${crmAgentId} not found` });
      return;
    }
    if (!agent.phone) {
      res.status(400).json({ error: `CRM agent ${crmAgentId} has no phone configured` });
      return;
    }
    targetPhone = agent.phone;
  }

  if (!targetPhone) {
    res.status(400).json({ error: "Either transferTo (phone) or crmAgentId is required" });
    return;
  }

  const result = await executeTransfer(userId, {
    callId,
    callSid: call.callSid,
    transferTo: targetPhone,
    reason: reason || "CRM-initiated transfer",
    transferType,
    briefingMessage,
    crmAgentId: resolvedAgentId,
  });

  if (result.success) {
    res.json({
      success: true,
      conferenceSid: result.conferenceSid,
      message: `Call ${callId} transfer initiated to ${targetPhone}`,
    });
  } else {
    res.status(500).json({
      success: false,
      error: result.error,
    });
  }
});

// POST /api/crm/calls/:id/end — Force-end an active call
router.post("/crm/calls/:id/end", requireScope("calls:write"), async (req, res) => {
  const userId = req.userId!;
  const callId = parseInt(req.params.id as string);

  if (isNaN(callId)) {
    res.status(400).json({ error: "Invalid call ID" });
    return;
  }

  const call = await db.query.callLogsTable.findFirst({
    where: and(eq(callLogsTable.id, callId), eq(callLogsTable.userId, userId)),
  });

  if (!call) {
    res.status(404).json({ error: "Call not found" });
    return;
  }

  if (call.endedAt) {
    res.status(400).json({ error: "Call has already ended" });
    return;
  }

  if (!call.callSid) {
    res.status(400).json({ error: "Call SID not available" });
    return;
  }

  try {
    await hangupCall(userId, call.callSid, call.phone || undefined);

    await db.update(callLogsTable)
      .set({ endedAt: new Date(), outcome: "answered" })
      .where(eq(callLogsTable.id, callId));

    res.json({ success: true, message: `Call ${callId} ended` });
  } catch (err: any) {
    logger.error({ err, callId }, "Failed to end call");
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// CRM AGENTS
// ═══════════════════════════════════════════════════════════════════════

// GET /api/crm/agents — List CRM agents
router.get("/crm/agents", requireScope("calls:read"), async (req, res) => {
  const userId = req.userId!;

  const agents = await db.select().from(crmAgentsTable)
    .where(eq(crmAgentsTable.userId, userId))
    .orderBy(desc(crmAgentsTable.createdAt));

  res.json({ agents });
});

// POST /api/crm/agents — Register a CRM agent for transfer
router.post("/crm/agents", requireScope("calls:write"), async (req, res) => {
  const userId = req.userId!;
  const { crmAgentId, name, specialization, phone, sipUri, intents, maxConcurrentCalls } = req.body;

  if (!crmAgentId || !name) {
    res.status(400).json({ error: "crmAgentId and name are required" });
    return;
  }

  // Upsert — update if exists, create if not
  const existing = await db.query.crmAgentsTable.findFirst({
    where: and(
      eq(crmAgentsTable.userId, userId),
      eq(crmAgentsTable.crmAgentId, crmAgentId),
    ),
  });

  if (existing) {
    await db.update(crmAgentsTable)
      .set({
        name,
        specialization: specialization || existing.specialization,
        phone: phone || existing.phone,
        sipUri: sipUri || existing.sipUri,
        intents: intents || existing.intents,
        maxConcurrentCalls: maxConcurrentCalls || existing.maxConcurrentCalls,
        updatedAt: new Date(),
      })
      .where(eq(crmAgentsTable.id, existing.id));

    const updated = await db.query.crmAgentsTable.findFirst({
      where: eq(crmAgentsTable.id, existing.id),
    });

    res.json({ agent: updated, created: false });
  } else {
    const [agent] = await db.insert(crmAgentsTable).values({
      userId,
      crmAgentId,
      name,
      specialization,
      phone,
      sipUri,
      intents: intents || [],
      maxConcurrentCalls: maxConcurrentCalls || 3,
    }).returning();

    res.status(201).json({ agent, created: true });
  }
});

// PATCH /api/crm/agents/:crmAgentId/availability — Update agent availability
router.patch("/crm/agents/:crmAgentId/availability", requireScope("calls:write"), async (req, res) => {
  const userId = req.userId!;
  const { crmAgentId } = req.params;
  const { isAvailable } = req.body;

  const agent = await db.query.crmAgentsTable.findFirst({
    where: and(
      eq(crmAgentsTable.userId, userId),
      eq(crmAgentsTable.crmAgentId, crmAgentId as string),
    ),
  });

  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  await db.update(crmAgentsTable)
    .set({ isAvailable: isAvailable !== false, updatedAt: new Date() })
    .where(eq(crmAgentsTable.id, agent.id));

  res.json({ success: true, crmAgentId, isAvailable: isAvailable !== false });
});

// ═══════════════════════════════════════════════════════════════════════
// WEBHOOKS
// ═══════════════════════════════════════════════════════════════════════

// POST /api/crm/webhooks — Register/update webhook URL
router.post("/crm/webhooks", crmWebhookConfigRateLimit, async (req, res) => {
  const apiKeyId = req.crmApiKeyId!;
  const { webhookUrl } = req.body;

  if (!webhookUrl) {
    res.status(400).json({ error: "webhookUrl is required" });
    return;
  }

  // Delivery re-validates the URL and every resolved address on each attempt.
  try {
    crmHttp.assertUrl(webhookUrl);
  } catch {
    res.status(400).json({ error: "webhookUrl must be a public HTTPS URL without embedded credentials" });
    return;
  }

  // Re-registering keeps the existing signing secret. A stored secret that
  // cannot be decrypted fails the request rather than being replaced.
  let secret: string;
  try {
    secret = openCredential("crmWebhookSecret", req.userId!, req.crmWebhookSecret) ?? generateWebhookSecret();
  } catch (err) {
    logger.error(
      { event: "credential_unavailable", field: "crmWebhookSecret", ownerId: req.userId, reason: err instanceof CredentialError ? err.reason : "error" },
      "Stored credential unavailable",
    );
    res.status(500).json({ error: "Webhook signing secret is unavailable" });
    return;
  }

  await db.update(crmApiKeysTable)
    .set({
      webhookUrl,
      webhookSecret: sealCredential("crmWebhookSecret", req.userId!, secret),
      updatedAt: new Date(),
    })
    .where(eq(crmApiKeysTable.id, apiKeyId));

  res.json({
    webhookUrl,
    webhookSecret: secret,
    message: "Webhook configured. Use X-Dialog-Signature header to verify payloads.",
  });
});

// GET /api/crm/webhooks/deliveries — List recent webhook deliveries
router.get("/crm/webhooks/deliveries", async (req, res) => {
  const apiKeyId = req.crmApiKeyId!;
  const limit = parseInt(req.query.limit as string) || 50;
  const status = req.query.status as string;

  const conditions: any[] = [eq(webhookDeliveriesTable.apiKeyId, apiKeyId)];
  if (status) conditions.push(eq(webhookDeliveriesTable.status, status));

  const deliveries = await db.select().from(webhookDeliveriesTable)
    .where(and(...conditions))
    .orderBy(desc(webhookDeliveriesTable.createdAt))
    .limit(limit);

  res.json({ deliveries });
});

// ═══════════════════════════════════════════════════════════════════════
// CAMPAIGNS (from CRM)
// ═══════════════════════════════════════════════════════════════════════

// POST /api/crm/campaigns — Create a campaign from CRM
router.post("/crm/campaigns", requireScope("campaigns:write"), crmCampaignCreateRateLimit, async (req, res) => {
  const userId = req.userId!;
  const {
    name,
    description,
    contacts,         // array of { phone, firstName?, lastName?, crmContactId? }
    scriptId,
    startTime,
    endTime,
    timezone,
    maxConcurrentCalls,
    transferRules,
  } = req.body;

  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
    res.status(400).json({ error: "contacts array is required and must not be empty" });
    return;
  }

  const window = {
    startTime: startTime || "09:00",
    endTime: endTime || "17:00",
    timezone: timezone || DEFAULT_CAMPAIGN_TIMEZONE,
  };
  const windowProblem = callingWindowProblem(window);
  if (windowProblem) {
    res.status(400).json({ error: windowProblem });
    return;
  }

  // Create campaign
  const [campaign] = await db.insert(campaignsTable).values({
    userId,
    name,
    description,
    scriptId: scriptId || null,
    totalContacts: contacts.length,
    ...window,
    maxConcurrentCalls: maxConcurrentCalls || 1,
    status: "draft",
  }).returning();

  // Create contacts and link them to the campaign
  for (const c of contacts) {
    if (!c.phone) continue;

    // Check if contact exists
    const existing = await db.query.contactsTable.findFirst({
      where: and(eq(contactsTable.userId, userId), eq(contactsTable.phone, c.phone)),
    });

    let contactId: number;

    if (existing) {
      contactId = existing.id;
    } else {
      const [newContact] = await db.insert(contactsTable).values({
        userId,
        phone: c.phone,
        firstName: c.firstName || null,
        lastName: c.lastName || null,
        email: c.email || null,
        company: c.company || null,
        status: "pending",
      }).returning();
      contactId = newContact.id;
    }

    await db.insert(campaignContactsTable).values({
      campaignId: campaign.id,
      contactId,
    });
  }

  res.status(201).json({
    campaignId: campaign.id,
    name: campaign.name,
    totalContacts: contacts.length,
    status: "draft",
    message: "Campaign created. POST /api/crm/campaigns/:id/start to begin dialing.",
  });
});

// POST /api/crm/campaigns/:id/start — Activate a campaign
router.post("/crm/campaigns/:id/start", requireScope("campaigns:write"), crmCampaignStartRateLimit, async (req, res) => {
  const userId = req.userId!;
  const campaignId = parseInt(req.params.id as string);

  if (isNaN(campaignId)) {
    res.status(400).json({ error: "Invalid campaign ID" });
    return;
  }

  const campaign = await db.query.campaignsTable.findFirst({
    where: and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId)),
  });

  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  if (campaign.status === "active") {
    res.status(400).json({ error: "Campaign is already active" });
    return;
  }

  const windowProblem = callingWindowProblem(campaign);
  if (windowProblem) {
    res.status(400).json({ error: `Calling window is not configured correctly: ${windowProblem}` });
    return;
  }

  const activated = await db.update(campaignsTable)
    .set({ status: "active", updatedAt: new Date() })
    .where(and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId), eq(campaignsTable.status, campaign.status)))
    .returning();
  if (activated.length !== 1) {
    res.status(409).json({ error: "Campaign status changed; retry." });
    return;
  }

  res.json({
    campaignId,
    status: "active",
    message: "Campaign activated. Use POST /api/crm/campaigns/:id/dial-next to dial contacts.",
  });
});

// GET /api/crm/campaigns/:id/status — Campaign progress
router.get("/crm/campaigns/:id/status", requireScope("campaigns:read", "calls:read"), async (req, res) => {
  const userId = req.userId!;
  const campaignId = parseInt(req.params.id as string);

  if (isNaN(campaignId)) {
    res.status(400).json({ error: "Invalid campaign ID" });
    return;
  }

  const campaign = await db.query.campaignsTable.findFirst({
    where: and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId)),
  });

  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  // Get call stats for this campaign
  const calls = await db.select().from(callLogsTable)
    .where(and(eq(callLogsTable.userId, userId), eq(callLogsTable.campaignId, campaignId)));

  const stats = {
    total: campaign.totalContacts,
    called: campaign.calledCount,
    answered: calls.filter(c => c.outcome === "answered").length,
    interested: campaign.interestedCount,
    transferred: calls.filter(c => c.transferredTo).length,
    noAnswer: calls.filter(c => c.outcome === "no_answer").length,
    remaining: campaign.totalContacts - campaign.calledCount,
  };

  res.json({
    campaignId,
    name: campaign.name,
    status: campaign.status,
    stats,
  });
});

// ═══════════════════════════════════════════════════════════════════════
// OPT-OUTS / DO-NOT-CALL (record only; removal is dashboard-only)
// ═══════════════════════════════════════════════════════════════════════

// POST /api/crm/opt-outs — Record that a number must not be called by this tenant
router.post("/crm/opt-outs", (req, res, next) => {
  const scopes = req.crmApiKeyScopes || [];
  if (scopes.includes("calls:write") || scopes.includes("campaigns:write")) return next();
  res.status(403).json({ error: "Insufficient scope. Required: calls:write or campaigns:write." });
}, async (req, res) => {
  const userId = req.userId!;
  const { phone, reason } = req.body ?? {};
  const suppressionReason: SuppressionReason = reason === undefined ? "opt_out" : reason;
  if (!SUPPRESSION_REASONS.includes(suppressionReason)) {
    res.status(400).json({ error: `reason must be one of: ${SUPPRESSION_REASONS.join(", ")}` });
    return;
  }
  try {
    const recorded = await addSuppression(userId, phone, suppressionReason, "crm_api");
    if (!recorded) {
      res.status(400).json({ error: "The phone number is not valid." });
      return;
    }
    logger.info({ suppressionId: recorded.id, created: recorded.created, source: "crm_api" }, "Call suppression recorded");
    res.status(recorded.created ? 201 : 200).json({
      id: recorded.id,
      phone: recorded.phone,
      reason: recorded.reason,
      status: "suppressed",
    });
  } catch {
    logger.error({ source: "crm_api" }, "Call suppression could not be recorded");
    res.status(503).json({ error: "Opt-out could not be recorded; retry." });
  }
});

// Twilio conference / agent-leg callbacks are signed provider webhooks served
// by routes/twilio.ts (/api/twilio/conference-status, /api/twilio/agent-call-status).

// ═══════════════════════════════════════════════════════════════════════
// API KEY MANAGEMENT (admin only — requires the existing JWT auth)
// These endpoints are mounted separately under the authenticated routes
// ═══════════════════════════════════════════════════════════════════════

export const crmAdminRouter: IRouter = Router();

// POST /api/crm-admin/api-keys — Generate a new CRM API key
crmAdminRouter.post("/crm-admin/api-keys", adminMutationRateLimit, async (req, res) => {
  const userId = req.userId!;
  const tenantId = req.tenantId!;
  const { name, scopes } = req.body;

  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const { key, hash, prefix } = generateCrmApiKey();
  const webhookSecret = generateWebhookSecret();

  const [apiKey] = await db.insert(crmApiKeysTable).values({
    userId,
    tenantId,
    keyHash: hash,
    keyPrefix: prefix,
    name,
    scopes: scopes || ["calls:read", "calls:write", "campaigns:read", "campaigns:write"],
    webhookSecret: sealCredential("crmWebhookSecret", userId, webhookSecret),
  }).returning();

  // Return the full key ONLY on creation — it's never stored in plaintext
  res.status(201).json({
    id: apiKey.id,
    key,               // ⚠️ Only shown once!
    prefix: apiKey.keyPrefix,
    name: apiKey.name,
    scopes: apiKey.scopes,
    webhookSecret,
    message: "Save this API key — it will not be shown again.",
  });
});

// GET /api/crm-admin/api-keys — List API keys (without secrets)
crmAdminRouter.get("/crm-admin/api-keys", async (req, res) => {
  const userId = req.userId!;

  const keys = await db.select({
    id: crmApiKeysTable.id,
    keyPrefix: crmApiKeysTable.keyPrefix,
    name: crmApiKeysTable.name,
    scopes: crmApiKeysTable.scopes,
    webhookUrl: crmApiKeysTable.webhookUrl,
    isActive: crmApiKeysTable.isActive,
    lastUsedAt: crmApiKeysTable.lastUsedAt,
    createdAt: crmApiKeysTable.createdAt,
  }).from(crmApiKeysTable)
    .where(eq(crmApiKeysTable.userId, userId))
    .orderBy(desc(crmApiKeysTable.createdAt));

  res.json({ apiKeys: keys });
});

// DELETE /api/crm-admin/api-keys/:id — Permanently delete an API key
crmAdminRouter.delete("/crm-admin/api-keys/:id", adminMutationRateLimit, async (req, res) => {
  const userId = req.userId!;
  const keyId = parseInt(req.params.id);

  if (isNaN(keyId)) {
    res.status(400).json({ error: "Invalid key ID" });
    return;
  }

  const key = await db.query.crmApiKeysTable.findFirst({
    where: and(eq(crmApiKeysTable.id, keyId), eq(crmApiKeysTable.userId, userId)),
  });

  if (!key) {
    res.status(404).json({ error: "API key not found" });
    return;
  }

  await db.delete(crmApiKeysTable)
    .where(and(eq(crmApiKeysTable.id, keyId), eq(crmApiKeysTable.userId, userId)));

  res.json({ success: true, message: `API key ${key.keyPrefix}... deleted` });
});

// ── CRM Agents (JWT-auth for Dialer UI) ──

// GET /api/crm-agents — List CRM agents (admin UI)
crmAdminRouter.get("/crm-agents", async (req, res) => {
  const userId = req.userId!;
  const agents = await db.select().from(crmAgentsTable)
    .where(eq(crmAgentsTable.userId, userId))
    .orderBy(desc(crmAgentsTable.createdAt));
  res.json({ agents });
});

// POST /api/crm-agents — Register CRM agent (admin UI)
crmAdminRouter.post("/crm-agents", adminMutationRateLimit, async (req, res) => {
  const userId = req.userId!;
  const { crmAgentId, name, specialization, phone, intents, maxConcurrentCalls } = req.body;

  if (!crmAgentId || !name) {
    res.status(400).json({ error: "crmAgentId and name are required" });
    return;
  }

  const existing = await db.query.crmAgentsTable.findFirst({
    where: and(eq(crmAgentsTable.userId, userId), eq(crmAgentsTable.crmAgentId, crmAgentId)),
  });

  if (existing) {
    await db.update(crmAgentsTable)
      .set({ name, specialization, phone, intents: intents || existing.intents, maxConcurrentCalls: maxConcurrentCalls || existing.maxConcurrentCalls, updatedAt: new Date() })
      .where(eq(crmAgentsTable.id, existing.id));
    const updated = await db.query.crmAgentsTable.findFirst({ where: eq(crmAgentsTable.id, existing.id) });
    res.json({ agent: updated, created: false });
  } else {
    const [agent] = await db.insert(crmAgentsTable).values({
      userId, crmAgentId, name, specialization, phone, intents: intents || [], maxConcurrentCalls: maxConcurrentCalls || 3,
    }).returning();
    res.status(201).json({ agent, created: true });
  }
});

export default router;
