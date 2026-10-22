import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPrivateKey, X509Certificate } from "node:crypto";
import {
  ALLOW_MARKER,
  environmentFileKind,
  findSecrets,
  formatFinding,
  scanCommitRange,
  scanRepository,
  SYNTHETIC_FIXTURES,
} from "../../../scripts/secret-scan.mjs";
import { auditRepository, auditText, formatAuditFinding, isAutomationFile } from "../../../scripts/schema-push-audit.mjs";
import { configuredEntrypoints, missingEntrypoints } from "../deploy-entrypoints.mjs";
import { classifyPushTarget, isPushCommand } from "../../../lib/db/src/push-guard";

const repoRoot = path.resolve("../..");
// Assembled at runtime so this file itself holds no credentialed URL literal.
const SECRET = ["s3cr3t", "Value", "9921"].join("");
const urlWith = (host: string, password = SECRET, scheme = "postgresql") => `${scheme}://svc_user:${password}@${host}/appdb`;

// ── Committed credential detection ───────────────────────────────────────────

// Realistic-looking fakes, assembled at runtime so no literal sits in this file.
const fakeTokens: [string, string][] = [
  ["GitHub token", "ghp_" + "a1B2c3D4e5F6g7H8i9J0".repeat(2)],
  ["AWS access key ID", "AKIA" + "Q7RZ" + "M2NP" + "4KXW" + "8TYB"],
  ["Stripe live key", "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc"],
  ["OpenAI API key", "sk-" + "proj-" + "Zq8".repeat(16)],
  ["Anthropic API key", "sk-" + "ant-" + "api03-" + "Kp7".repeat(15)],
  ["Google API key", "AIza" + "SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY"],
  ["Slack token", "xox" + "b-" + "2048-1234567890-abcdEFGHijkl"],
  ["Twilio API key SID", "SK" + "0f3c9a7d2b".repeat(3) + "e1"],
  ["private key", "-----BEGIN " + "RSA PRIVATE KEY-----"],
];

test("Secret scan: credentialed URLs and provider tokens are found by line without exposing the value", () => {
  const text = [
    "const ok = process.env.DATABASE_URL;",
    `const remote = "${urlWith("monorail.proxy.rlwy.net:41234")}";`,
    `const vps = '${urlWith("localhost:5432")}';`, // loopback is not exempt
    `REDIS=${urlWith("cache.internal", SECRET, "rediss")}`,
    ...fakeTokens.map(([, token]) => `const key = "${token}";`),
  ].join("\n");
  const findings = findSecrets(text);
  assert.deepEqual(findings, [
    { line: 2, kind: "postgresql:// URL with an embedded password" },
    { line: 3, kind: "postgresql:// URL with an embedded password" },
    { line: 4, kind: "rediss:// URL with an embedded password" },
    ...fakeTokens.map(([kind], i) => ({ line: 5 + i, kind })),
  ]);
  const values = [SECRET, ...fakeTokens.map(([, token]) => token)];
  for (const f of findings) {
    const shown = JSON.stringify(f) + formatFinding({ file: "x.mjs", ...f });
    for (const value of values) assert.ok(!shown.includes(value), "a finding never contains the value");
  }
});

test("Secret scan: reserved test hosts, placeholders, fillers and marked fakes are exempt", () => {
  for (const [i, line] of [
    `"${urlWith("db.internal.test:5432")}"`,
    `"${urlWith("db.example.com")}"`,
    `"${urlWith("db.prod", "${DB_PASSWORD}")}"`,
    `"${urlWith("db.prod", "<password>")}"`,
    `"${urlWith("db.prod", "****")}"`,
    `"${urlWith("127.0.0.1:1")}" // ${ALLOW_MARKER}`,
    "postgres://user@localhost/db (no password)",
    "OPENAI_API_KEY=sk-" + "proj-" + "x".repeat(48),
    "aws_access_key_id = AKIA" + "IOSFODNN7" + "EXAMPLE",
    `const token = "${fakeTokens[0][1]}"; // ${ALLOW_MARKER}`,
    "twilio account SID AC" + "0".repeat(32) + " is an identifier, not a credential",
  ].entries())
    assert.deepEqual(findSecrets(line), [], `exempt case ${i}`);
  assert.equal(environmentFileKind(".env"), "environment file");
  assert.equal(environmentFileKind("artifacts/api-server/.env.production"), "environment file");
  assert.equal(environmentFileKind(".env.example"), null);
  assert.equal(environmentFileKind("src/environment.ts"), null);
});

