import { Router, type IRouter } from "express";
import { requireRole } from "../middleware/auth";
import {
  addSuppression,
  listSuppressions,
  revokeSuppression,
  SUPPRESSION_REASONS,
  type SuppressionReason,
} from "../lib/call-suppression";
import { logger } from "../lib/logger";
import { adminMutationRateLimit } from "../lib/rate-limit-policies";

/** Tenant do-not-call / opt-out list. Every operation is scoped to req.userId. */
const router: IRouter = Router();

router.get("/suppressions", async (req, res) => {
  res.json(await listSuppressions(req.userId!));
});

router.post("/suppressions", adminMutationRateLimit, async (req, res) => {
  const { phone, reason } = req.body ?? {};
  const suppressionReason: SuppressionReason = reason === undefined ? "do_not_call" : reason;
  if (!SUPPRESSION_REASONS.includes(suppressionReason)) {
    res.status(400).json({ error: `reason must be one of: ${SUPPRESSION_REASONS.join(", ")}` });
    return;
  }
  const recorded = await addSuppression(req.userId!, phone, suppressionReason, "dashboard");
  if (!recorded) {
    res.status(400).json({ error: "The phone number is not valid." });
    return;
  }
  logger.info({ suppressionId: recorded.id, created: recorded.created, source: "dashboard" }, "Call suppression recorded");
  res.status(recorded.created ? 201 : 200).json(recorded);
});

// Removing a suppression re-enables calling, so it is admin-only.
router.delete("/suppressions/:id", requireRole("admin"), adminMutationRateLimit, async (req, res) => {
  const id = /^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : NaN;
  if (!Number.isSafeInteger(id) || !(await revokeSuppression(req.userId!, id))) {
    res.status(404).json({ error: "Suppression not found" });
    return;
  }
  logger.info({ suppressionId: id, actorTenantUserId: req.tenantUserId ?? null }, "Call suppression revoked");
  res.status(204).end();
});

export default router;
