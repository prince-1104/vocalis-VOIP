import { defineConfig } from "drizzle-kit";
import { classifyPushTarget, isPushCommand } from "./src/push-guard";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

// Committed migrations (`db:migrate`) are the schema path for every shared
// database; push is limited to throwaway local ones (see src/push-guard.ts).
if (isPushCommand(process.argv)) {
  const decision = classifyPushTarget(process.env);
  if (!decision.allowed) {
    process.stderr.write(
      `Refusing drizzle-kit push: ${decision.reason}.\n` +
        "Use `pnpm --filter @workspace/api-server run db:migrate apply` for migration-managed databases.\n",
    );
    process.exit(2);
  }
}

const dbUrl = process.env.DATABASE_URL;
const needsSsl = process.env.DATABASE_SSL === "true" || dbUrl.includes("sslmode=require") || dbUrl.includes("sslmode=verify");

export default defineConfig({
  schema: "./src/schema/*",
  dialect: "postgresql",
  dbCredentials: {
    url: dbUrl,
    ...(needsSsl ? { ssl: "require" } : {})
  },
});
