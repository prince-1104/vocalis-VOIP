import { Request, Response, NextFunction } from "express";
import { db, usersTable, tenantsTable, tenantUsersTable, tenantSessionsTable, invoicesTable } from "@workspace/db";
import { eq, and, gt } from "drizzle-orm";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { invoiceAmountDue } from "../lib/billing/invoicing";

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
    const payload = jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] });
    if (typeof payload !== "object" || !Number.isSafeInteger(payload.tenantUserId) || payload.tenantUserId <= 0
      || typeof payload.jti !== "string" || !/^[a-f0-9]{64}$/.test(payload.jti)
      || typeof payload.exp !== "number") return null;
    return payload as JwtPayload;
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
          eq(tenantSessionsTable.tenantUserId, payload.tenantUserId),
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

      if (!tenantUser || session.tenantUserId !== tenantUser.id || session.tenantId !== tenantUser.tenantId
        || !["admin", "manager"].includes(tenantUser.role)) {
        res.status(401).json({ error: "User account not found or disabled" });
        return;
      }

      const tenant = await db.query.tenantsTable.findFirst({
        where: eq(tenantsTable.id, tenantUser.tenantId),
      });

      if (!tenant || tenant.status === "suspended") {
        const overdueInvoice = tenant
          ? await db.query.invoicesTable.findFirst({
              where: and(eq(invoicesTable.tenantId, tenant.id), eq(invoicesTable.status, "overdue")),
            })
          : null;
        const amountDue = overdueInvoice
          ? await invoiceAmountDue(overdueInvoice).then((due) => due.toFixed(6), () => overdueInvoice.totalBilledCostUsd)
          : null;
        res.status(402).json({
          error: "Account suspended — outstanding invoice",
          suspended: true,
          tenantId: tenant?.id,
          invoiceId: overdueInvoice?.id ?? null,
          amountDue,
        });
        return;
      }

      const tenantOwnerId = tenant.ownerId;
      if (!tenantOwnerId) {
        res.status(500).json({ error: "Tenant configuration error: no owner found" });
        return;
      }

      const principal = tenantUser.userId === null ? null : await db.query.usersTable.findFirst({
        where: eq(usersTable.id, tenantUser.userId),
      });
      const isSuperadmin = principal?.isSuperadmin === true;

      req.userId = tenantOwnerId;
      req.tenantOwnerId = tenantOwnerId;
      req.tenantId = tenantUser.tenantId;
      req.tenantUserId = tenantUser.id;
      req.authenticatedEmail = tenantUser.email;
      req.authenticatedName = tenantUser.name;
      req.userRole = isSuperadmin ? "superadmin" : (tenantUser.role as "admin" | "manager");
      req.isSuperadmin = isSuperadmin;
      req.sessionToken = payload.jti;
      return next();
    }

    res.status(401).json({ error: "Not authenticated" });
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
