#!/usr/bin/env node
// Usage: node scripts/check-schema-push.mjs   (exit 1 on an unguarded schema push in automation)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditRepository, formatAuditFinding } from "./schema-push-audit.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const findings = auditRepository(root);
for (const finding of findings) process.stderr.write(`${formatAuditFinding(finding)}\n`);
if (findings.length > 0) {
  process.stderr.write(
    `\n${findings.length} unsafe schema-push invocation(s). Committed migrations are the only supported way to ` +
      "change a shared schema (see docs/production-readiness/database-migrations-and-startup.md).\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write("No unguarded schema-push invocations in repository automation.\n");
}
