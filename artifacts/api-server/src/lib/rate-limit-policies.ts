import type { Request, Response } from "express";
import {
  clientAddress,
  enforceRateLimit,
  rateLimit,
  type LimitRule,
  type RateLimitPolicy,
  type RejectResponder,
} from "./rate-limit";

const MINUTE = 60_000;

const failedLogin = (status: number) => status < 400 || status === 402;
const succeeded = (status: number) => status < 400;

/**
 * Budgets per category. Identities are always server-derived (socket/proxy
 * address, authenticated principal, tenant, API key) or a hashed submitted
 * account identifier; no caller-supplied tenant id selects a budget, and every
 * tenant gets the same budget, so naming another tenant cannot buy headroom.
 */
export const POLICIES = {
  // Login: all attempts per address, plus failures per address, per
  // account+address and per account from anywhere. Successful logins are
  // refunded from the failure budgets. The account-wide budget is set well
  // above the account+address one so locking out a known email takes a
  // sustained, distributed effort.
  loginIp: { name: "login.ip", windowMs: 15 * MINUTE, max: 60, onStoreFailure: "closed" },
  loginIpFailed: { name: "login.ip_failed", windowMs: 15 * MINUTE, max: 20, onStoreFailure: "closed", refundWhen: failedLogin },
  loginAccountIpFailed: { name: "login.account_ip_failed", windowMs: 15 * MINUTE, max: 5, onStoreFailure: "closed", refundWhen: failedLogin },
  loginAccountFailed: { name: "login.account_failed", windowMs: 60 * MINUTE, max: 50, onStoreFailure: "closed", refundWhen: failedLogin },
  passwordChangeFailed: { name: "password_change.user_failed", windowMs: 15 * MINUTE, max: 5, onStoreFailure: "closed", refundWhen: succeeded },

  // Public widget. Per-address budgets run before the widget key is looked
  // up; tenant ceilings run after it resolves to its owner server-side and
  // cap provider spend for one tenant without merging its visitors.
  widgetConfigIp: { name: "widget.config.ip", windowMs: MINUTE, max: 120, onStoreFailure: "open" },
  widgetChatIp: { name: "widget.chat.ip", windowMs: MINUTE, max: 30, onStoreFailure: "closed" },
  widgetChatTenant: { name: "widget.chat.tenant", windowMs: MINUTE, max: 600, onStoreFailure: "closed" },
  widgetTtsIp: { name: "widget.tts.ip", windowMs: MINUTE, max: 30, onStoreFailure: "closed" },
  widgetTtsTenant: { name: "widget.tts.tenant", windowMs: MINUTE, max: 600, onStoreFailure: "closed" },
  widgetVoiceTokenIp: { name: "widget.voice_token.ip", windowMs: 10 * MINUTE, max: 10, onStoreFailure: "closed" },
  widgetVoiceTokenTenant: { name: "widget.voice_token.tenant", windowMs: MINUTE, max: 60, onStoreFailure: "closed" },
  // Cross-tenant per-address ceilings on top of the per-tenant, per-destination
  // and per-source limits enforced inside widget-verification (unchanged).
  widgetVerificationStartIp: { name: "widget.verification_start.ip", windowMs: 15 * MINUTE, max: 20, onStoreFailure: "closed" },
  widgetVerificationResendIp: { name: "widget.verification_resend.ip", windowMs: 15 * MINUTE, max: 20, onStoreFailure: "closed" },
  widgetVerificationFactorIp: { name: "widget.verification_factor.ip", windowMs: 15 * MINUTE, max: 60, onStoreFailure: "closed" },
  widgetCustomerSessionIp: { name: "widget.customer_session.ip", windowMs: MINUTE, max: 60, onStoreFailure: "closed" },

  // CRM API keys. Failed key authentication is limited per address; valid
  // keys get their own budgets, plus tenant ceilings for billed operations.
  crmAuthFailedIp: { name: "crm.auth_failed.ip", windowMs: 15 * MINUTE, max: 30, onStoreFailure: "closed", refundWhen: (status) => status !== 401 },
  crmKey: { name: "crm.key", windowMs: MINUTE, max: 600, onStoreFailure: "closed" },
  crmCallCreateKey: { name: "crm.call_create.key", windowMs: MINUTE, max: 60, onStoreFailure: "closed" },
  crmCallCreateTenant: { name: "crm.call_create.tenant", windowMs: MINUTE, max: 120, onStoreFailure: "closed" },
  crmTransferKey: { name: "crm.transfer.key", windowMs: MINUTE, max: 30, onStoreFailure: "closed" },
  crmCampaignCreateKey: { name: "crm.campaign_create.key", windowMs: MINUTE, max: 30, onStoreFailure: "closed" },
  crmCampaignStartKey: { name: "crm.campaign_start.key", windowMs: MINUTE, max: 10, onStoreFailure: "closed" },
  crmWebhookConfigKey: { name: "crm.webhook_config.key", windowMs: 60 * MINUTE, max: 20, onStoreFailure: "closed" },

  // Authenticated dashboard operations that place calls or reach providers.
  dialUser: { name: "dial.user", windowMs: MINUTE, max: 30, onStoreFailure: "closed" },
  dialTenant: { name: "dial.tenant", windowMs: MINUTE, max: 60, onStoreFailure: "closed" },
  callTransferUser: { name: "call_transfer.user", windowMs: MINUTE, max: 20, onStoreFailure: "closed" },
  campaignLaunchUser: { name: "campaign_launch.user", windowMs: MINUTE, max: 10, onStoreFailure: "closed" },
  campaignLaunchTenant: { name: "campaign_launch.tenant", windowMs: MINUTE, max: 30, onStoreFailure: "closed" },
  crmTestUser: { name: "external_crm_test.user", windowMs: MINUTE, max: 10, onStoreFailure: "closed" },
  adminMutationUser: { name: "admin_mutation.user", windowMs: 10 * MINUTE, max: 120, onStoreFailure: "closed" },
} as const satisfies Record<string, RateLimitPolicy>;

