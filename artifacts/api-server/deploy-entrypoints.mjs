// Every place that launches a built API file, resolved to a repository-relative
// path. The build fails when one of them is not produced (see build.mjs).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const API_DIR = "artifacts/api-server";

export function configuredEntrypoints(repoRoot) {
  const entries = [];
  const read = (file) => readFileSync(path.join(repoRoot, file), "utf8");

  // Replit production run command.
  const manifest = read(`${API_DIR}/.replit-artifact/artifact.toml`);
  const run = manifest.match(/\[services\.production\.run\][^[]*?args\s*=\s*\[([^\]]*)\]/);
  if (!run) throw new Error("artifact.toml has no [services.production.run] args");
  const args = [...run[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const script = args.find((arg) => /\.(c|m)?js$/.test(arg));
  if (!script) throw new Error("artifact.toml production run args name no script");
  entries.push({ source: "artifact.toml [services.production.run]", file: path.posix.normalize(script) });

  // package.json scripts that run built files.
  const pkg = JSON.parse(read(`${API_DIR}/package.json`));
  for (const [name, command] of Object.entries(pkg.scripts ?? {}))
    for (const m of String(command).matchAll(/(?:^|\s)\.\/(dist\/[^\s]+\.(?:c|m)?js)/g))
      entries.push({ source: `package.json scripts.${name}`, file: `${API_DIR}/${m[1]}` });

  // pm2 (absolute server path; compared from the API directory down).
  const ecosystem = read("ecosystem.config.cjs");
  for (const m of ecosystem.matchAll(/script:\s*["'][^"']*?(artifacts\/api-server\/dist\/[^"']+)["']/g))
    entries.push({ source: "ecosystem.config.cjs script", file: m[1] });

  return entries;
}

export function missingEntrypoints(repoRoot) {
  return configuredEntrypoints(repoRoot).filter((entry) => !existsSync(path.join(repoRoot, entry.file)));
}
