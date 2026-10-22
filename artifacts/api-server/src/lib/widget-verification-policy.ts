import {
  db as defaultDb,
  agentConfigsTable,
  externalCrmConfigsTable,
  tenantsTable,
  widgetVerificationPoliciesTable as policies,
  type WidgetVerificationPolicy,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import {
  DEFAULT_VERIFICATION_METHOD,
  DOB_FORMATS,
  VERIFICATION_METHODS,
  isDobFormat,
  isValidDobFieldPath,
  isVerificationMethod,
  type DobFormat,
  type VerificationMethod,
} from "./widget-verification-factors";
import {
  getWidgetVerification,
  verificationKeyConfigured,
  type ActiveVerificationPolicy,
} from "./widget-verification";

export const METHOD_DETAILS: Record<VerificationMethod, { label: string; assurance: "lower" | "moderate" | "higher" }> = {
  order_suffix_4: { label: "Registered phone + last 4 digits of an order ID", assurance: "lower" },
  order_suffix_6: { label: "Registered phone + last 6 digits of an order ID", assurance: "moderate" },
  date_of_birth: { label: "Registered phone + date of birth from your CRM", assurance: "moderate" },
  sms_otp: { label: "One-time code sent to the registered phone", assurance: "higher" },
};

export interface PolicyRequirements {
  crmConnected: boolean;
  widgetCrmEnabled: boolean;
  verificationKeyConfigured: boolean;
  otpDeliveryConfigured: boolean;
}

/**
 * Why a method cannot run for this tenant right now, or null if it can.
 * Pass `dob: null` to check platform/CRM prerequisites only.
 */
export function unsupportedReason(
  method: VerificationMethod,
  requirements: PolicyRequirements,
  dob: { dobFieldPath: string | null; dobFormat: string | null } | null,
): string | null {
  if (!requirements.verificationKeyConfigured)
    return "The server verification key (WIDGET_VERIFICATION_KEY) is not configured. Contact your platform administrator.";
  if (!requirements.crmConnected)
    return "Connect and enable an external CRM lookup before enabling customer verification.";
  if (method === "date_of_birth" && dob && !(isValidDobFieldPath(dob.dobFieldPath) && isDobFormat(dob.dobFormat)))
    return "Date-of-birth verification needs the CRM response field that holds the date of birth and its exact format.";
  if (method === "sms_otp" && !requirements.otpDeliveryConfigured)
    return "One-time-code verification needs a delivery provider, and none is configured.";
  return null;
}

type Db = typeof defaultDb;

async function requirementsFor(db: Db, ownerId: number): Promise<PolicyRequirements> {
  const [crm, agent] = await Promise.all([
    db.query.externalCrmConfigsTable.findFirst({ where: eq(externalCrmConfigsTable.userId, ownerId) }),
    db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, ownerId) }),
  ]);
  return {
    crmConnected: !!(crm?.isEnabled && crm.lookupUrl),
    widgetCrmEnabled: !!(agent as any)?.widgetExternalCrmEnabled,
    verificationKeyConfigured: verificationKeyConfigured(),
    otpDeliveryConfigured: getWidgetVerification().otpAvailable(),
  };
}

function view(row: WidgetVerificationPolicy | undefined, requirements: PolicyRequirements) {
  const policy = {
    enabled: row?.enabled ?? false,
    method: (row && isVerificationMethod(row.method) ? row.method : DEFAULT_VERIFICATION_METHOD) as VerificationMethod,
    dobFieldPath: row?.dobFieldPath ?? null,
    dobFormat: row?.dobFormat ?? null,
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt ?? null,
  };
  const reason = policy.enabled ? unsupportedReason(policy.method, requirements, policy) : null;
  const reasons = [
    ...(reason ? [reason] : []),
    ...(policy.enabled && !requirements.widgetCrmEnabled
      ? ["The widget's External CRM integration toggle is off, so no customer data is used."]
      : []),
  ];
  return {
    policy,
    status: !policy.enabled ? "disabled" : reasons.length ? "needs_attention" : "active",
    reasons,
    requirements,
    methods: VERIFICATION_METHODS.map(id => {
      const blocked = unsupportedReason(id, requirements, null);
      return {
        id,
        ...METHOD_DETAILS[id],
        supported: blocked === null,
        unsupportedReason: blocked,
        requiresDobMapping: id === "date_of_birth",
      };
    }),
    dobFormats: DOB_FORMATS,
  };
}

export type PolicyView = ReturnType<typeof view>;

export async function getPolicyView(tenantId: number, ownerId: number, db: Db = defaultDb): Promise<PolicyView> {
  const [row, requirements] = await Promise.all([
    db.query.widgetVerificationPoliciesTable.findFirst({ where: eq(policies.tenantId, tenantId) }),
    requirementsFor(db, ownerId),
  ]);
  return view(row, requirements);
}

const ALLOWED_FIELDS = new Set(["enabled", "method", "dobFieldPath", "dobFormat"]);

export type SavePolicyResult =
  | { ok: true; view: PolicyView; changed: boolean }
  | { ok: false; status: 400 | 409; error: string; field?: string };

/**
 * Validates and stores a tenant's policy. The tenant comes only from the
 * authenticated session; any security-relevant change bumps the version and
 * revokes outstanding widget sessions and challenges.
 */
