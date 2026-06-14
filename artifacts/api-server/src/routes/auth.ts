import { Router, type IRouter } from "express";
import { db, usersTable, tenantUsersTable, tenantsTable, tenantSessionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { generateSessionId, getSessionExpiry, signToken } from "../middleware/auth";

const router: IRouter = Router();

router.get("/auth/me", async (req, res) => {
  const tenantOwnerId = req.tenantOwnerId!;

  const ownerUser = await db.query.usersTable.findFirst({
    where: eq(usersTable.id, tenantOwnerId),
  });

  if (!ownerUser) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const tenant = req.tenantId
    ? await db.query.tenantsTable.findFirst({
        where: eq(tenantsTable.id, req.tenantId),
      })
    : null;

  const tenantUser = await db.query.tenantUsersTable.findFirst({
    where: eq(tenantUsersTable.id, req.tenantUserId!),
  });

  res.json({
    id: req.tenantUserId,
    email: req.authenticatedEmail,
    name: req.authenticatedName,
    phone: tenantUser?.phone ?? null,
    isSuperadmin: req.isSuperadmin ?? false,
    role: req.userRole,
    tenantId: req.tenantId,
    tenantOwnerId: req.tenantOwnerId,
    tenantName: tenant?.name,
    tenantStatus: tenant?.status,
    ownerProfile: {
      id: ownerUser.id,
      email: ownerUser.email,
      name: ownerUser.name,
      businessName: ownerUser.businessName,
      plan: ownerUser.plan,
    },
  });
});

router.put("/auth/profile", async (req, res) => {
  const tenantUserId = req.tenantUserId!;
  const { name, email, phone } = req.body;

  if (!email) {
    res.status(400).json({ error: "Email is required" });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  try {
    const currentTenantUser = await db.query.tenantUsersTable.findFirst({
      where: eq(tenantUsersTable.id, tenantUserId),
    });

    if (!currentTenantUser) {
      res.status(404).json({ error: "User profile not found" });
      return;
    }

    if (normalizedEmail !== currentTenantUser.email) {
      const existing = await db.query.tenantUsersTable.findFirst({
        where: and(
          eq(tenantUsersTable.email, normalizedEmail),
          eq(tenantUsersTable.tenantId, currentTenantUser.tenantId)
        ),
      });

      if (existing) {
        res.status(409).json({ error: "A user with this email already exists in this tenant" });
        return;
      }
    }

    await db.update(tenantUsersTable)
      .set({
        name: name || null,
        email: normalizedEmail,
        phone: phone || null,
        updatedAt: new Date(),
      })
      .where(eq(tenantUsersTable.id, tenantUserId));

    if (currentTenantUser.userId) {
      await db.update(usersTable)
        .set({
          name: name || null,
          email: normalizedEmail,
          updatedAt: new Date(),
        })
        .where(eq(usersTable.id, currentTenantUser.userId));
    }

    res.json({ success: true, message: "Profile updated successfully" });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to update profile" });
  }
});

router.put("/auth/profile/password", async (req, res) => {
  const tenantUserId = req.tenantUserId!;
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: "Current password and new password are required" });
    return;
  }

  try {
    const currentTenantUser = await db.query.tenantUsersTable.findFirst({
      where: eq(tenantUsersTable.id, tenantUserId),
    });

    if (!currentTenantUser || !currentTenantUser.passwordHash) {
      res.status(404).json({ error: "User profile not found" });
      return;
    }

    const valid = await bcrypt.compare(currentPassword, currentTenantUser.passwordHash);
    if (!valid) {
      res.status(400).json({ error: "Incorrect current password" });
      return;
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 12);
    await db.update(tenantUsersTable)
      .set({
        passwordHash: newPasswordHash,
        updatedAt: new Date(),
      })
      .where(eq(tenantUsersTable.id, tenantUserId));

    res.json({ success: true, message: "Password updated successfully" });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to update password" });
  }
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
