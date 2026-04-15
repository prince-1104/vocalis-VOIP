import { Request, Response, NextFunction } from "express";
import { db, usersTable, tenantsTable, tenantUsersTable, agentConfigsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import jwt from "jsonwebtoken";

const DEMO_USER_ID = "demo-user";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";

declare global {
  namespace Express {
    interface Request {
      userId?: number;
      tenantId?: number;
      userRole?: "admin" | "manager" | "superadmin";
      isSuperadmin?: boolean;
    }
  }
}

interface JwtPayload {
  tenantUserId: number;
  tenantId: number;
  userId: number;
  role: "admin" | "manager";
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

async function ensureTenantForUser(user: { id: number; name: string | null; email: string | null; businessName: string | null }) {
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

const TWILIO_WEBHOOK_PATHS = ["/api/twilio/inbound", "/api/twilio/voice", "/api/twilio/outbound-voice", "/api/twilio/status"];

function isTwilioWebhook(req: Request): boolean {
  return TWILIO_WEBHOOK_PATHS.some(p => req.path.startsWith(p.replace("/api", "")));
}

export async function resolveUser(req: Request, res: Response, next: NextFunction) {
  try {
    const skipSuspensionCheck = isTwilioWebhook(req);
    const authHeader = req.headers["authorization"] as string | undefined;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const payload = verifyToken(token);

      if (!payload) {
        res.status(401).json({ error: "Invalid or expired token" });
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

      if (!skipSuspensionCheck && (!tenant || tenant.status === "suspended")) {
        res.status(402).json({
          error: "Account suspended — outstanding invoice",
          suspended: true,
          tenantId: tenant?.id,
        });
        return;
      }

      let resolvedUserId = tenantUser.userId;
      if (!resolvedUserId) {
        const [linkedUser] = await db.insert(usersTable).values({
          name: tenantUser.name || tenantUser.email,
          email: tenantUser.email,
          plan: "free",
        }).returning();
        resolvedUserId = linkedUser.id;
        await db.update(tenantUsersTable)
          .set({ userId: linkedUser.id })
          .where(eq(tenantUsersTable.id, tenantUser.id));

        await db.insert(agentConfigsTable).values({
          userId: linkedUser.id,
          agentName: "SalesBot",
          voice: "nova",
          personality: "professional",
          greeting: "Hi, this is SalesBot calling on behalf of [Business Name]. Is this a good time to speak?",
          voicemailMessage: "Hi, this is a message for [Name]. Please call us back at your earliest convenience. Thank you!",
        }).onConflictDoNothing();
      }

      req.userId = resolvedUserId;
      req.tenantId = tenantUser.tenantId;
      req.userRole = tenantUser.role as "admin" | "manager";
      req.isSuperadmin = false;
      return next();
    }

    const replitUserId = (req.headers["x-replit-user-id"] as string) || DEMO_USER_ID;
    const replitUserName = (req.headers["x-replit-user-name"] as string) || "Demo User";

    let user = await db.query.usersTable.findFirst({
      where: eq(usersTable.replitUserId, replitUserId),
    });

    if (!user) {
      const [newUser] = await db.insert(usersTable).values({
        replitUserId,
        name: replitUserName,
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

    if (!skipSuspensionCheck && tenant && tenant.status === "suspended" && !user.isSuperadmin) {
      res.status(402).json({
        error: "Account suspended — outstanding invoice",
        suspended: true,
        tenantId: tenant.id,
      });
      return;
    }

    req.userId = user.id;
    req.tenantId = tenantUser.tenantId;
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
