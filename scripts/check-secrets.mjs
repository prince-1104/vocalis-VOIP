#!/usr/bin/env node
// Usage: node scripts/check-secrets.mjs [--range <base>..<head>]
//   Scans the current tree (tracked plus unignored files). With --range, also
//   scans every line added by those commits. Exit 1 on any finding; values are
//   never printed.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatFinding, scanCommitRange, scanRepository, ALLOW_MARKER } from "./secret-scan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const rangeAt = args.indexOf("--range");
const range = rangeAt >= 0 ? args[rangeAt + 1] : undefined;
if (rangeAt >= 0 && !/^[0-9A-Za-z_./^~-]+\.\.[0-9A-Za-z_./^~-]+$/.test(range ?? "")) {
  process.stderr.write("usage: check-secrets [--range <base>..<head>]\n");
  process.exit(64);
}

const findings = scanRepository(root);
const added = range ? scanCommitRange(root, range) : [];
for (const finding of findings) process.stderr.write(`${formatFinding(finding)}\n`);
for (const finding of added) process.stderr.write(`added in commit ${formatFinding(finding)}\n`);
const total = findings.length + added.length;
if (total > 0) {
  process.stderr.write(
    `\n${total} committed credential(s). Read values from the environment instead; test-only fakes may use a ` +
      `reserved host (*.test), a filler value, or a "${ALLOW_MARKER}" comment. A credential that was committed ` +
      `must be rotated even after it is removed.\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`No committed credentials found${range ? ` (current tree and commits ${range})` : ""}.\n`);
}
