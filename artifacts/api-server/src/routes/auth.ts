import { Router, type IRouter } from "express";
import { db, usersTable, tenantUsersTable, tenantsTable, tenantSessionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { generateSessionId, getSessionExpiry, signToken } from "../middleware/auth";

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
    isSuperadmin: req.isSuperadmin ?? false,
    role: req.userRole,
    tenantId: req.tenantId,
    tenantOwnerId: req.tenantOwnerId,
    tenantName: tenant?.name,
    tenantStatus: tenant?.status,
    createdAt: user.createdAt,
  });
});

router.post("/auth/logout", async (req, res) => {
  const sessionToken = req.sessionToken;
  if (sessionToken) {
    await db.update(tenantSessionsTable)
      .set({ revokedAt: new Date() })
      .where(eq(tenantSessionsTable.token, sessionToken));
  }
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
