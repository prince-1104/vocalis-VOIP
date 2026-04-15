import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import { resolveUser, requireRole } from "./middleware/auth";
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

export default app;
