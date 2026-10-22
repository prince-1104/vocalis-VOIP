// Finds schema-push invocations in repository automation that could change a
// shared database outside committed migrations. The only permitted push
// commands are lib/db's `push` / `push-force` scripts, which load
// drizzle.config.ts and therefore its guard (lib/db/src/push-guard.ts);
// automation must not call even those. Findings name file, line and rule only.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const GUARDED_SCRIPTS = new Map([
  ["push", "drizzle-kit push --config ./drizzle.config.ts"],
  ["push-force", "drizzle-kit push --force --config ./drizzle.config.ts"],
]);

// Files that run commands: manifests, shell, CI, Replit and process configs,
// and repository scripts. Prose documentation is reviewed by hand instead.
const AUTOMATION_FILE =
  /(^|\/)(package\.json|\.replit|Dockerfile[^/]*|Procfile|Makefile|ecosystem\.config\.c?js)$|\.(sh|bash|toml)$|^\.github\/.*\.ya?ml$|^scripts\/.*\.(m?js|cjs|ts)$/;
const SELF = new Set(["scripts/schema-push-audit.mjs", "scripts/check-schema-push.mjs"]);

// `push` as a command word (not part of a name such as check:schema-push).
const PUSH_WORD = String.raw`(?:^|[\s"'\[,])push(?:-force)?(?=$|[\s"'\],])`;
const DRIZZLE_PUSH = new RegExp(String.raw`\bdrizzle-kit\b[^\n;&|]*?${PUSH_WORD}`);
// Connection or schema flags make drizzle-kit ignore drizzle.config.ts.
const CONFIG_BYPASS = /\bdrizzle-kit\b[^\n;&|]*?(--url\b|--dialect\b|--schema\b|--host\b|--driver\b)/;
const PUSH_SCRIPT_CALL = new RegExp(String.raw`\b(?:pnpm|npm|yarn|bun)\b[^\n;&|]*?${PUSH_WORD}`);
// Whole-line comments (shell, YAML, TOML, JS) describe commands, not run them.
const COMMENT_LINE = /^\s*(#|\/\/|\/?\*)/;

export function isAutomationFile(file) {
  const normalized = file.replaceAll("\\", "/");
  return AUTOMATION_FILE.test(normalized) && !SELF.has(normalized);
}

/** Findings ({ line, rule }) for one automation file's text. */
export function auditText(file, text) {
  const normalized = file.replaceAll("\\", "/");
  if (path.posix.basename(normalized) === "package.json") return auditPackageJson(normalized, text);
  const findings = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (COMMENT_LINE.test(line)) return;
    for (const rule of rulesFor(line)) findings.push({ line: i + 1, rule });
  });
  return findings;
}

function rulesFor(command) {
  const rules = [];
  if (CONFIG_BYPASS.test(command)) rules.push("drizzle-kit with connection/schema flags bypasses drizzle.config.ts and its push guard");
  else if (DRIZZLE_PUSH.test(command)) rules.push("direct drizzle-kit push; shared schemas change only through `db:migrate apply`");
  if (PUSH_SCRIPT_CALL.test(command)) rules.push("automation runs a schema push script; use `db:migrate apply`");
  return rules;
}

function auditPackageJson(file, text) {
  let scripts;
  try {
    scripts = JSON.parse(text).scripts ?? {};
  } catch {
    return [{ line: 1, rule: "package.json is not valid JSON; cannot audit scripts" }];
  }
  const lines = text.split(/\r?\n/);
  const lineOf = (name) => Math.max(1, lines.findIndex((l) => l.includes(`"${name}"`)) + 1);
  const findings = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (file === "lib/db/package.json" && GUARDED_SCRIPTS.has(name)) {
      if (command !== GUARDED_SCRIPTS.get(name))
        findings.push({ line: lineOf(name), rule: `lib/db "${name}" must be exactly \`${GUARDED_SCRIPTS.get(name)}\`` });
      continue;
    }
    for (const rule of rulesFor(String(command))) findings.push({ line: lineOf(name), rule: `script "${name}": ${rule}` });
  }
  for (const name of GUARDED_SCRIPTS.keys())
    if (file === "lib/db/package.json" && scripts[name] === undefined)
      findings.push({ line: 1, rule: `lib/db "${name}" script is missing (expected the guarded form)` });
  return findings;
}

/** Audits tracked and unignored automation files under `root`. */
export function auditRepository(root) {
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    maxBuffer: 1 << 28,
  })
    .toString()
    .split("\0")
    .filter(Boolean);
  const results = [];
  for (const file of [...new Set(files)].filter(isAutomationFile)) {
    let text;
    try {
      text = readFileSync(path.join(root, file), "utf8");
    } catch {
      continue; // deleted in the working tree
    }
    for (const finding of auditText(file, text)) results.push({ file, ...finding });
  }
  return results;
}

export function formatAuditFinding({ file, line, rule }) {
  return `${file}:${line}: ${rule}`;
}
