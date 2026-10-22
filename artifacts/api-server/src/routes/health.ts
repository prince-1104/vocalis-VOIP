import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

type ReadinessCheck = () => Promise<{ ready: boolean; status: string }>;
let readinessCheck: ReadinessCheck = async () => ({ ready: false, status: "starting" });

export function setReadinessCheck(check: ReadinessCheck): void {
  readinessCheck = check;
}

// Liveness: the process is up. Deliberately independent of the database, so a
// database outage does not make a supervisor restart healthy processes.
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Readiness: startup schema check passed and the database answers now.
router.get("/readyz", async (_req, res) => {
  const result = await readinessCheck().catch(() => ({ ready: false, status: "database_unavailable" }));
  res.set("Cache-Control", "no-store").status(result.ready ? 200 : 503).json({ status: result.status });
});

export default router;
