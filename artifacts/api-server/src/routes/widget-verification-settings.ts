import { Router, type IRouter, type Request, type Response } from "express";
import { getPolicyView, savePolicy } from "../lib/widget-verification-policy";

const router: IRouter = Router();

// Mounted behind resolveUser + requireRole("admin"). The tenant is always the
// authenticated session's tenant; no tenant, owner, widget or agent ID is
// read from the request.
function actor(req: Request, res: Response) {
  if (!req.tenantId || !req.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  return { tenantId: req.tenantId, ownerId: req.userId, tenantUserId: req.tenantUserId ?? null };
}

router.get("/widget-verification/policy", async (req, res) => {
  const who = actor(req, res);
  if (!who) return;
  res.json(await getPolicyView(who.tenantId, who.ownerId));
});

router.put("/widget-verification/policy", async (req, res) => {
  const who = actor(req, res);
  if (!who) return;
  const result = await savePolicy(who, req.body);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error, field: result.field });
    return;
  }
  res.json({ ...result.view, changed: result.changed });
});

export default router;
