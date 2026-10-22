import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

type ReadinessCheck = () => Promise<{ ready: boolean; status: string }>;
let readinessCheck: ReadinessCheck = async () => ({ ready: false, status: "starting" });

export function setReadinessCheck(check: ReadinessCheck): void {
  readinessCheck = check;
}

export function createHealthRouter(check: ReadinessCheck = () => readinessCheck(), timeoutMs = 2_500): IRouter {
  const router = Router();
  // A database outage must not make a supervisor restart healthy processes.
  router.get("/healthz", (_req, res) => {
    res.json(HealthCheckResponse.parse({ status: "ok" }));
  });

  router.get("/readyz", async (_req, res) => {
    let timer: NodeJS.Timeout | undefined;
    let result: Awaited<ReturnType<ReadinessCheck>> | undefined;
    try {
      result = await Promise.race([
        Promise.resolve().then(check),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeoutMs);
          timer.unref();
        }),
      ]);
    } catch { /* minimal public failure response */ }
    finally { clearTimeout(timer); }
    const ready = result?.ready === true && result.status === "ready";
    const status = ready ? "ready" : result?.ready === false && ["starting", "blocked"].includes(result.status) ? result.status : "database_unavailable";
    res.set("Cache-Control", "no-store").status(ready ? 200 : 503).json({ status });
  });
  return router;
}

export default createHealthRouter();
