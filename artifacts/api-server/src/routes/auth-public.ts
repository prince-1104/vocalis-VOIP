import { Router, type IRouter } from "express";
import { db, tenantUsersTable, tenantsTable, tenantSessionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { signToken, generateSessionId, getSessionExpiry } from "../middleware/auth";
import { loginRateLimit } from "../lib/rate-limit-policies";

const router: IRouter = Router();

router.post("/auth/login", loginRateLimit, async (req, res) => {
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

  const jti = generateSessionId();
  const expiresAt = getSessionExpiry();

  await db.insert(tenantSessionsTable).values({
    tenantUserId: tenantUser.id,
    tenantId: tenantUser.tenantId,
    token: jti,
    expiresAt,
  });

  const token = signToken({ tenantUserId: tenantUser.id, jti });

  res.json({
    token,
    user: {
      id: tenantOwnerId,
      email: tenantUser.email,
      name: tenantUser.name,
      role: tenantUser.role,
      tenantId: tenantUser.tenantId,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
    },
  });
});

export default router;
