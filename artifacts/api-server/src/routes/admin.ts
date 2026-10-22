import { Router, type IRouter } from "express";
import { db, tenantsTable, tenantUsersTable, callLogsTable, agentConfigsTable, usersTable, platformSettingsTable, sipTrunkConfigsTable, exotelConfigsTable } from "@workspace/db";
import { getTenantMonthCost } from "../lib/cost-logger";
import { eq, and, gte, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { sealCredential } from "../lib/credential-crypto";
import { adminMutationRateLimit } from "../lib/rate-limit-policies";

const router: IRouter = Router();
router.use("/superadmin", adminMutationRateLimit);

function getMonthStart(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

async function getTenantMonthStats(ownerId: number, tenantId?: number) {
  const monthStart = getMonthStart();

  // Call count from call_logs (owner's calls)
  const callRows = await db
    .select({
      count: sql<string>`count(*)`,
    })
    .from(callLogsTable)
    .where(and(eq(callLogsTable.userId, ownerId), gte(callLogsTable.startedAt, monthStart)));

  // Ledger-backed committed usage for the UTC billing month if tenantId is available
  let costThisMonth = 0;
  if (tenantId) {
    costThisMonth = await getTenantMonthCost(tenantId);
  } else {
    // Fallback: use call_logs estimated cost if tenantId not available
    const costRows = await db
      .select({
        totalCost: sql<string>`coalesce(sum(estimated_cost_usd::numeric), 0)`,
      })
      .from(callLogsTable)
      .where(and(eq(callLogsTable.userId, ownerId), gte(callLogsTable.startedAt, monthStart)));
    costThisMonth = parseFloat(costRows[0]?.totalCost ?? "0");
  }

  return {
    callsThisMonth: parseInt(callRows[0]?.count ?? "0", 10),
    costThisMonth,
  };
}

router.get("/superadmin/tenants", async (req, res) => {
  const tenants = await db.select().from(tenantsTable).orderBy(tenantsTable.createdAt);

  const results = await Promise.all(tenants.map(async (tenant) => {
    const [userCount] = await db
      .select({ count: sql<string>`count(*)` })
      .from(tenantUsersTable)
      .where(eq(tenantUsersTable.tenantId, tenant.id));

    const agentConfig = tenant.ownerId
      ? await db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, tenant.ownerId) })
      : null;

    const monthStats = tenant.ownerId ? await getTenantMonthStats(tenant.ownerId, tenant.id) : { callsThisMonth: 0, costThisMonth: 0 };

    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      commissionPct: tenant.commissionPct,
      paymentTermsDays: tenant.paymentTermsDays,
      ownerId: tenant.ownerId,
      createdAt: tenant.createdAt,
      userCount: parseInt(userCount?.count ?? "0", 10),
      callsThisMonth: monthStats.callsThisMonth,
      costThisMonth: monthStats.costThisMonth,
      twilioConfigured: !!(agentConfig?.twilioAccountSid && agentConfig?.twilioAuthToken),
      telephonyType: tenant.telephonyType,
    };
  }));

  res.json(results);
});

router.post("/superadmin/tenants", async (req, res) => {
  const { name, slug, commissionPct, paymentTermsDays } = req.body as {
    name?: string; slug?: string; commissionPct?: string; paymentTermsDays?: number;
  };
  if (!name || !slug) {
    res.status(400).json({ error: "name and slug are required" });
    return;
  }

  const existing = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.slug, slug) });
  if (existing) {
    res.status(409).json({ error: "Slug already taken" });
    return;
  }

  // Create an isolated system user as the data owner for this tenant.
  // This provides full data isolation: contacts, calls, and configs are
  // scoped to this user's id — independent of the superadmin's account.
  const [ownerUser] = await db.insert(usersTable).values({
    name,
    plan: "free",
  }).returning();

  // Seed default agent config for the new tenant owner
  await db.insert(agentConfigsTable).values({
    userId: ownerUser.id,
    agentName: "SalesBot",
    voice: "nova",
    personality: "professional",
    greeting: "Hi, this is SalesBot calling. Is this a good time to speak?",
    voicemailMessage: "Hi, please call us back at your earliest convenience. Thank you!",
  }).onConflictDoNothing();

  const [tenant] = await db.insert(tenantsTable).values({
    name,
    slug,
    commissionPct: commissionPct ?? "0",
    paymentTermsDays: paymentTermsDays ?? 30,
    ownerId: ownerUser.id,
  }).returning();

  res.json(tenant);
});

