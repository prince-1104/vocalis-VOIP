import { Router, type IRouter } from "express";
import { requireRole, requireSuperadmin } from "../middleware/auth";
import healthRouter from "./health";
import authRouter from "./auth";
import contactsRouter from "./contacts";
import campaignsRouter from "./campaigns";
import callsRouter from "./calls";
import agentsRouter from "./agents";
import trainingRouter from "./training";
import scriptsRouter from "./scripts";
import analyticsRouter from "./analytics";
import twilioRouter from "./twilio";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);

router.use(requireRole("manager", "admin"), contactsRouter);
router.use(requireRole("manager", "admin"), campaignsRouter);
router.use(requireRole("manager", "admin"), callsRouter);
router.use(requireRole("manager", "admin"), analyticsRouter);

router.use(requireRole("admin"), agentsRouter);
router.use(requireRole("admin"), trainingRouter);
router.use(requireRole("admin"), scriptsRouter);

router.use(twilioRouter);

export default router;
