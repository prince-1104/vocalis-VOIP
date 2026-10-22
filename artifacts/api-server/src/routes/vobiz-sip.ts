import { Router, type Request, type Response } from "express";
import { requireRole, requireSuperadmin } from "../middleware/auth";
import { createVobizConfigurationService, logVobizConfigurationFailure, VobizConfigurationError, type VobizConfigurationScope } from "../lib/telephony/vobiz-configuration";

/** Mounted after resolveUser; no user/tenant identity is accepted from a body. */
export function createVobizSipRouter(service = createVobizConfigurationService()) {
  const router = Router();
  async function handle(req: Request, res: Response, target: "self" | "platform", method: "get" | "put" | "delete") {
    res.set("Cache-Control", "no-store");
    if (!req.tenantId || !req.userId || !req.tenantUserId) { res.status(401).json({ error: "Not authenticated" }); return; }
    let tenantId = req.tenantId;
    if (target === "platform") {
      const raw = req.params.tenantId;
      if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 2147483647) {
        res.status(404).json({ error: "Vobiz configuration not found" }); return;
      }
      tenantId = Number(raw);
    }
    const scope: VobizConfigurationScope = { tenantId, ownerId: req.userId, tenantUserId: req.tenantUserId, superadmin: target === "platform" && req.isSuperadmin === true };
    try {
      res.json(method === "put" ? await service.put(scope, req.body) : await service[method](scope));
    } catch (error) {
      if (error instanceof VobizConfigurationError) {
        res.status(error.status).json({ error: error.message });
      } else {
        logVobizConfigurationFailure(error);
        res.status(503).json({ error: "Vobiz configuration unavailable" });
      }
    }
  }
  for (const [path, target, guard] of [
    ["/telephony/vobiz-sip", "self", requireRole("admin")],
    ["/superadmin/tenants/:tenantId/telephony/vobiz-sip", "platform", requireSuperadmin],
  ] as const) {
    router.get(path, guard, (req, res) => handle(req, res, target, "get"));
    router.put(path, guard, (req, res) => handle(req, res, target, "put"));
    router.delete(path, guard, (req, res) => handle(req, res, target, "delete"));
  }
  return router;
}