test("Secret scan: the repository (tracked and unignored files) holds no committed credentials", () => {
  const findings = scanRepository(repoRoot);
  assert.deepEqual(findings.map(formatFinding), []);
});

test("Secret scan: each synthetic fixture exemption is a key for a *.test certificate from the fake test CA", async () => {
  assert.deepEqual([...SYNTHETIC_FIXTURES], ["artifacts/api-server/test/fixtures/crm-tls/crm-key.pem"]);
  const dir = path.join(repoRoot, "artifacts/api-server/test/fixtures/crm-tls");
  const cert = new X509Certificate(await readFile(path.join(dir, "crm.pem")));
  const ca = new X509Certificate(await readFile(path.join(dir, "ca.pem")));
  assert.ok(cert.checkPrivateKey(createPrivateKey(await readFile(path.join(dir, "crm-key.pem")))));
  assert.ok(cert.verify(ca.publicKey), "issued by the fake test CA");
  assert.match(ca.subject, /Fake Test CA/);
  for (const name of cert.subjectAltName!.split(", ")) assert.match(name, /^DNS:[a-z.]+\.test$/);
});

async function scratchRepo() {
  const repo = await mkdtemp(path.join(tmpdir(), "dialog-secret-scan-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=ci", "-c", "user.email=ci@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
  git("init", "-q");
  await mkdir(path.join(repo, "scripts"));
  for (const file of ["secret-scan.mjs", "check-secrets.mjs"])
    await cp(path.join(repoRoot, "scripts", file), path.join(repo, "scripts", file));
  return { repo, git };
}

test("Secret scan: a newly added file or .env is caught; ignored files are not; the CLI output omits values", async () => {
  const { repo } = await scratchRepo();
  try {
    await writeFile(path.join(repo, ".gitignore"), "ignored.mjs\n");
    await writeFile(path.join(repo, "check.mjs"), `const url = "${urlWith("db.prod.internal")}";\n`);
    await writeFile(path.join(repo, "ignored.mjs"), `const url = "${urlWith("db.prod.internal")}";\n`);
    await writeFile(path.join(repo, ".env"), `GITHUB_TOKEN=${fakeTokens[0][1]}\n`);
    const findings = scanRepository(repo);
    assert.deepEqual(findings, [
      { file: ".env", line: 1, kind: "environment file" },
      { file: ".env", line: 1, kind: "GitHub token" },
      { file: "check.mjs", line: 1, kind: "postgresql:// URL with an embedded password" },
    ]);
    const result = await run(process.execPath, ["scripts/check-secrets.mjs"], { cwd: repo });
    assert.equal(result.code, 1);
    assert.match(result.output, /check\.mjs:1: postgresql:\/\/ URL with an embedded password \(value not shown\)/);
    assert.ok(!result.output.includes(SECRET) && !result.output.includes(fakeTokens[0][1]));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("Secret scan: --range catches a credential added and then removed within the commits under review", async () => {
  const { repo, git } = await scratchRepo();
  try {
    await writeFile(path.join(repo, "app.mjs"), "export const ok = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    await writeFile(path.join(repo, "app.mjs"), `export const ok = 1;\nconst key = "${fakeTokens[1][1]}";\n`);
    git("commit", "-q", "-am", "add");
    await writeFile(path.join(repo, "app.mjs"), "export const ok = 1;\n");
    git("commit", "-q", "-am", "remove");

    assert.deepEqual(scanRepository(repo), [], "the current tree is clean");
    const added = scanCommitRange(repo, `${base}..HEAD`);
    assert.equal(added.length, 1);
    assert.deepEqual({ ...added[0], commit: undefined }, { commit: undefined, file: "app.mjs", line: 2, kind: "AWS access key ID" });
    const result = await run(process.execPath, ["scripts/check-secrets.mjs", "--range", `${base}..HEAD`], { cwd: repo });
    assert.equal(result.code, 1);
    assert.match(result.output, /added in commit [0-9a-f]+ app\.mjs:2: AWS access key ID \(value not shown\)/);
    assert.ok(!result.output.includes(fakeTokens[1][1]));
    const bad = await run(process.execPath, ["scripts/check-secrets.mjs", "--range", "HEAD; echo"], { cwd: repo });
    assert.equal(bad.code, 64, "malformed ranges are refused");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ── Schema-push audit of repository automation ───────────────────────────────

test("Push audit: repository automation contains no unguarded schema push", () => {
  assert.deepEqual(auditRepository(repoRoot).map(formatAuditFinding), []);
});

test("Push audit: direct, flag-bypassing and scripted pushes in automation are flagged", () => {
  const rules = (file: string, text: string) => auditText(file, text).map((f) => f.rule);
  assert.match(rules("scripts/post-merge.sh", "npx drizzle-kit push --force")[0], /direct drizzle-kit push/);
  assert.match(rules("deploy.sh", "pnpm exec drizzle-kit push --url \"$DATABASE_URL\"")[0], /bypasses drizzle\.config\.ts/);
  assert.match(rules(".github/workflows/x.yml", "      - run: pnpm --filter @workspace/db run push")[0], /schema push script/);
  assert.match(rules(".replit", 'args = ["pnpm", "--filter", "db", "push-force"]').join(), /schema push script/);
  assert.match(rules("scripts/setup.mjs", 'execSync("drizzle-kit push --dialect postgresql")')[0], /bypasses/);
  assert.match(
    rules("artifacts/api-server/package.json", JSON.stringify({ scripts: { reset: "pnpm -C ../../lib/db push-force" } }))[0],
    /script "reset": automation runs a schema push script/,
  );
  assert.match(
    rules("lib/db/package.json", JSON.stringify({ scripts: { push: "drizzle-kit push --url $DATABASE_URL", "push-force": "drizzle-kit push --force --config ./drizzle.config.ts" } }))[0],
    /must be exactly/,
  );
  assert.deepEqual(rules("lib/db/package.json", JSON.stringify({ scripts: { generate: "drizzle-kit generate" } })).length, 2, "guarded scripts must exist");
  // Not pushes: comments, git push, migrations, drizzle-kit generate, the guarded definitions.
  assert.deepEqual(rules("scripts/post-merge.sh", "# a database built with `drizzle-kit push` must be adopted"), []);
  assert.deepEqual(rules(".github/workflows/x.yml", "on:\n  push:\n    branches: [main]\n      - run: git push origin HEAD"), []);
  assert.deepEqual(rules("scripts/post-merge.sh", "pnpm --filter @workspace/api-server run db:migrate apply"), []);
  assert.deepEqual(rules(".github/workflows/ci.yml", "        run: pnpm run check:schema-push"), []);
  assert.deepEqual(rules("lib/db/package.json", JSON.stringify({ scripts: {
    push: "drizzle-kit push --config ./drizzle.config.ts",
    "push-force": "drizzle-kit push --force --config ./drizzle.config.ts",
    generate: "drizzle-kit generate --config ./drizzle.config.ts",
  } })), []);
  assert.equal(isAutomationFile("docs/production-readiness/x.md"), false);
  assert.equal(isAutomationFile(".github/workflows/ci.yml"), true);
});

test("Push audit: the CLI fails on a newly introduced unguarded push", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "dialog-push-audit-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    await mkdir(path.join(repo, "scripts"));
    for (const file of ["schema-push-audit.mjs", "check-schema-push.mjs"])
      await cp(path.join(repoRoot, "scripts", file), path.join(repo, "scripts", file));
    const clean = await run(process.execPath, ["scripts/check-schema-push.mjs"], { cwd: repo });
    assert.equal(clean.code, 0, clean.output);
    await writeFile(path.join(repo, "scripts/reset-db.sh"), "#!/bin/sh\ndrizzle-kit push --url \"$DATABASE_URL\" --force\n");
    const result = await run(process.execPath, ["scripts/check-schema-push.mjs"], { cwd: repo });
    assert.equal(result.code, 1);
    assert.match(result.output, /scripts\/reset-db\.sh:2: drizzle-kit with connection\/schema flags bypasses/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ── Deployment entrypoints ───────────────────────────────────────────────────

test("Entrypoints: Replit, package scripts and pm2 all launch files the build produces", async () => {
  const entries = configuredEntrypoints(repoRoot);
  const replit = entries.find((e) => e.source.startsWith("artifact.toml"));
  assert.equal(replit?.file, "artifacts/api-server/dist/index.cjs");
  assert.equal(entries.find((e) => e.source === "package.json scripts.start")?.file, replit?.file);
  assert.equal(entries.find((e) => e.source === "ecosystem.config.cjs script")?.file, replit?.file);
  const build = await readFile(path.join(repoRoot, "artifacts/api-server/build.mjs"), "utf8");
  for (const entry of entries) {
    const base = path.posix.basename(entry.file).replace(/\.cjs$/, ".ts");
    assert.ok(build.includes(`src/${base}`), `${entry.file} has a build entry point`);
    assert.match(build, /outExtension: \{ "\.js": "\.cjs" \}/);
  }
});

test("Entrypoints: a manifest naming a file the build does not emit is reported", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dialog-entry-"));
  try {
    const api = path.join(root, "artifacts/api-server");
    await mkdir(path.join(api, ".replit-artifact"), { recursive: true });
    await mkdir(path.join(api, "dist"));
    await writeFile(path.join(api, "dist/index.cjs"), "");
    const manifest = await readFile(path.join(repoRoot, "artifacts/api-server/.replit-artifact/artifact.toml"), "utf8");
    await writeFile(path.join(api, ".replit-artifact/artifact.toml"), manifest.replace("dist/index.cjs", "dist/index.mjs"));
    await writeFile(path.join(api, "package.json"), JSON.stringify({ scripts: { start: "node ./dist/index.cjs" } }));
    await writeFile(path.join(root, "ecosystem.config.cjs"), `script: "/srv/app/artifacts/api-server/dist/index.cjs",`);
    assert.deepEqual(missingEntrypoints(root).map((m) => m.file), ["artifacts/api-server/dist/index.mjs"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const built = existsSync(path.join(repoRoot, "artifacts/api-server/dist"));
test(
  "Entrypoints: the produced build contains every configured entrypoint",
  { skip: !built && "artifacts/api-server/dist not built; run the API build first" },
  () => {
    assert.deepEqual(missingEntrypoints(repoRoot), []);
  },
);

// ── Schema push guard ────────────────────────────────────────────────────────

// Credentials are irrelevant to the guard, so these URLs carry a user only.
test("Push guard: only confirmed loopback dialog_test_/dialog_scratch_ databases are allowed", () => {
  const local = "postgres://dev@127.0.0.1:5432/dialog_test_local1";
  assert.deepEqual(classifyPushTarget({ DATABASE_URL: local, DIALOG_SCHEMA_PUSH_DATABASE: "dialog_test_local1" }), {
    allowed: true,
    database: "dialog_test_local1",
  });
  assert.equal(
    classifyPushTarget({ DATABASE_URL: "postgresql://localhost/dialog_scratch_a", DIALOG_SCHEMA_PUSH_DATABASE: "dialog_scratch_a" }).allowed,
    true,
  );
  assert.equal(
    classifyPushTarget({ DATABASE_URL: "postgres://u@[::1]:5432/dialog_test_v6", DIALOG_SCHEMA_PUSH_DATABASE: "dialog_test_v6" }).allowed,
    true,
  );

  const refused: [Record<string, string | undefined>, RegExp][] = [
    [{}, /not set/],
    [{ DATABASE_URL: "not a url" }, /not a valid URL/],
    [{ DATABASE_URL: "mysql://u@127.0.0.1/dialog_test_a" }, /not a postgres/],
    [{ DATABASE_URL: "postgres:///dialog_test_a" }, /no explicit host/],
    [{ DATABASE_URL: "postgres://u@monorail.proxy.rlwy.net:41234/railway" }, /not loopback/],
    [{ DATABASE_URL: "postgres://u@10.0.0.5/dialog_test_a" }, /not loopback/],
    [{ DATABASE_URL: "postgres://u@127.0.0.2/dialog_test_a" }, /not loopback/],
    [{ DATABASE_URL: "postgres://u@localhost.attacker.example/dialog_test_a" }, /not loopback/],
    [{ DATABASE_URL: "postgres://u@localhost/dialog_test_a?host=db.prod.example", DIALOG_SCHEMA_PUSH_DATABASE: "dialog_test_a" }, /query parameters/],
    [{ DATABASE_URL: "postgres://u@localhost/dialog_test_a?sslmode=disable" }, /query parameters/],
    // A production server's own database is local too: the name decides.
    [{ DATABASE_URL: "postgres://u@localhost:5432/dialog", DIALOG_SCHEMA_PUSH_DATABASE: "dialog" }, /approved throwaway/],
    [{ DATABASE_URL: "postgres://u@localhost:5432/neondb" }, /approved throwaway/],
    [{ DATABASE_URL: "postgres://u@localhost:5432/dialog_test_UPPER" }, /approved throwaway/],
    [{ DATABASE_URL: "postgres://u@localhost:5432/dialog_test_a%00b" }, /approved throwaway/],
    [{ DATABASE_URL: "postgres://u@localhost:5432/dialog_test_a" }, /DIALOG_SCHEMA_PUSH_DATABASE/],
    [{ DATABASE_URL: "postgres://u@localhost:5432/dialog_test_a", DIALOG_SCHEMA_PUSH_DATABASE: "dialog_test_b" }, /DIALOG_SCHEMA_PUSH_DATABASE/],
    [{ DATABASE_URL: "postgres://u@localhost:5432/dialog_test_a", DIALOG_SCHEMA_PUSH_DATABASE: "dialog_test_a", NODE_ENV: "production" }, /production/],
  ];
  for (const [env, reason] of refused) {
    const decision = classifyPushTarget(env);
    assert.equal(decision.allowed, false, JSON.stringify(env));
    assert.match((decision as { reason: string }).reason, reason);
    assert.ok(!(decision as { reason: string }).reason.includes("@"), "reason never echoes the URL");
  }
  assert.equal(isPushCommand(["node", "drizzle-kit", "push", "--force"]), true);
  assert.equal(isPushCommand(["node", "drizzle-kit", "generate"]), false);
  assert.equal(isPushCommand(["node", "drizzle-kit", "migrate", "--config", "push"]), true, "ambiguous is treated as push");
});

const drizzleKit = path.join(repoRoot, "lib/db/node_modules/drizzle-kit/bin.cjs");
const dbDir = path.join(repoRoot, "lib/db");

test("Push guard: `drizzle-kit push` through the package config refuses before connecting and never prints the URL", async () => {
  for (const [script, env] of [
    // Unresolvable reserved hosts: a refusal that reached the network would show ENOTFOUND.
    ["push", { DATABASE_URL: urlWith("db.shared.test:5432") }],
    ["push-force", { DATABASE_URL: `postgres://svc_user:${SECRET}@localhost:1/dialog`, DIALOG_SCHEMA_PUSH_DATABASE: "dialog" }],
    ["push", { DATABASE_URL: `postgres://svc_user:${SECRET}@localhost:1/dialog_test_unconfirmed` }],
  ] as const) {
    const args = ["push", ...(script === "push-force" ? ["--force"] : []), "--config", "./drizzle.config.ts"];
    const result = await run(process.execPath, [drizzleKit, ...args], { cwd: dbDir, env: { ...process.env, NODE_ENV: "development", ...env } });
    assert.equal(result.code, 2, result.output);
    assert.match(result.output, /Refusing drizzle-kit push/);
    assert.doesNotMatch(result.output, /Pulling schema|ENOTFOUND|ECONNREFUSED/);
    assert.ok(!result.output.includes(SECRET));
  }
  const pkg = JSON.parse(await readFile(path.join(dbDir, "package.json"), "utf8"));
  for (const name of ["push", "push-force"]) assert.match(pkg.scripts[name], /--config \.\/drizzle\.config\.ts/);
  // Generation never connects and stays available.
  const generate = await run(process.execPath, [drizzleKit, "generate", "--config", "./drizzle.config.ts"], {
    cwd: dbDir,
    env: { ...process.env, DATABASE_URL: "postgres://placeholder@127.0.0.1:1/none" },
  });
  assert.equal(generate.code, 0, generate.output);
  assert.match(generate.output, /No schema changes/);
});

// ── helpers ──────────────────────────────────────────────────────────────────

function spawnCollect(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, exit, output: () => output };
}

async function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  const p = spawnCollect(command, args, options);
  const code = await p.exit;
  return { code, output: p.output() };
}