export async function savePolicy(
  actor: { tenantId: number; ownerId: number; tenantUserId: number | null },
  body: unknown,
  db: Db = defaultDb,
): Promise<SavePolicyResult> {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { ok: false, status: 400, error: "Request body must be an object." };
  const input = body as Record<string, unknown>;
  const unknownField = Object.keys(input).find(key => !ALLOWED_FIELDS.has(key));
  if (unknownField) return { ok: false, status: 400, error: `Unsupported field: ${unknownField}`, field: unknownField };
  if (typeof input.enabled !== "boolean")
    return { ok: false, status: 400, error: "Choose whether customer-specific access is enabled.", field: "enabled" };

  const existing = await db.query.widgetVerificationPoliciesTable.findFirst({
    where: eq(policies.tenantId, actor.tenantId),
  });

  const method = input.method === undefined
    ? (existing && isVerificationMethod(existing.method) ? existing.method : DEFAULT_VERIFICATION_METHOD)
    : input.method;
  if (!isVerificationMethod(method))
    return { ok: false, status: 400, error: "Unknown verification method.", field: "method" };

  const dobFieldPath = input.dobFieldPath === undefined ? existing?.dobFieldPath ?? null : input.dobFieldPath;
  const dobFormat = input.dobFormat === undefined ? existing?.dobFormat ?? null : input.dobFormat;
  if (dobFieldPath !== null && dobFieldPath !== "" && !isValidDobFieldPath(dobFieldPath))
    return {
      ok: false,
      status: 400,
      error: "Date-of-birth field must be a dot-separated path such as customer.dateOfBirth.",
      field: "dobFieldPath",
    };
  if (dobFormat !== null && dobFormat !== "" && !isDobFormat(dobFormat))
    return { ok: false, status: 400, error: "Unsupported date-of-birth format.", field: "dobFormat" };
  const dob = {
    dobFieldPath: (dobFieldPath || null) as string | null,
    dobFormat: (dobFormat || null) as DobFormat | null,
  };
  if (method === "date_of_birth" && !(dob.dobFieldPath && dob.dobFormat))
    return {
      ok: false,
      status: 400,
      error: "Date-of-birth verification needs the CRM response field and its date format.",
      field: dob.dobFieldPath ? "dobFormat" : "dobFieldPath",
    };

  const requirements = await requirementsFor(db, actor.ownerId);
  if (input.enabled) {
    const reason = unsupportedReason(method, requirements, dob);
    if (reason) return { ok: false, status: 400, error: reason, field: "method" };
  }

  const next = { enabled: input.enabled, method, ...dob };
  const changed =
    !existing ||
    existing.enabled !== next.enabled ||
    existing.method !== next.method ||
    existing.dobFieldPath !== next.dobFieldPath ||
    existing.dobFormat !== next.dobFormat;
  if (!changed) return { ok: true, view: view(existing, requirements), changed: false };

  const current = new Date();
  let saved: WidgetVerificationPolicy | undefined;
  if (!existing) {
    [saved] = await db
      .insert(policies)
      .values({
        tenantId: actor.tenantId,
        ...next,
        version: 1,
        updatedByTenantUserId: actor.tenantUserId,
        createdAt: current,
        updatedAt: current,
      })
      .onConflictDoNothing()
      .returning();
  } else {
    [saved] = await db
      .update(policies)
      .set({ ...next, version: existing.version + 1, updatedByTenantUserId: actor.tenantUserId, updatedAt: current })
      .where(and(eq(policies.tenantId, actor.tenantId), eq(policies.version, existing.version)))
      .returning();
  }
  if (!saved)
    return { ok: false, status: 409, error: "The policy was changed by someone else. Reload and try again." };

  await getWidgetVerification().invalidateTenant(actor.tenantId);
  logger.info(
    {
      event: "widget_verification_policy_updated",
      tenantId: actor.tenantId,
      tenantUserId: actor.tenantUserId,
      enabled: saved.enabled,
      method: saved.method,
      version: saved.version,
    },
    "Widget verification policy updated",
  );
  return { ok: true, view: view(saved, requirements), changed: true };
}

/**
 * The policy the public widget must follow, or null when customer-specific
 * CRM access is off. Null is returned for every unconfigured, disabled or
 * unsupported state; nothing supplied by the browser is consulted.
 */
export async function resolveActiveWidgetPolicy(
  agent: { userId: number; widgetExternalCrmEnabled?: boolean | null },
  db: Db = defaultDb,
): Promise<ActiveVerificationPolicy | null> {
  if (!agent.widgetExternalCrmEnabled) return null;
  const owned = await db.select().from(tenantsTable).where(eq(tenantsTable.ownerId, agent.userId)).limit(2);
  if (owned.length !== 1 || owned[0].status !== "active") return null;
  const tenantId = owned[0].id as number;
  const row = await db.query.widgetVerificationPoliciesTable.findFirst({ where: eq(policies.tenantId, tenantId) });
  if (!row || !row.enabled || !isVerificationMethod(row.method)) return null;
  // Read uncached: the caller's agent object may be up to a minute old.
  const requirements = await requirementsFor(db, agent.userId);
  if (!requirements.widgetCrmEnabled) return null;
  const reason = unsupportedReason(row.method, requirements, row);
  if (reason) {
    logger.warn(
      { event: "widget_verification_policy_unsupported", tenantId, method: row.method },
      "Widget verification policy cannot be enforced; customer access disabled",
    );
    return null;
  }
  return {
    tenantId,
    version: row.version,
    method: row.method,
    dobFieldPath: row.dobFieldPath,
    dobFormat: isDobFormat(row.dobFormat) ? row.dobFormat : null,
  };
}
