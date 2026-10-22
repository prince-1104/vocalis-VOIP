import { build } from "esbuild";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "dialog-security-tests-"));
const allSuites = [
  "vobiz-sip.test.ts",
  "monitoring.test.ts",
  "security.test.ts",
  "pii-logging.test.ts",
  "widget-verification.test.ts",
  "widget-verification-policy.test.ts",
  "twilio-webhooks.test.ts",
  "crm-ssrf.test.ts",
  "credential-encryption.test.ts",
  "rate-limit.test.ts",
  "http-security.test.ts",
  "widget-chat-security.test.ts",
  "campaign-dispatch.test.ts",
  "billing.test.ts",
  "migrations.test.ts",
  "deployment-safety.test.ts",
  "deployment-smoke.test.ts",
];
// Optional suite names on the command line run only those suites.
const requested = process.argv.slice(2);
const unknown = requested.filter((suite) => !allSuites.includes(suite));
if (unknown.length > 0) throw new Error(`Unknown test suite: ${unknown.join(", ")}`);
const suites = requested.length > 0 ? requested : allSuites;
// CI sets this: every PostgreSQL-gated test must run, so a missing or broken
// database configuration fails the run instead of turning tests into skips.
const requirePostgres = process.env.DIALOG_REQUIRE_POSTGRES === "1";
if (requirePostgres && !process.env.TEST_DATABASE_URL) {
  console.error("DIALOG_REQUIRE_POSTGRES=1 but TEST_DATABASE_URL is not set; refusing to run with database tests skipped.");
  process.exit(1);
}
const captureLogger = path.join(root, "test/capture-logger.ts");
try {
  await build({
    entryPoints: suites.map((suite) => path.join(root, "test", suite)),
    outdir: output,
    outExtension: { ".js": ".cjs" },
    platform: "node",
    format: "cjs",
    bundle: true,
    packages: "external",
    sourcemap: "inline",
    banner: {
      js: `require(${JSON.stringify(path.join(root, "test/setup.cjs"))});`,
    },
    plugins: [
      {
        name: "isolated-test-adapters",
        setup(builder) {
          builder.onResolve({ filter: /^@workspace\/db$/ }, () => ({
            path: path.join(root, "test/fake-db.ts"),
          }));
          // Pure modules (no connection at import); bundled from source.
          builder.onResolve({ filter: /^@workspace\/db\/migrations$/ }, () => ({
            path: path.resolve(root, "../../lib/db/src/migrations.ts"),
          }));
          builder.onResolve({ filter: /^@workspace\/api-zod$/ }, () => ({
            path: path.resolve(root, "../../lib/api-zod/src/index.ts"),
          }));
          builder.onResolve(
            { filter: /^@workspace\/integrations-openai-ai-server$/ },
            () => ({ path: path.join(root, "test/fake-ai.ts") }),
          );
          // Application imports of the logger receive the real Pino logger
          // writing to memory; the capture module itself loads the original.
          builder.onResolve({ filter: /(?:^|\/)logger$/ }, (args) =>
            path.resolve(args.importer) === captureLogger
              ? undefined
              : { path: captureLogger },
          );
          // Tenant CRM destinations use the production client with a fake
          // resolver and test CA; no test reaches real DNS or a real CRM.
          builder.onResolve({ filter: /(?:^|\/)crm-http$/ }, () => ({
            path: path.join(root, "test/fake-crm-http.ts"),
          }));
        },
      },
    ],
  });
  // Resolution stays in the API workspace even though test output is temporary.
  const env = {
    ...process.env,
    NODE_PATH: [
      path.join(root, "node_modules"),
      path.resolve(root, "../../lib/db/node_modules"),
      path.resolve(root, "../../node_modules"),
    ].join(path.delimiter),
    NODE_ENV: "test",
  };
  // Tests never inherit application credentials or the normal database URL.
  for (const key of Object.keys(env))
    if (
      /SECRET|TOKEN|PASSWORD|API_KEY|DATABASE_URL|MEDIA_SESSION_SIGNING_KEY|WIDGET_VERIFICATION_KEY|CREDENTIAL_|RATE_LIMIT_|TRUST_PROXY|DASHBOARD_ORIGINS|HSTS_/.test(
        key,
      ) &&
      key !== "TEST_DATABASE_URL"
    )
      delete env[key];
  env.JWT_SECRET = "fake-test-signing-key-never-use-in-production";
  env.MEDIA_SESSION_SIGNING_KEY = Buffer.alloc(32, 7).toString("base64");
  env.WIDGET_VERIFICATION_KEY = Buffer.alloc(32, 9).toString("base64");
  env.CREDENTIAL_ENCRYPTION_KEYS = `test1=${Buffer.alloc(32, 11).toString("base64")}`;
  env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID = "test1";
  env.PUBLIC_BASE_URL = "https://dialog.test";
  // Isolated in-process counters; the PostgreSQL store is exercised only
  // against TEST_DATABASE_URL.
  env.RATE_LIMIT_STORE = "memory";
  env.RATE_LIMIT_HASH_KEY = Buffer.alloc(32, 13).toString("base64");
  // Debug-level events are emitted too, so their redaction is inspected.
  env.LOG_LEVEL = "debug";
  // Human-readable results on stdout; a TAP copy is parsed for skips below.
  const tapFile = path.join(output, "results.tap");
  const child = spawn(
    process.execPath,
    [
      "--test",
      // Applies to each test file as a whole as well as each test; the
      // deployment smoke suite starts several real server processes.
      "--test-timeout=120000",
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=tap",
      `--test-reporter-destination=${tapFile}`,
      ...suites.map((suite) =>
        path.join(output, suite.replace(/\.ts$/, ".cjs")),
      ),
    ],
    { cwd: root, env, stdio: "inherit" },
  );
  const code = await new Promise((resolve) => child.once("exit", resolve));
  process.exitCode = typeof code === "number" ? code : 1;

  const tap = await readFile(tapFile, "utf8").catch(() => "");
  const skipped = [...tap.matchAll(/^\s*ok \d+ - (.*?) # (SKIP|TODO)\b(.*)$/gm)].map(
    (m) => `${m[1]} (${m[2].toLowerCase()}${m[3].trim() ? `: ${m[3].trim()}` : ""})`,
  );
  const count = (name) => Number(new RegExp(`^# ${name} (\\d+)$`, "m").exec(tap)?.[1] ?? NaN);
  const totals = { tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped"), cancelled: count("cancelled") };
  console.log(`\nTotals: ${JSON.stringify(totals)}`);
  if (skipped.length > 0) console.log(`Skipped tests (${skipped.length}):\n${skipped.map((s) => `  - ${s}`).join("\n")}`);
  if (!tap) {
    console.error("No test results were recorded.");
    process.exitCode = 1;
  } else if (requirePostgres && skipped.length > 0) {
    console.error(`DIALOG_REQUIRE_POSTGRES=1: ${skipped.length} test(s) skipped; every test must run.`);
    process.exitCode = 1;
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `### API test suite (${requirePostgres ? "PostgreSQL required" : "PostgreSQL optional"})`,
      "",
      `| tests | pass | fail | skipped | cancelled |`,
      `| --- | --- | --- | --- | --- |`,
      `| ${totals.tests} | ${totals.pass} | ${totals.fail} | ${totals.skipped} | ${totals.cancelled} |`,
      ...(skipped.length ? ["", "Skipped:", ...skipped.map((s) => `- ${s}`)] : []),
      "",
    ];
    await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"));
  }
} finally {
  await rm(output, { recursive: true, force: true });
}