// ── Identities ─────────────────────────────────────────────────────────

const ip = (req: Request) => ["ip", clientAddress(req)];
/** Dashboard user (one tenant member), falling back to address if unauthenticated. */
const user = (req: Request) => (req.tenantUserId ? ["user", req.tenantUserId] : ip(req));
const tenant = (req: Request) => (req.tenantId ? ["tenant", req.tenantId] : null);
const crmKey = (req: Request) => (req.crmApiKeyId ? ["crm_key", req.crmApiKeyId] : null);
/** Submitted login email, normalized as the login route does; hashed into the key. */
const account = (req: Request) => {
  const email = req.body?.email;
  return typeof email === "string" && email.trim() ? ["account", email.trim().toLowerCase()] : null;
};

const rule = (policy: RateLimitPolicy, identify: LimitRule["identify"]): LimitRule => ({ policy, identify });
const MUTATIONS = ["POST", "PUT", "PATCH", "DELETE"];

// ── Middleware ─────────────────────────────────────────────────────────

export const loginRateLimit = rateLimit([
  rule(POLICIES.loginIp, ip),
  rule(POLICIES.loginIpFailed, ip),
  rule(POLICIES.loginAccountIpFailed, (req) => {
    const a = account(req);
    return a && [...a, ...ip(req)];
  }),
  rule(POLICIES.loginAccountFailed, account),
]);

export const passwordChangeRateLimit = rateLimit([rule(POLICIES.passwordChangeFailed, user)]);

export const widgetConfigRateLimit = rateLimit([rule(POLICIES.widgetConfigIp, ip)]);
export const widgetChatRateLimit = rateLimit([rule(POLICIES.widgetChatIp, ip)]);
export const widgetTtsRateLimit = rateLimit([rule(POLICIES.widgetTtsIp, ip)]);
export const widgetVoiceTokenRateLimit = rateLimit([rule(POLICIES.widgetVoiceTokenIp, ip)]);
export const widgetCustomerSessionRateLimit = rateLimit([rule(POLICIES.widgetCustomerSessionIp, ip)]);
export const widgetVerificationRateLimits = (reject: RejectResponder) => ({
  start: rateLimit([rule(POLICIES.widgetVerificationStartIp, ip)], { reject }),
  resend: rateLimit([rule(POLICIES.widgetVerificationResendIp, ip)], { reject }),
  factor: rateLimit([rule(POLICIES.widgetVerificationFactorIp, ip)], { reject }),
});

/** Tenant ceiling for a widget, keyed by the owner the widget key resolved to. */
export function enforceWidgetTenantBudget(
  req: Request,
  res: Response,
  policy: RateLimitPolicy,
  ownerId: number,
): Promise<boolean> {
  return enforceRateLimit(req, res, [rule(policy, () => ["owner", ownerId])]);
}

export const crmAuthFailureRateLimit = rateLimit([rule(POLICIES.crmAuthFailedIp, ip)]);
export const crmKeyRateLimit = rateLimit([rule(POLICIES.crmKey, crmKey)]);
export const crmCallCreateRateLimit = rateLimit([
  rule(POLICIES.crmCallCreateKey, crmKey),
  rule(POLICIES.crmCallCreateTenant, tenant),
]);
export const crmTransferRateLimit = rateLimit([rule(POLICIES.crmTransferKey, crmKey)]);
export const crmCampaignCreateRateLimit = rateLimit([rule(POLICIES.crmCampaignCreateKey, crmKey)]);
export const crmCampaignStartRateLimit = rateLimit([rule(POLICIES.crmCampaignStartKey, crmKey)]);
export const crmWebhookConfigRateLimit = rateLimit([rule(POLICIES.crmWebhookConfigKey, crmKey)]);

export const dialRateLimit = rateLimit([rule(POLICIES.dialUser, user), rule(POLICIES.dialTenant, tenant)]);
export const callTransferRateLimit = rateLimit([rule(POLICIES.callTransferUser, user)]);
export const campaignLaunchRateLimit = rateLimit([
  rule(POLICIES.campaignLaunchUser, user),
  rule(POLICIES.campaignLaunchTenant, tenant),
]);
export const crmTestRateLimit = rateLimit([rule(POLICIES.crmTestUser, user)]);
export const adminMutationRateLimit = rateLimit([rule(POLICIES.adminMutationUser, user)], { methods: MUTATIONS });
