import { Router, type IRouter } from "express";
import twilio from "twilio";
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
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── All CRM routes require API key auth ────────────────────────────────
router.use("/crm", resolveCrmApiKey);

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
router.post("/crm/calls", requireScope("calls:write"), async (req, res) => {
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

  const agentConfig = await db.query.agentConfigsTable.findFirst({
    where: eq(agentConfigsTable.userId, userId),
  });

  if (!agentConfig?.twilioAccountSid || !agentConfig?.twilioAuthToken) {
    res.status(400).json({ error: "Twilio credentials not configured for this tenant" });
    return;
  }

  if (!agentConfig.phoneNumber) {
    res.status(400).json({ error: "Twilio phone number not configured for this tenant" });
    return;
  }

  const baseUrl = getBaseUrl(req);
  const client = twilio(agentConfig.twilioAccountSid, agentConfig.twilioAuthToken);

  // Create call log with CRM metadata
  const [callLog] = await db.insert(callLogsTable).values({
    userId,
    contactId: null,
    campaignId: campaignId || null,
    direction: "outbound",
    phone,
    outcome: "no_answer",
    aiModel: agentConfig.aiModel || "gpt-4o-mini",
    startedAt: new Date(),
    crmContactId: crmContactId || null,
    crmMetadata: metadata || null,
  }).returning();

  // Store transfer rules in metadata for the voice handler to pick up
  if (transferRules) {
    await db.update(callLogsTable)
      .set({
        crmMetadata: {
          ...(metadata || {}),
          __transferRules: transferRules,
        },
      })
      .where(eq(callLogsTable.id, callLog.id));
  }

  try {
    const call = await client.calls.create({
      to: phone,
      from: agentConfig.phoneNumber,
      url: `${baseUrl}/api/twilio/outbound-voice?callLogId=${callLog.id}&userId=${userId}`,
      statusCallback: `${baseUrl}/api/twilio/status?callLogId=${callLog.id}`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["completed", "no-answer", "busy", "failed"],
      machineDetection: "Enable",
      asyncAmd: "true",
    });

    // Store the Twilio Call SID
    await db.update(callLogsTable)
      .set({ callSid: call.sid })
      .where(eq(callLogsTable.id, callLog.id));

    // Emit ringing event
    crmEventBus.emitCallEvent({
      type: "call.ringing",
      callId: callLog.id,
      callSid: call.sid,
      data: { phone, campaignId },
      metadata,
      timestamp: new Date().toISOString(),
    });

    res.json({
      callId: callLog.id,
      callSid: call.sid,
      status: "dialing",
      streamUrl: `wss://${req.headers.host}/ws/crm/calls/${callLog.id}`,
    });
  } catch (err: any) {
    logger.error({ err, callId: callLog.id }, "CRM call initiation failed");

    await db.update(callLogsTable)
      .set({ outcome: "no_answer", endedAt: new Date() })
      .where(eq(callLogsTable.id, callLog.id));

    res.status(500).json({
      error: "Failed to initiate call",
      detail: err.message,
      callId: callLog.id,
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
router.post("/crm/calls/:id/transfer", requireScope("calls:write"), async (req, res) => {
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
    const agentConfig = await db.query.agentConfigsTable.findFirst({
      where: eq(agentConfigsTable.userId, userId),
    });

    if (agentConfig?.twilioAccountSid && agentConfig?.twilioAuthToken) {
      const client = twilio(agentConfig.twilioAccountSid, agentConfig.twilioAuthToken);
      await client.calls(call.callSid).update({ status: "completed" });
    }

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
router.post("/crm/webhooks", async (req, res) => {
  const apiKeyId = req.crmApiKeyId!;
  const { webhookUrl } = req.body;

  if (!webhookUrl) {
    res.status(400).json({ error: "webhookUrl is required" });
    return;
  }

  // Validate URL format
  try {
    new URL(webhookUrl);
  } catch {
    res.status(400).json({ error: "Invalid webhookUrl format" });
    return;
  }

  const secret = req.crmWebhookSecret || generateWebhookSecret();

  await db.update(crmApiKeysTable)
    .set({
      webhookUrl,
      webhookSecret: secret,
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
router.post("/crm/campaigns", requireScope("campaigns:write"), async (req, res) => {
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

  // Create campaign
  const [campaign] = await db.insert(campaignsTable).values({
    userId,
    name,
    description,
    scriptId: scriptId || null,
    totalContacts: contacts.length,
    startTime: startTime || "09:00",
    endTime: endTime || "17:00",
    timezone: timezone || "Asia/Kolkata",
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
router.post("/crm/campaigns/:id/start", requireScope("campaigns:write"), async (req, res) => {
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

  await db.update(campaignsTable)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(campaignsTable.id, campaignId));

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
// CONFERENCE STATUS CALLBACKS (from Twilio)
// ═══════════════════════════════════════════════════════════════════════

// These are called by Twilio during conferences — no CRM auth needed
// (they live under /api/crm/ but are called by Twilio directly)

router.post("/crm/conference-status", async (req, res) => {
  const callId = parseInt(req.query.callId as string);
  const event = req.body.StatusCallbackEvent;

  if (callId && event) {
    logger.info({ callId, event, conferenceSid: req.body.ConferenceSid }, "Conference status");

    if (event === "participant-leave" || event === "conference-end") {
      // Decrement agent call count if the agent left
      const call = await db.query.callLogsTable.findFirst({
        where: eq(callLogsTable.id, callId),
      });

      if (call?.transferredTo) {
        const agent = await db.query.crmAgentsTable.findFirst({
          where: and(
            eq(crmAgentsTable.userId, call.userId),
            eq(crmAgentsTable.phone, call.transferredTo),
          ),
        });

        if (agent && agent.currentCalls > 0) {
          await db.update(crmAgentsTable)
            .set({ currentCalls: agent.currentCalls - 1 })
            .where(eq(crmAgentsTable.id, agent.id));
        }
      }
    }
  }

  res.status(200).send("OK");
});

router.post("/crm/agent-call-status", async (req, res) => {
  const callId = parseInt(req.query.callId as string);
  const callStatus = req.body.CallStatus;

  if (callId) {
    logger.info({ callId, agentCallStatus: callStatus }, "Agent call status");
  }

  res.status(200).send("OK");
});

// ═══════════════════════════════════════════════════════════════════════
// API KEY MANAGEMENT (admin only — requires the existing JWT auth)
// These endpoints are mounted separately under the authenticated routes
// ═══════════════════════════════════════════════════════════════════════

export const crmAdminRouter: IRouter = Router();

// POST /api/crm-admin/api-keys — Generate a new CRM API key
crmAdminRouter.post("/crm-admin/api-keys", async (req, res) => {
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
    webhookSecret,
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

// DELETE /api/crm-admin/api-keys/:id — Deactivate an API key
crmAdminRouter.delete("/crm-admin/api-keys/:id", async (req, res) => {
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

  await db.update(crmApiKeysTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(crmApiKeysTable.id, keyId));

  res.json({ success: true, message: `API key ${key.keyPrefix}... deactivated` });
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
crmAdminRouter.post("/crm-agents", async (req, res) => {
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
