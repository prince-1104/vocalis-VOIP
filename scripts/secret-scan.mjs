// Detects committed credentials: database/cache URLs with an embedded password,
// high-confidence provider token formats, private keys and environment files.
// Findings carry file, line and a kind label only; the matched value is never
// returned or printed.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const URL_WITH_PASSWORD =
  /\b(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/([^\s:@/"'`]*):([^\s@"'`]+)@([^\s/"'`?#]+)/gi;

// Hosts that cannot resolve to a real server (RFC 2606/6761). Loopback is NOT
// exempt: a production server's own database is reachable as localhost.
const RESERVED_HOST = /(^|\.)(test|invalid|example)$|(^|\.)example\.(com|net|org)$/i;
// Template or documentation placeholders rather than a value.
const PLACEHOLDER = /^(\$\{[^}]*\}|\$[A-Z_][A-Z0-9_]*|<[^>]*>|\[[^\]]*\]|\{[^}]*\}|\*+|x+|password|pass|secret|changeme)$/i;
// Deliberately fake values in tests mark their line with this comment.
export const ALLOW_MARKER = "secret-scan: allow-fake";

// Formats specific enough that a match is almost certainly a real credential.
const TOKEN_PATTERNS = [
  ["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g],
  ["AWS access key ID", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["Stripe live key", /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g],
  ["OpenAI API key", /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})/g],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{40,}/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g],
  ["Twilio API key SID", /\bSK[0-9a-f]{32}\b/g],
  ["SendGrid API key", /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g],
];
// Documentation fillers ("sk-proj-xxxx…", "AKIA…EXAMPLE") are not credentials.
const FILLER = /EXAMPLE|(x|X|0|\*){8,}|(.)\3{11,}/;

// Synthetic fixtures that must look like credentials. Each entry is checked by
// deployment-safety.test.ts (the key belongs to a *.test certificate from the
// fake test CA), so the list cannot silently cover a real key.
export const SYNTHETIC_FIXTURES = new Set(["artifacts/api-server/test/fixtures/crm-tls/crm-key.pem"]);

// Committed environment files hold real configuration; templates are allowed.
const ENV_FILE = /(^|\/)\.env(\.[^/]+)?$/;
const ENV_TEMPLATE = /\.(example|sample|template|defaults)$/;

/** One finding ({ line, kind }) per credential in `text` that is not exempt. */
export function findSecrets(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(ALLOW_MARKER)) continue;
    if (line.includes("://")) {
      for (const match of line.matchAll(URL_WITH_PASSWORD)) {
        const [, scheme, , password, hostPort] = match;
        const host = hostPort.replace(/^\[|\](:\d+)?$/g, "").replace(/:\d+$/, "");
        if (PLACEHOLDER.test(password) || RESERVED_HOST.test(host)) continue;
        findings.push({ line: i + 1, kind: `${scheme.toLowerCase()}:// URL with an embedded password` });
      }
    }
    for (const [kind, pattern] of TOKEN_PATTERNS) {
      for (const match of line.matchAll(pattern)) {
        if (FILLER.test(match[0])) continue;
        findings.push({ line: i + 1, kind });
      }
    }
  }
  return findings;
}

/** Repository-relative path of a committed environment file, else null. */
export function environmentFileKind(file) {
  const normalized = file.replaceAll("\\", "/");
  return ENV_FILE.test(normalized) && !ENV_TEMPLATE.test(normalized) ? "environment file" : null;
}

function readText(full) {
  try {
    if (statSync(full).size > 5 * 1024 * 1024) return null;
    const buffer = readFileSync(full);
    return buffer.includes(0) ? null : buffer.toString("utf8");
  } catch {
    return null; // deleted in the working tree
  }
}

/**
 * Scans files git tracks plus untracked files that are not ignored (what the
 * next `git add -A` would commit). Binary and very large files are skipped.
 */
export function scanRepository(root) {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    maxBuffer: 1 << 28,
  })
    .toString()
    .split("\0")
    .filter(Boolean);
  const results = [];
  for (const file of [...new Set(listed)]) {
    if (SYNTHETIC_FIXTURES.has(file)) continue;
    const text = readText(path.join(root, file));
    if (text === null) continue;
    const envKind = environmentFileKind(file);
    if (envKind) results.push({ file, line: 1, kind: envKind });
    for (const finding of findSecrets(text)) results.push({ file, ...finding });
  }
  return results;
}

/**
 * Scans every line added by the commits in `range` (for example
 * `base..head`), so a credential added in one commit and removed in a later
 * one is still caught before it is merged into history.
 */
export function scanCommitRange(root, range) {
  const log = execFileSync(
    "git",
    ["log", "-p", "-U0", "--no-color", "--no-ext-diff", "--format=%x00commit %h", range],
    { cwd: root, maxBuffer: 1 << 30 },
  ).toString();
  const results = [];
  let commit = "";
  let file = null;
  let next = 0;
  for (const raw of log.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("\0commit ")) {
      commit = line.slice(8);
      file = null;
    } else if (line.startsWith("+++ ")) {
      file = line === "+++ /dev/null" ? null : line.slice(6);
      if (file && SYNTHETIC_FIXTURES.has(file)) file = null;
      if (file && environmentFileKind(file)) results.push({ commit, file, line: 1, kind: "environment file" });
    } else if (line.startsWith("@@")) {
      next = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
    } else if (file && line.startsWith("+")) {
      for (const finding of findSecrets(line.slice(1))) results.push({ commit, file, line: next, kind: finding.kind });
      next++;
    }
  }
  return results;
}

export function formatFinding({ commit, file, line, kind }) {
  return `${commit ? `${commit} ` : ""}${file}:${line}: ${kind} (value not shown)`;
}