router.get("/superadmin/tenants/:id", async (req, res) => {
  const tenantId = parseInt(req.params.id, 10);

  const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const users = await db.select({
    id: tenantUsersTable.id,
    email: tenantUsersTable.email,
    name: tenantUsersTable.name,
    role: tenantUsersTable.role,
    isActive: tenantUsersTable.isActive,
    createdAt: tenantUsersTable.createdAt,
  }).from(tenantUsersTable).where(eq(tenantUsersTable.tenantId, tenantId));

  const agentConfig = tenant.ownerId
    ? await db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, tenant.ownerId) })
    : null;

  const monthStats = tenant.ownerId ? await getTenantMonthStats(tenant.ownerId, tenantId) : { callsThisMonth: 0, costThisMonth: 0 };

  const sipTrunkConfig = await db.query.sipTrunkConfigsTable.findFirst({
    where: eq(sipTrunkConfigsTable.tenantId, tenantId),
  });

  const exotelConfig = await db.query.exotelConfigsTable.findFirst({
    where: eq(exotelConfigsTable.tenantId, tenantId),
  });

  res.json({
    ...tenant,
    users,
    telephony: {
      phoneNumber: agentConfig?.phoneNumber ?? null,
      twilioAccountSid: agentConfig?.twilioAccountSid ?? null,
      twilioAuthToken: agentConfig?.twilioAuthToken ? "***configured***" : null,
      twilioConfigured: !!(agentConfig?.twilioAccountSid && agentConfig?.twilioAuthToken),
    },
    sipTrunkConfig: sipTrunkConfig ? {
      sipDomain: sipTrunkConfig.sipDomain,
      sipUsername: sipTrunkConfig.sipUsername,
      phoneNumber: sipTrunkConfig.phoneNumber,
      outboundProxy: sipTrunkConfig.outboundProxy,
      transport: sipTrunkConfig.transport,
      terminationUri: sipTrunkConfig.terminationUri,
      isEnabled: sipTrunkConfig.isEnabled,
    } : null,
    exotelConfig: exotelConfig ? {
      accountSid: exotelConfig.accountSid,
      exophone: exotelConfig.exophone,
      region: exotelConfig.region,
      appFlowUrl: exotelConfig.appFlowUrl,
      apiKeyConfigured: !!exotelConfig.apiKey,
      apiTokenConfigured: !!exotelConfig.apiToken,
      isEnabled: exotelConfig.isEnabled,
    } : null,
    stats: {
      callsThisMonth: monthStats.callsThisMonth,
      costThisMonth: monthStats.costThisMonth,
      userCount: users.length,
    },
  });
});

router.get("/superadmin/tenants/:id/stats", async (req, res) => {
  const tenantId = parseInt(req.params.id, 10);

  const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
  if (!tenant || !tenant.ownerId) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const monthStats = await getTenantMonthStats(tenant.ownerId, tenantId);
  const [userCount] = await db
    .select({ count: sql<string>`count(*)` })
    .from(tenantUsersTable)
    .where(eq(tenantUsersTable.tenantId, tenantId));

  res.json({
    callsThisMonth: monthStats.callsThisMonth,
    costThisMonth: monthStats.costThisMonth,
    userCount: parseInt(userCount?.count ?? "0", 10),
  });
});

router.patch("/superadmin/tenants/:id", async (req, res) => {
  const tenantId = parseInt(req.params.id, 10);
  const { name, status, commissionPct, paymentTermsDays } = req.body as {
    name?: string; status?: string; commissionPct?: string; paymentTermsDays?: number;
  };

  type TenantUpdate = {
    updatedAt: Date;
    name?: string;
    status?: string;
    commissionPct?: string;
    paymentTermsDays?: number;
    suspendedAt?: Date | null;
  };

  const updateData: TenantUpdate = { updatedAt: new Date() };
  if (name !== undefined) updateData.name = name;
  if (status !== undefined) {
    if (status !== "active" && status !== "suspended") {
      res.status(400).json({ error: "status must be active or suspended" });
      return;
    }
    updateData.status = status;
    if (status === "suspended") updateData.suspendedAt = new Date();
    if (status === "active") updateData.suspendedAt = null;
  }
  if (commissionPct !== undefined) updateData.commissionPct = String(commissionPct);
  if (paymentTermsDays !== undefined) updateData.paymentTermsDays = Number(paymentTermsDays);

  const [updated] = await db.update(tenantsTable).set(updateData).where(eq(tenantsTable.id, tenantId)).returning();
  if (!updated) { res.status(404).json({ error: "Tenant not found" }); return; }
  res.json(updated);
});

