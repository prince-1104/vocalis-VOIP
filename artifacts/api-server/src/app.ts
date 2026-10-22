import express, { type Express } from "express";
import { logger } from "./lib/logger";
import { installHttpSecurity } from "./lib/security-headers";
import { createHttpLogger } from "./lib/http-logger";
import { safeErrorHandler } from "./lib/error-handler";
import { parseTrustProxy } from "./lib/trusted-proxy";
import { resolveUser, requireRole, requireSuperadmin } from "./middleware/auth";
import healthRouter from "./routes/health";
import authPublicRouter from "./routes/auth-public";
import authRouter from "./routes/auth";
import contactsRouter from "./routes/contacts";
import campaignsRouter from "./routes/campaigns";
import suppressionsRouter from "./routes/suppressions";
import callsRouter from "./routes/calls";
import agentsRouter from "./routes/agents";
import trainingRouter from "./routes/training";
import scriptsRouter from "./routes/scripts";
import analyticsRouter from "./routes/analytics";
import twilioRouter from "./routes/twilio";
import exotelRouter from "./routes/exotel";
import dialRouter from "./routes/dial";
import adminRouter from "./routes/admin";
import adminCostsRouter from "./routes/admin-costs";
import invoicesRouter, { checkAndMarkOverdueInvoices } from "./routes/invoices";
import widgetRouter from "./routes/widget";
import crmRouter, { crmAdminRouter } from "./routes/crm";
import externalCrmRouter from "./routes/external-crm";
import widgetVerificationSettingsRouter from "./routes/widget-verification-settings";
import { startWebhookDispatcher } from "./lib/webhook-dispatcher";
import { startCampaignDialScheduler } from "./lib/campaign-dialer";

const app: Express = express();

// req.ip (and every per-address rate limit) depends on this; see trusted-proxy.ts.
app.set("trust proxy", parseTrustProxy(process.env));

app.use(createHttpLogger());
installHttpSecurity(app, process.env);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", healthRouter);
app.use("/api", authPublicRouter);
app.use("/api", twilioRouter);
app.use("/api", exotelRouter);
app.use("/api", widgetRouter);
app.use("/api", crmRouter);            // CRM routes use their own API-key auth

app.use("/api", resolveUser);

app.use("/api", authRouter);
// Mounted before the role-gated routers: each invoice and usage route enforces
// its own role (tenant admin/manager or superadmin).
app.use("/api", invoicesRouter);

app.use("/api", requireRole("manager", "admin"), contactsRouter);
app.use("/api", requireRole("manager", "admin"), campaignsRouter);
app.use("/api", requireRole("manager", "admin"), suppressionsRouter);
app.use("/api", requireRole("manager", "admin"), callsRouter);
app.use("/api", requireRole("manager", "admin"), analyticsRouter);

app.use("/api", requireRole("admin"), agentsRouter);
app.use("/api", requireRole("admin"), trainingRouter);
app.use("/api", requireRole("admin"), scriptsRouter);

app.use("/api", requireRole("admin"), dialRouter);
app.use("/api", requireRole("admin"), crmAdminRouter);  // CRM API key management
app.use("/api", requireRole("admin"), externalCrmRouter);
app.use("/api", requireRole("admin"), widgetVerificationSettingsRouter);

app.use("/api", requireSuperadmin, adminRouter);
app.use("/api", requireSuperadmin, adminCostsRouter);

// ── Serve the frontend SPA ─────────────────────────────────────────────
import path from "node:path";

// The built frontend lives at <project>/artifacts/sales-sutra/dist/public
// In production, CWD is the project root (set in ecosystem.config.cjs)
const publicDir = path.resolve(process.cwd(), "artifacts/sales-sutra/dist/public");

// Serve static assets (JS, CSS, images, etc.)
app.use(express.static(publicDir));

// SPA fallback — serve index.html for any non-API route that doesn't match a static file
app.use((_req, res) => {
  res.set("Cache-Control", "no-cache").sendFile(path.join(publicDir, "index.html"));
});

app.use(safeErrorHandler());
// ─────────────────────────────────────────────────────────────────────────

const OVERDUE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function runOverdueCheck() {
  try {
    await checkAndMarkOverdueInvoices();
    logger.info("Overdue invoice check complete");
  } catch (err) {
    logger.error({ err }, "Overdue invoice check failed");
  }
}

let workersStarted = false;

// Background jobs read and write the database; index.ts starts them only after
// the schema check passes.
export function startBackgroundWorkers(): void {
  if (workersStarted) return;
  workersStarted = true;
  runOverdueCheck();
  setInterval(runOverdueCheck, OVERDUE_CHECK_INTERVAL_MS);

  // Start CRM webhook event dispatcher
  startWebhookDispatcher();

  // Keep parallel/auto campaigns dialing without requiring pause/resume
  startCampaignDialScheduler();
}

export default app;
