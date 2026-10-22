import { db, tenantsTable, vobizSipConfigsTable, vobizSipInputSchema, type VobizSipConfiguration } from "@workspace/db";
import { eq } from "drizzle-orm";
import { credentialCodec, CredentialError, type CredentialCodec } from "../credential-crypto";
import { logger } from "../logger";

export const vobizExecutionBoundary = Object.freeze({
  provider: "VOBIZ_SIP" as const,
  executionAvailable: false as const,
  requiredIntegration: "livekit" as const,
  inboundDestination: null,
});

export interface VobizConfigurationScope {
  tenantId: number;
  ownerId: number;
  tenantUserId: number | null;
  superadmin: boolean;
}

export class VobizConfigurationError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 503, readonly reason: "invalid_configuration" | "authorization_unavailable" | "not_found" | "configuration_unavailable") {
    super(status === 400 ? "Invalid Vobiz SIP configuration" : status === 403 ? "Vobiz configuration access denied" : status === 404 ? "Vobiz configuration not found" : "Vobiz configuration unavailable");
    this.name = "VobizConfigurationError";
  }
}

// Reuse the shared Drizzle connection and process-wide AES-GCM codec. The seam
// allows isolated repository/key failure tests without loading startup or .env.
export function createVobizConfigurationService(connection = db, getCodec: () => CredentialCodec = credentialCodec) {
  async function authorize(scope: VobizConfigurationScope) {
    const tenant = await connection.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, scope.tenantId) });
    if (!tenant || !tenant.ownerId || (!scope.superadmin && tenant.ownerId !== scope.ownerId))
      throw new VobizConfigurationError(404, "not_found");
    if (tenant.status !== "active") throw new VobizConfigurationError(403, "authorization_unavailable");
  }
  const view = (config: VobizSipConfiguration | null) => ({
    ...vobizExecutionBoundary,
    state: config ? "configured_unverified" as const : "not_configured" as const,
    sipDomain: config?.sipDomain ?? null,
    phoneNumbers: config?.phoneNumbers ?? [],
    hasSipCredentials: config !== null,
  });
  function audit(scope: VobizConfigurationScope, operation: "saved" | "deleted") {
    logger.info({ event: "vobiz_configuration_changed", operation, tenantId: scope.tenantId, tenantUserId: scope.tenantUserId }, "Vobiz configuration changed");
  }
  return {
    async get(scope: VobizConfigurationScope) {
      await authorize(scope);
      const row = await connection.query.vobizSipConfigsTable.findFirst({ where: eq(vobizSipConfigsTable.tenantId, scope.tenantId) });
      if (!row) return view(null);
      const codec = getCodec();
      const parsed = vobizSipInputSchema.safeParse({
        sipDomain: row.sipDomain, phoneNumbers: row.phoneNumbers,
        sipUsername: codec.open("vobizSipUsername", scope.tenantId, row.sipUsername),
        sipPassword: codec.open("vobizSipPassword", scope.tenantId, row.sipPassword),
      });
      if (!parsed.success) throw new VobizConfigurationError(503, "configuration_unavailable");
      return view(parsed.data);
    },
    async put(scope: VobizConfigurationScope, input: unknown) {
      await authorize(scope);
      const parsed = vobizSipInputSchema.safeParse(input);
      if (!parsed.success) throw new VobizConfigurationError(400, "invalid_configuration");
      const config = parsed.data;
      const codec = getCodec();
      const values = {
        sipDomain: config.sipDomain, phoneNumbers: config.phoneNumbers,
        sipUsername: codec.seal("vobizSipUsername", scope.tenantId, config.sipUsername),
        sipPassword: codec.seal("vobizSipPassword", scope.tenantId, config.sipPassword),
        updatedAt: new Date(),
      };
      // Complete replacement in one statement: concurrent updates cannot mix
      // one request's username/password with another request's trunk fields.
      await connection.insert(vobizSipConfigsTable).values({ tenantId: scope.tenantId, ...values })
        .onConflictDoUpdate({ target: vobizSipConfigsTable.tenantId, set: values });
      audit(scope, "saved");
      return view(config);
    },
    async delete(scope: VobizConfigurationScope) {
      await authorize(scope);
      await connection.delete(vobizSipConfigsTable).where(eq(vobizSipConfigsTable.tenantId, scope.tenantId));
      audit(scope, "deleted");
      return view(null);
    },
  };
}

// A reason code is sufficient for diagnostics; never log DB/provider exception
// text or an invalid input (which can contain SIP credentials or phone numbers).
export function logVobizConfigurationFailure(error: unknown) {
  logger.warn({ event: "vobiz_configuration_unavailable", reason: error instanceof CredentialError ? error.reason : "storage" }, "Vobiz configuration unavailable");
}
