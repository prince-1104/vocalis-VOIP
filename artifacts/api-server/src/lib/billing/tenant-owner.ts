import { db, tenantsTable, tenantUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Usage is attributed through the account owner, never through a tenant id
// supplied by a caller.
const ownerTenantCache = new Map<number, { tenantId: number; cachedAt: number }>();
const OWNER_TENANT_CACHE_TTL = 5 * 60 * 1000;

export async function resolveTenantIdForOwner(userId: number): Promise<number | null> {
  const cached = ownerTenantCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < OWNER_TENANT_CACHE_TTL) return cached.tenantId;

  let tenantId: number | null = null;
  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.ownerId, userId),
  });

  if (tenant) {
    tenantId = tenant.id;
  } else {
    const tenantUser = await db.query.tenantUsersTable.findFirst({
      where: eq(tenantUsersTable.userId, userId),
    });
    if (tenantUser) tenantId = tenantUser.tenantId;
  }

  if (tenantId) {
    ownerTenantCache.set(userId, { tenantId, cachedAt: Date.now() });
    return tenantId;
  }
  return null;
}
