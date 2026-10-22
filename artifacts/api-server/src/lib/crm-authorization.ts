import {
  db,
  crmApiKeysTable,
  tenantsTable,
  callLogsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";

export class AuthorizationError extends Error {
  constructor(public status: 401 | 403 | 404) {
    super("Access denied");
  }
}
export interface CrmIdentity {
  apiKeyId: number;
  userId: number;
  tenantId: number;
  scopes: string[];
}

export async function resolveCrmCredential(
  rawKey: string,
): Promise<CrmIdentity> {
  if (!/^dk_live_[a-f0-9]{64}$/.test(rawKey)) throw new AuthorizationError(401);
  const key = await db.query.crmApiKeysTable.findFirst({
    where: eq(
      crmApiKeysTable.keyHash,
      createHash("sha256").update(rawKey).digest("hex"),
    ),
  });
  if (!key?.isActive) throw new AuthorizationError(401);
  return revalidateCrmIdentity({
    apiKeyId: key.id,
    userId: key.userId,
    tenantId: key.tenantId,
    scopes: [],
  });
}

export async function revalidateCrmIdentity(
  identity: CrmIdentity,
): Promise<CrmIdentity> {
  const key = await db.query.crmApiKeysTable.findFirst({
    where: eq(crmApiKeysTable.id, identity.apiKeyId),
  });
  if (
    !key?.isActive ||
    key.userId !== identity.userId ||
    key.tenantId !== identity.tenantId
  )
    throw new AuthorizationError(401);
  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, key.tenantId),
  });
  if (!tenant || tenant.status !== "active" || tenant.ownerId !== key.userId)
    throw new AuthorizationError(403);
  const scopes = Array.isArray(key.scopes)
    ? key.scopes.filter((s): s is string => typeof s === "string")
    : [];
  return {
    apiKeyId: key.id,
    userId: key.userId,
    tenantId: key.tenantId,
    scopes,
  };
}

export function requireCrmRead(identity: CrmIdentity): void {
  if (!identity.scopes.includes("*") && !identity.scopes.includes("calls:read"))
    throw new AuthorizationError(403);
}

// Calls use owner IDs in this schema. Ambiguous owner-to-tenant mappings must not
// be resolved with findFirst: that would silently choose an authorization domain.
export async function resolveCallOwner(
  callId: number,
): Promise<{ userId: number; tenantId: number } | null> {
  const call = await db.query.callLogsTable.findFirst({
    where: eq(callLogsTable.id, callId),
  });
  if (!call) return null;
  const tenants = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.ownerId, call.userId))
    .limit(2);
  if (tenants.length !== 1 || tenants[0].status !== "active") return null;
  return { userId: call.userId, tenantId: tenants[0].id };
}

export async function authorizeCrmCall(
  identity: CrmIdentity,
  callId: number,
): Promise<void> {
  const owner = await resolveCallOwner(callId);
  if (
    !owner ||
    owner.userId !== identity.userId ||
    owner.tenantId !== identity.tenantId
  )
    throw new AuthorizationError(404);
}