router.get("/superadmin/tenants/:id/users", async (req, res) => {
  const tenantId = parseInt(req.params.id, 10);
  const users = await db.select({
    id: tenantUsersTable.id,
    email: tenantUsersTable.email,
    name: tenantUsersTable.name,
    role: tenantUsersTable.role,
    isActive: tenantUsersTable.isActive,
    createdAt: tenantUsersTable.createdAt,
  }).from(tenantUsersTable).where(eq(tenantUsersTable.tenantId, tenantId));
  res.json(users);
});

router.post("/superadmin/tenants/:id/users", async (req, res) => {
  const tenantId = parseInt(req.params.id, 10);
  const { email, name, role, password } = req.body as {
    email?: string; name?: string; role?: string; password?: string;
  };

  if (!email || !password || !role) {
    res.status(400).json({ error: "email, password, and role are required" });
    return;
  }
  if (role !== "admin" && role !== "manager") {
    res.status(400).json({ error: "role must be admin or manager" });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await db.query.tenantUsersTable.findFirst({
    where: and(eq(tenantUsersTable.email, normalizedEmail), eq(tenantUsersTable.tenantId, tenantId)),
  });
  if (existing) {
    res.status(409).json({ error: "User with this email already exists in this tenant" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const [user] = await db.insert(tenantUsersTable).values({
    tenantId,
    role,
    email: normalizedEmail,
    name: name || null,
    passwordHash,
    isActive: true,
  }).returning();

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
  });
});

router.patch("/superadmin/tenants/:id/users/:uid", async (req, res) => {
  const tenantId = parseInt(req.params.id, 10);
  const userId = parseInt(req.params.uid, 10);
  const { isActive, role, name } = req.body as { isActive?: boolean; role?: string; name?: string };

  type UserUpdate = { updatedAt: Date; isActive?: boolean; role?: string; name?: string };
  const updateData: UserUpdate = { updatedAt: new Date() };
  if (isActive !== undefined) updateData.isActive = Boolean(isActive);
  if (role !== undefined && (role === "admin" || role === "manager")) updateData.role = role;
  if (name !== undefined) updateData.name = name;

  const [updated] = await db.update(tenantUsersTable)
    .set(updateData)
    .where(and(eq(tenantUsersTable.id, userId), eq(tenantUsersTable.tenantId, tenantId)))
    .returning();

  if (!updated) { res.status(404).json({ error: "User not found" }); return; }
  res.json({ id: updated.id, email: updated.email, name: updated.name, role: updated.role, isActive: updated.isActive });
});

router.put("/superadmin/tenants/:id/telephony", async (req, res) => {
  const tenantId = parseInt(req.params.id, 10);
  const { twilioAccountSid, twilioAuthToken, phoneNumber } = req.body as {
    twilioAccountSid?: string; twilioAuthToken?: string; phoneNumber?: string;
  };

  const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
  if (!tenant || !tenant.ownerId) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  type TelephonyUpdate = { updatedAt: Date; phoneNumber?: string; twilioAccountSid?: string; twilioAuthToken?: string | null };
  const updateData: TelephonyUpdate = { updatedAt: new Date() };
  if (phoneNumber !== undefined) updateData.phoneNumber = phoneNumber;
  if (twilioAccountSid !== undefined) updateData.twilioAccountSid = twilioAccountSid;
  if (twilioAuthToken !== undefined && twilioAuthToken !== "***configured***") {
    updateData.twilioAuthToken = twilioAuthToken
      ? sealCredential("twilioAuthToken", tenant.ownerId, twilioAuthToken)
      : null;
  }

  await db.update(agentConfigsTable).set(updateData).where(eq(agentConfigsTable.userId, tenant.ownerId));

  await db.update(tenantsTable)
    .set({ telephonyType: "TWILIO", updatedAt: new Date() })
    .where(eq(tenantsTable.id, tenantId));

  res.json({ success: true });
});

// ── SIP Trunk Configuration (Superadmin Only) ──
router.post("/superadmin/tenants/:id/telephony/sip-trunk", async (req, res) => {
  const tenantId = parseInt(req.params.id, 10);
  const { sipDomain, sipUsername, sipPassword, phoneNumber, outboundProxy, transport } = req.body as {
    sipDomain?: string; sipUsername?: string; sipPassword?: string; phoneNumber?: string; outboundProxy?: string; transport?: string;
  };

  if (!sipDomain || !sipUsername || !phoneNumber) {
    res.status(400).json({ error: "sipDomain, sipUsername, and phoneNumber are required" });
    return;
  }

  const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const existingConfig = await db.query.sipTrunkConfigsTable.findFirst({
    where: eq(sipTrunkConfigsTable.tenantId, tenantId),
  });

  let encryptedPassword = "";
  if (sipPassword) {
    encryptedPassword = sealCredential("sipPassword", tenantId, sipPassword);
  } else if (existingConfig) {
    encryptedPassword = existingConfig.sipPassword;
  } else {
    res.status(400).json({ error: "sipPassword is required for new configurations" });
    return;
  }

  const terminationUri = `sip:${sipUsername}@${sipDomain}`;
  const resolvedTransport = transport || "UDP";

  if (existingConfig) {
    await db.update(sipTrunkConfigsTable)
      .set({
        sipDomain,
        sipUsername,
        sipPassword: encryptedPassword,
        phoneNumber,
        outboundProxy: outboundProxy || null,
        transport: resolvedTransport,
        terminationUri,
        updatedAt: new Date(),
      })
      .where(eq(sipTrunkConfigsTable.tenantId, tenantId));
  } else {
    await db.insert(sipTrunkConfigsTable).values({
      tenantId,
      sipDomain,
      sipUsername,
      sipPassword: encryptedPassword,
      phoneNumber,
      outboundProxy: outboundProxy || null,
      transport: resolvedTransport,
      terminationUri,
      isEnabled: false,
    });
  }

  res.json({ success: true });
});

router.get("/superadmin/tenants/:id/telephony/sip-trunk", async (req, res) => {
  const tenantId = parseInt(req.params.id, 10);
  const config = await db.query.sipTrunkConfigsTable.findFirst({
    where: eq(sipTrunkConfigsTable.tenantId, tenantId),
  });

  if (!config) {
    res.status(404).json({ error: "SIP Trunk configuration not found" });
    return;
  }

  res.json({
    id: config.id,
    tenantId: config.tenantId,
    sipDomain: config.sipDomain,
    sipUsername: config.sipUsername,
    sipPassword: config.sipPassword ? "***configured***" : null,
    phoneNumber: config.phoneNumber,
    outboundProxy: config.outboundProxy,
    transport: config.transport,
    terminationUri: config.terminationUri,
    isEnabled: config.isEnabled,
  });
});

router.patch("/superadmin/tenants/:id/telephony/sip-trunk/toggle", async (req, res) => {
  const tenantId = parseInt(req.params.id, 10);
  const { isEnabled } = req.body as { isEnabled: boolean };

  if (isEnabled === undefined) {
    res.status(400).json({ error: "isEnabled is required" });
    return;
  }

  const config = await db.query.sipTrunkConfigsTable.findFirst({
    where: eq(sipTrunkConfigsTable.tenantId, tenantId),
  });

  if (isEnabled && !config) {
    res.status(400).json({ error: "Cannot enable SIP Trunk: configuration is missing" });
    return;
  }

  await db.transaction(async (tx) => {
    if (config) {
      await tx.update(sipTrunkConfigsTable)
        .set({ isEnabled, updatedAt: new Date() })
        .where(eq(sipTrunkConfigsTable.tenantId, tenantId));
    }
    await tx.update(tenantsTable)
      .set({ telephonyType: isEnabled ? "SIP_TRUNK" : "TWILIO", updatedAt: new Date() })
      .where(eq(tenantsTable.id, tenantId));
  });

  res.json({ success: true, telephonyType: isEnabled ? "SIP_TRUNK" : "TWILIO" });
});

router.delete("/superadmin/tenants/:id/telephony/sip-trunk", async (req, res) => {
  const tenantId = parseInt(req.params.id, 10);

  await db.transaction(async (tx) => {
    await tx.delete(sipTrunkConfigsTable).where(eq(sipTrunkConfigsTable.tenantId, tenantId));
    await tx.update(tenantsTable)
      .set({ telephonyType: "TWILIO", updatedAt: new Date() })
      .where(eq(tenantsTable.id, tenantId));
  });

  res.json({ success: true });
});

// ── Exotel Configuration (Superadmin Only) ──
router.post("/superadmin/tenants/:id/telephony/exotel", async (req, res) => {
  const tenantId = parseInt(req.params.id, 10);
  const {
    accountSid,
    apiKey,
    apiToken,
    exophone,
    region = "singapore",
    appFlowUrl,
  } = req.body as {
    accountSid?: string;
    apiKey?: string;
    apiToken?: string;
    exophone?: string;
    region?: string;
    appFlowUrl?: string;
  };

  if (!accountSid || !exophone || !appFlowUrl) {
    res.status(400).json({ error: "accountSid, exophone, and appFlowUrl are required" });
    return;
  }

  const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const existing = await db.query.exotelConfigsTable.findFirst({
    where: eq(exotelConfigsTable.tenantId, tenantId),
  });

  let encryptedKey = existing?.apiKey || "";
  let encryptedToken = existing?.apiToken || "";

  if (apiKey) encryptedKey = sealCredential("exotelApiKey", tenantId, apiKey);
  else if (!existing) {
    res.status(400).json({ error: "apiKey is required for new Exotel configuration" });
    return;
  }

  if (apiToken) encryptedToken = sealCredential("exotelApiToken", tenantId, apiToken);
  else if (!existing) {
    res.status(400).json({ error: "apiToken is required for new Exotel configuration" });
    return;
  }

  const resolvedRegion = region === "mumbai" ? "mumbai" : "singapore";

  if (existing) {
    await db.update(exotelConfigsTable)
      .set({
        accountSid,
        apiKey: encryptedKey,
        apiToken: encryptedToken,
        exophone,
        region: resolvedRegion,
        appFlowUrl,
        updatedAt: new Date(),
      })
      .where(eq(exotelConfigsTable.tenantId, tenantId));
  } else {
    await db.insert(exotelConfigsTable).values({
      tenantId,
      accountSid,
      apiKey: encryptedKey,
      apiToken: encryptedToken,
      exophone,
      region: resolvedRegion,
      appFlowUrl,
      isEnabled: false,
    });
  }

  if (tenant.ownerId) {
    await db.update(agentConfigsTable)
      .set({
        telephonyProvider: "exotel",
        phoneNumber: exophone,
        twilioAccountSid: accountSid,
        updatedAt: new Date(),
      })
      .where(eq(agentConfigsTable.userId, tenant.ownerId));
  }

  res.json({ success: true });
});

router.patch("/superadmin/tenants/:id/telephony/exotel/toggle", async (req, res) => {
  const tenantId = parseInt(req.params.id, 10);
  const { isEnabled } = req.body as { isEnabled?: boolean };

  const config = await db.query.exotelConfigsTable.findFirst({
    where: eq(exotelConfigsTable.tenantId, tenantId),
  });
  if (!config) {
    res.status(404).json({ error: "Exotel configuration not found" });
    return;
  }

  await db.transaction(async (tx) => {
    await tx.update(exotelConfigsTable)
      .set({ isEnabled: !!isEnabled, updatedAt: new Date() })
      .where(eq(exotelConfigsTable.tenantId, tenantId));

    if (isEnabled) {
      await tx.update(sipTrunkConfigsTable)
        .set({ isEnabled: false, updatedAt: new Date() })
        .where(eq(sipTrunkConfigsTable.tenantId, tenantId));
      await tx.update(tenantsTable)
        .set({ telephonyType: "EXOTEL", updatedAt: new Date() })
        .where(eq(tenantsTable.id, tenantId));
    } else {
      await tx.update(tenantsTable)
        .set({ telephonyType: "TWILIO", updatedAt: new Date() })
        .where(eq(tenantsTable.id, tenantId));
    }
  });

  res.json({ success: true, telephonyType: isEnabled ? "EXOTEL" : "TWILIO" });
});

router.delete("/superadmin/tenants/:id/telephony/exotel", async (req, res) => {
  const tenantId = parseInt(req.params.id, 10);

  await db.transaction(async (tx) => {
    await tx.delete(exotelConfigsTable).where(eq(exotelConfigsTable.tenantId, tenantId));
    await tx.update(tenantsTable)
      .set({ telephonyType: "TWILIO", updatedAt: new Date() })
      .where(eq(tenantsTable.id, tenantId));
  });

  res.json({ success: true });
});

// Platform-wide settings (global defaults for commission, payment terms, etc.)
router.get("/superadmin/settings", async (_req, res) => {
  const rows = await db.select().from(platformSettingsTable);
  const settings: Record<string, string> = {};
  for (const row of rows) settings[row.key] = row.value;
  res.json(settings);
});

router.patch("/superadmin/settings", async (req, res) => {
  const updates = req.body as Record<string, string>;
  const ALLOWED_KEYS = new Set(["defaultCommissionPct", "defaultPaymentTermsDays", "platformName"]);

  for (const [key, value] of Object.entries(updates)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    await db.insert(platformSettingsTable)
      .values({ key, value: String(value) })
      .onConflictDoUpdate({
        target: platformSettingsTable.key,
        set: { value: String(value), updatedAt: new Date() },
      });
  }

  const rows = await db.select().from(platformSettingsTable);
  const settings: Record<string, string> = {};
  for (const row of rows) settings[row.key] = row.value;
  res.json(settings);
});

export default router;
