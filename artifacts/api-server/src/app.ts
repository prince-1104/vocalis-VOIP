import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import { resolveUser, requireRole, requireSuperadmin } from "./middleware/auth";
import healthRouter from "./routes/health";
import authPublicRouter from "./routes/auth-public";
import authRouter from "./routes/auth";
import contactsRouter from "./routes/contacts";
import campaignsRouter from "./routes/campaigns";
import callsRouter from "./routes/calls";
import agentsRouter from "./routes/agents";
import trainingRouter from "./routes/training";
import scriptsRouter from "./routes/scripts";
import analyticsRouter from "./routes/analytics";
import twilioRouter from "./routes/twilio";
import dialRouter from "./routes/dial";
import adminRouter from "./routes/admin";
import invoicesRouter, { checkAndMarkOverdueInvoices } from "./routes/invoices";
import widgetRouter from "./routes/widget";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", healthRouter);
app.use("/api", authPublicRouter);
app.use("/api", twilioRouter);
app.use("/api", widgetRouter);

app.use("/api", resolveUser);

app.use("/api", authRouter);

app.use("/api", requireRole("manager", "admin"), contactsRouter);
app.use("/api", requireRole("manager", "admin"), campaignsRouter);
app.use("/api", requireRole("manager", "admin"), callsRouter);
app.use("/api", requireRole("manager", "admin"), analyticsRouter);

app.use("/api", requireRole("admin"), agentsRouter);
app.use("/api", requireRole("admin"), trainingRouter);
app.use("/api", requireRole("admin"), scriptsRouter);

app.use("/api", requireRole("admin"), dialRouter);

app.use("/api", requireSuperadmin, adminRouter);

app.use("/api", invoicesRouter);

// ── Serve the frontend SPA ─────────────────────────────────────────────
import path from "node:path";

// The built frontend lives at <project>/artifacts/sales-sutra/dist/public
// In production, CWD is the project root (set in ecosystem.config.cjs)
const publicDir = path.resolve(process.cwd(), "artifacts/sales-sutra/dist/public");

// Serve static assets (JS, CSS, images, etc.)
app.use(express.static(publicDir));

// SPA fallback — serve index.html for any non-API route that doesn't match a static file
app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});
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

runOverdueCheck();
setInterval(runOverdueCheck, OVERDUE_CHECK_INTERVAL_MS);

export default app;
