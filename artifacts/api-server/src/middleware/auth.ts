import { Request, Response, NextFunction } from "express";
import { db, usersTable, tenantsTable, tenantUsersTable, agentConfigsTable, tenantSessionsTable } from "@workspace/db";
import { eq, and, gt } from "drizzle-orm";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const IS_DEVELOPMENT = process.env.NODE_ENV !== "production";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET environment variable is required but not set");
  }
  return secret;
}

declare global {
  namespace Express {
    interface Request {
      userId?: number;
      tenantId?: number;
      tenantOwnerId?: number;
      tenantUserId?: number;
      authenticatedEmail?: string;
      authenticatedName?: string | null;
      userRole?: "admin" | "manager" | "superadmin";
      isSuperadmin?: boolean;
      sessionToken?: string;
    }
  }
}

interface JwtPayload {
  tenantUserId: number;
  jti: string;
}

export function signToken(payload: { tenantUserId: number; jti: string }): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: "7d" });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, getJwtSecret()) as JwtPayload;
  } catch {
    return null;
  }
}

export function generateSessionId(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function getSessionExpiry(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d;
}

async function ensureTenantForUser(user: {
  id: number;
  name: string | null;
  email: string | null;
  businessName: string | null;
}) {
  const existing = await db.query.tenantUsersTable.findFirst({
    where: and(eq(tenantUsersTable.userId, user.id), eq(tenantUsersTable.role, "admin")),
  });
  if (existing) return existing;

  const slug = `tenant-${user.id}-${Date.now()}`;
  const tenantName = user.businessName || user.name || `Tenant ${user.id}`;

  const [tenant] = await db.insert(tenantsTable).values({
    name: tenantName,
    slug,
    ownerId: user.id,
  }).returning();

  const [tenantUser] = await db.insert(tenantUsersTable).values({
    tenantId: tenant.id,
    userId: user.id,
    role: "admin",
    email: user.email || `user-${user.id}@salessutra.internal`,
    name: user.name,
    isActive: true,
  }).returning();

  return tenantUser;
}

export async function resolveUser(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers["authorization"] as string | undefined;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const rawToken = authHeader.slice(7);
      const payload = verifyToken(rawToken);

      if (!payload) {
        res.status(401).json({ error: "Invalid or expired token" });
        return;
      }

      const session = await db.query.tenantSessionsTable.findFirst({
        where: and(
          eq(tenantSessionsTable.token, payload.jti),
          gt(tenantSessionsTable.expiresAt, new Date()),
        ),
      });

      if (!session || session.revokedAt !== null) {
        res.status(401).json({ error: "Session not found or has been revoked" });
        return;
      }

      const tenantUser = await db.query.tenantUsersTable.findFirst({
        where: and(
          eq(tenantUsersTable.id, payload.tenantUserId),
          eq(tenantUsersTable.isActive, true),
        ),
      });

      if (!tenantUser) {
        res.status(401).json({ error: "User account not found or disabled" });
        return;
      }

      const tenant = await db.query.tenantsTable.findFirst({
        where: eq(tenantsTable.id, tenantUser.tenantId),
      });

      if (!tenant || tenant.status === "suspended") {
        res.status(402).json({
          error: "Account suspended — outstanding invoice",
          suspended: true,
          tenantId: tenant?.id,
        });
        return;
      }

      const tenantOwnerId = tenant.ownerId;
      if (!tenantOwnerId) {
        res.status(500).json({ error: "Tenant configuration error: no owner found" });
        return;
      }

      req.userId = tenantOwnerId;
      req.tenantOwnerId = tenantOwnerId;
      req.tenantId = tenantUser.tenantId;
      req.tenantUserId = tenantUser.id;
      req.authenticatedEmail = tenantUser.email;
      req.authenticatedName = tenantUser.name;
      req.userRole = tenantUser.role as "admin" | "manager";
      req.isSuperadmin = false;
      req.sessionToken = payload.jti;
      return next();
    }

    const replitUserId = req.headers["x-replit-user-id"] as string | undefined;
    const replitUserName = req.headers["x-replit-user-name"] as string | undefined;

    if (!replitUserId) {
      if (IS_DEVELOPMENT) {
        res.status(401).json({
          error: "Not authenticated. Provide a Bearer token or Replit identity header.",
        });
      } else {
        res.status(401).json({ error: "Not authenticated" });
      }
      return;
    }

    let user = await db.query.usersTable.findFirst({
      where: eq(usersTable.replitUserId, replitUserId),
    });

    if (!user) {
      const [newUser] = await db.insert(usersTable).values({
        replitUserId,
        name: replitUserName || null,
        plan: "free",
      }).returning();
      user = newUser;

      await db.insert(agentConfigsTable).values({
        userId: newUser.id,
        agentName: "SalesBot",
        voice: "nova",
        personality: "professional",
        greeting: "Hi, this is SalesBot calling on behalf of [Business Name]. Is this a good time to speak?",
        voicemailMessage: "Hi, this is a message for [Name]. Please call us back at your earliest convenience. Thank you!",
      }).onConflictDoNothing();
    }

    const tenantUser = await ensureTenantForUser(user);

    const tenant = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, tenantUser.tenantId),
    });

    if (tenant && tenant.status === "suspended" && !user.isSuperadmin) {
      res.status(402).json({
        error: "Account suspended — outstanding invoice",
        suspended: true,
        tenantId: tenant.id,
      });
      return;
    }

    req.userId = user.id;
    req.tenantOwnerId = user.id;
    req.tenantId = tenantUser.tenantId;
    req.tenantUserId = tenantUser.id;
    req.authenticatedEmail = tenantUser.email || user.email || undefined;
    req.authenticatedName = tenantUser.name || user.name;
    req.userRole = user.isSuperadmin ? "superadmin" : "admin";
    req.isSuperadmin = user.isSuperadmin;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles: Array<"admin" | "manager" | "superadmin">) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.userRole) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (req.isSuperadmin) {
      return next();
    }
    if (!roles.includes(req.userRole)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  };
}

export function requireSuperadmin(req: Request, res: Response, next: NextFunction) {
  if (!req.isSuperadmin) {
    res.status(403).json({ error: "Superadmin access required" });
    return;
  }
  next();
}
