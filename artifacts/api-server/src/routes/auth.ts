import { Router, type IRouter } from "express";
import { db, usersTable, tenantUsersTable, tenantsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { signToken } from "../middleware/auth";

const router: IRouter = Router();

router.get("/auth/me", async (req, res) => {
  const userId = req.userId!;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.id, userId),
  });

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const tenant = req.tenantId
    ? await db.query.tenantsTable.findFirst({
        where: eq(tenantsTable.id, req.tenantId),
      })
    : null;

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    businessName: user.businessName,
    plan: user.plan,
    isSuperadmin: user.isSuperadmin,
    role: req.userRole,
    tenantId: req.tenantId,
    tenantOwnerId: req.tenantOwnerId,
    tenantName: tenant?.name,
    tenantStatus: tenant?.status,
    createdAt: user.createdAt,
  });
});

router.post("/auth/login", async (req, res) => {
  const { email, password, tenantSlug } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  let tenantUser;

  if (tenantSlug) {
    const tenant = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.slug, tenantSlug),
    });
    if (!tenant) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    tenantUser = await db.query.tenantUsersTable.findFirst({
      where: and(
        eq(tenantUsersTable.email, normalizedEmail),
        eq(tenantUsersTable.tenantId, tenant.id),
        eq(tenantUsersTable.isActive, true),
      ),
    });
  } else {
    tenantUser = await db.query.tenantUsersTable.findFirst({
      where: and(
        eq(tenantUsersTable.email, normalizedEmail),
        eq(tenantUsersTable.isActive, true),
      ),
    });
  }

  if (!tenantUser || !tenantUser.passwordHash) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const valid = await bcrypt.compare(password, tenantUser.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, tenantUser.tenantId),
  });

  if (!tenant) {
    res.status(500).json({ error: "Tenant not found" });
    return;
  }

  if (tenant.status === "suspended") {
    res.status(402).json({
      error: "Account suspended — outstanding invoice",
      suspended: true,
    });
    return;
  }

  const tenantOwnerId = tenant.ownerId;
  if (!tenantOwnerId) {
    res.status(500).json({ error: "Tenant owner not configured" });
    return;
  }

  const tenantOwner = await db.query.usersTable.findFirst({
    where: eq(usersTable.id, tenantOwnerId),
  });

  if (!tenantOwner) {
    res.status(500).json({ error: "Tenant owner account not found" });
    return;
  }

  const token = signToken({ tenantUserId: tenantUser.id });

  res.json({
    token,
    user: {
      id: tenantOwnerId,
      email: tenantUser.email,
      name: tenantUser.name || tenantOwner.name,
      role: tenantUser.role,
      tenantId: tenantUser.tenantId,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
    },
  });
});

router.post("/auth/logout", (_req, res) => {
  res.json({ success: true });
});

router.post("/auth/create-sub-user", async (req, res) => {
  if (!req.isSuperadmin && req.userRole !== "admin") {
    res.status(403).json({ error: "Admin or superadmin access required" });
    return;
  }

  const { email, name, role, password, tenantId } = req.body;

  if (!email || !password || !role) {
    res.status(400).json({ error: "email, password, and role are required" });
    return;
  }

  if (!["admin", "manager"].includes(role)) {
    res.status(400).json({ error: "Role must be admin or manager" });
    return;
  }

  const targetTenantId: number = req.isSuperadmin && tenantId ? tenantId : req.tenantId!;

  const normalizedEmail = email.toLowerCase().trim();

  const existing = await db.query.tenantUsersTable.findFirst({
    where: and(
      eq(tenantUsersTable.email, normalizedEmail),
      eq(tenantUsersTable.tenantId, targetTenantId),
    ),
  });

  if (existing) {
    res.status(409).json({ error: "A user with this email already exists in this tenant" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const [newTenantUser] = await db.insert(tenantUsersTable).values({
    tenantId: targetTenantId,
    role,
    email: normalizedEmail,
    name: name || null,
    passwordHash,
    isActive: true,
  }).returning();

  res.json({
    id: newTenantUser.id,
    email: newTenantUser.email,
    name: newTenantUser.name,
    role: newTenantUser.role,
    tenantId: newTenantUser.tenantId,
    isActive: newTenantUser.isActive,
    createdAt: newTenantUser.createdAt,
  });
});

export default router;
