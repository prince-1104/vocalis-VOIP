import { Router } from "express";
import { requireSuperadmin } from "../middleware/auth";
import { metrics, type OperationalMetrics } from "../lib/operational-metrics";

// Mounted after resolveUser. Global aggregates are restricted to platform operators.
export function createMetricsRouter(registry: OperationalMetrics = metrics) {
  const router = Router();
  router.get("/superadmin/metrics", requireSuperadmin, (_req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.type("text/plain; version=0.0.4; charset=utf-8").send(registry.render()); }
    catch { res.status(503).json({ error: "Metrics unavailable" }); }
  });
  return router;
}
