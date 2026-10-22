import { db, pool } from "@workspace/db";
import { credentialCodec } from "./lib/credential-crypto";
import { migrateCredentials } from "./lib/credential-migration";

// Operator tool: node ./dist/credential-migrate.cjs [--apply]
// Without --apply nothing is written. Output is counts per column only.
async function main() {
  const apply = process.argv.includes("--apply");
  const report = await migrateCredentials(db, credentialCodec(), { apply });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.complete) process.exitCode = 2;
}

main()
  .catch((err) => {
    // Credential and configuration errors carry no secret material.
    process.stderr.write(`credential migration failed: ${err?.name ?? "Error"}: ${err?.message ?? ""}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
