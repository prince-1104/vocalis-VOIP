import { pool } from "@workspace/db";
import {
  adoptExistingDatabase,
  applyMigrations,
  describeDatabaseError,
  inspectSchema,
  modifiedMigrations,
  resolveMigrationsFolder,
} from "@workspace/db/migrations";

// Operator tool: node ./dist/db-migrate.cjs <status|apply|adopt>
//   status  read-only report (default); exit 3 when the server would refuse to start
//   apply   apply pending committed migrations
//   adopt   record migrations through the adoption baseline on a database built
//           by `drizzle-kit push` or the former startup DDL (no history yet)
// Output names migrations and schema objects only; never data or credentials.
async function main() {
  const command = process.argv[2] ?? "status";
  if (!["status", "apply", "adopt"].includes(command)) {
    process.stderr.write("usage: db-migrate <status|apply|adopt>\n");
    process.exitCode = 64;
    return;
  }
  const folder = resolveMigrationsFolder();
  const client = await pool.connect();
  try {
    if (command === "apply") {
      const applied = await applyMigrations(client, folder, { lockTimeout: process.env.DB_MIGRATION_LOCK_TIMEOUT });
      process.stdout.write(`${JSON.stringify({ applied }, null, 2)}\n`);
    } else if (command === "adopt") {
      const recorded = await adoptExistingDatabase(client, folder);
      process.stdout.write(`${JSON.stringify({ recordedAsApplied: recorded, next: "run `apply`" }, null, 2)}\n`);
      return;
    }
    const report = await inspectSchema(client);
    const modified = await modifiedMigrations(client, folder);
    process.stdout.write(`${JSON.stringify({ ...report, modifiedAfterApply: modified }, null, 2)}\n`);
    if (report.status !== "ready" || modified.length > 0) process.exitCode = 3;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    process.stderr.write(`database migration failed: ${describeDatabaseError(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
