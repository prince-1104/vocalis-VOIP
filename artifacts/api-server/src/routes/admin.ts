import { Router, type IRouter } from "express";
import { db, tenantsTable, tenantUsersTable, callLogsTable, agentConfigsTable } from "@workspace/db";
import { eq, and, gte, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";

const router: IRouter = Router();

router.get("/admin/tenants", async (req, res) => {
  const tenants = await db.select().from(tenantsTable).orderBy(tenantsTable.createdAt);

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const results = await Promise.all(tenants.map(async (tenant) => {
    const [userCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tenantUsersTable)
      .where(eq(tenantUsersTable.tenantId, tenant.id));

    const agentConfig = await db.query.agentConfigsTable.findFirst({
      where: eq(agentConfigsTable.userId, tenant.ownerId!),
    });

    const monthCalls = await db
      .select({ count: sql<number>`count(*)`, totalCost: sql<number>`coalesce(sum(estimated_cost_usd::numeric), 0)` })
      .from(callLogsTable)
      .where(and(
        eq(callLogsTable.userId, tenant.ownerId!),
        gte(callLogsTable.startedAt, startOfMonth),
      ));

    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      commissionPct: tenant.commissionPct,
      paymentTermsDays: tenant.paymentTermsDays,
      ownerId: tenant.ownerId,
      createdAt: tenant.createdAt,
      userCount: Number(userCount?.count ?? 0),
      callsThisMonth: Number(monthCalls[0]?.count ?? 0),
      costThisMonth: Number(monthCalls[0]?.totalCost ?? 0),
      twilioConfigured: !!(agentConfig?.twilioAccountSid && agentConfig?.twilioAuthToken),
    };
  }));

  res.json(results);
});

router.post("/admin/tenants", async (req, res) => {
  const { name, slug, commissionPct, paymentTermsDays } = req.body;
  if (!name || !slug) {
    res.status(400).json({ error: "name and slug are required" });
    return;
  }

  const existing = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.slug, slug),
  });
  if (existing) {
    res.status(409).json({ error: "Slug already taken" });
    return;
  }

  const [tenant] = await db.insert(tenantsTable).values({
    name,
    slug,
    commissionPct: commissionPct ?? "0",
    paymentTermsDays: paymentTermsDays ?? 30,
    ownerId: req.userId!,
  }).returning();

  res.json(tenant);
});

router.get("/admin/tenants/:id", async (req, res) => {
  const tenantId = parseInt(req.params.id);

  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, tenantId),
  });

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

  const agentConfig = await db.query.agentConfigsTable.findFirst({
    where: eq(agentConfigsTable.userId, tenant.ownerId!),
  });

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const monthStats = await db
    .select({ count: sql<number>`count(*)`, totalCost: sql<number>`coalesce(sum(estimated_cost_usd::numeric), 0)` })
    .from(callLogsTable)
    .where(and(
      eq(callLogsTable.userId, tenant.ownerId!),
      gte(callLogsTable.startedAt, startOfMonth),
    ));

  res.json({
    ...tenant,
    users,
    telephony: {
      phoneNumber: agentConfig?.phoneNumber ?? null,
      twilioAccountSid: agentConfig?.twilioAccountSid ?? null,
      twilioAuthToken: agentConfig?.twilioAuthToken ? "***configured***" : null,
      twilioConfigured: !!(agentConfig?.twilioAccountSid && agentConfig?.twilioAuthToken),
    },
    stats: {
      callsThisMonth: Number(monthStats[0]?.count ?? 0),
      costThisMonth: Number(monthStats[0]?.totalCost ?? 0),
      userCount: users.length,
    },
  });
});

router.patch("/admin/tenants/:id", async (req, res) => {
  const tenantId = parseInt(req.params.id);
  const { name, status, commissionPct, paymentTermsDays } = req.body;

  const updateData: any = { updatedAt: new Date() };
  if (name !== undefined) updateData.name = name;
  if (status !== undefined) {
    if (!["active", "suspended"].includes(status)) {
      res.status(400).json({ error: "status must be active or suspended" });
      return;
    }
    updateData.status = status;
    if (status === "suspended") updateData.suspendedAt = new Date();
    if (status === "active") updateData.suspendedAt = null;
  }
  if (commissionPct !== undefined) updateData.commissionPct = String(commissionPct);
  if (paymentTermsDays !== undefined) updateData.paymentTermsDays = Number(paymentTermsDays);

  const [updated] = await db.update(tenantsTable)
    .set(updateData)
    .where(eq(tenantsTable.id, tenantId))
    .returning();

  if (!updated) { res.status(404).json({ error: "Tenant not found" }); return; }
  res.json(updated);
});

router.get("/admin/tenants/:id/users", async (req, res) => {
  const tenantId = parseInt(req.params.id);
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

router.post("/admin/tenants/:id/users", async (req, res) => {
  const tenantId = parseInt(req.params.id);
  const { email, name, role, password } = req.body;

  if (!email || !password || !role) {
    res.status(400).json({ error: "email, password, and role are required" });
    return;
  }
  if (!["admin", "manager"].includes(role)) {
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

router.patch("/admin/tenants/:id/users/:uid", async (req, res) => {
  const tenantId = parseInt(req.params.id);
  const userId = parseInt(req.params.uid);
  const { isActive, role, name } = req.body;

  const updateData: any = { updatedAt: new Date() };
  if (isActive !== undefined) updateData.isActive = Boolean(isActive);
  if (role !== undefined && ["admin", "manager"].includes(role)) updateData.role = role;
  if (name !== undefined) updateData.name = name;

  const [updated] = await db.update(tenantUsersTable)
    .set(updateData)
    .where(and(eq(tenantUsersTable.id, userId), eq(tenantUsersTable.tenantId, tenantId)))
    .returning();

  if (!updated) { res.status(404).json({ error: "User not found" }); return; }
  res.json({ id: updated.id, email: updated.email, name: updated.name, role: updated.role, isActive: updated.isActive });
});

router.put("/admin/tenants/:id/telephony", async (req, res) => {
  const tenantId = parseInt(req.params.id);
  const { twilioAccountSid, twilioAuthToken, phoneNumber } = req.body;

  const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
  if (!tenant || !tenant.ownerId) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const updateData: any = { updatedAt: new Date() };
  if (phoneNumber !== undefined) updateData.phoneNumber = phoneNumber;
  if (twilioAccountSid !== undefined) updateData.twilioAccountSid = twilioAccountSid;
  if (twilioAuthToken !== undefined && twilioAuthToken !== "***configured***") {
    updateData.twilioAuthToken = twilioAuthToken;
  }

  await db.update(agentConfigsTable)
    .set(updateData)
    .where(eq(agentConfigsTable.userId, tenant.ownerId));

  res.json({ success: true });
});

export default router;
