/**
 * ════════════════════════════════════════════════════════════════
 *  BBMP e-Khata Video Library Seed
 * ════════════════════════════════════════════════════════════════
 *
 * Loads the curated BBMP e-Khata YouTube short links into the BBMP
 * tenant's training_data table as type='video_link' rows. The widget
 * chat handler matches user questions against these entries and
 * appends the most relevant tutorial link to its reply.
 *
 * Usage:
 *   node scripts/seed-bbmp-videos.mjs
 *
 * Environment overrides:
 *   BASE_URL        (default: https://dialog.noeticminds.com)
 *   BBMP_EMAIL      (default: admin@bbmp)
 *   BBMP_PASSWORD   (default: admin@bbmp)
 *   BBMP_SLUG       (default: bbmp)
 *   PURGE=1         delete existing video_link rows before seeding
 * ════════════════════════════════════════════════════════════════
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env.BASE_URL || "https://dialog.noeticminds.com";
const BBMP_EMAIL = process.env.BBMP_EMAIL || "admin@bbmp";
const BBMP_PASSWORD = process.env.BBMP_PASSWORD || "admin@bbmp";
const BBMP_SLUG = process.env.BBMP_SLUG || "bbmp";
const PURGE = process.env.PURGE === "1";

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

async function api(method, p, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${p}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    throw new Error(`${method} ${p} → ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  console.log(c.bold("\n📺  BBMP e-Khata Video Library Seed\n"));
  console.log(c.dim(`   Target: ${BASE_URL}`));
  console.log(c.dim("─".repeat(60)));

  console.log(c.cyan("\n📌 Logging in as BBMP admin..."));
  const loginRes = await api("POST", "/api/auth/login", {
    email: BBMP_EMAIL,
    password: BBMP_PASSWORD,
    tenantSlug: BBMP_SLUG,
  });
  const token = loginRes.token;
  console.log(c.green(`   ✔ Authenticated as ${loginRes.user.email}`));

  const videosPath = path.join(__dirname, "bbmp-videos.json");
  const videos = JSON.parse(fs.readFileSync(videosPath, "utf-8"));
  console.log(c.cyan(`\n📌 Loaded ${videos.length} videos from ${path.basename(videosPath)}`));

  if (PURGE) {
    console.log(c.cyan("\n📌 Purging existing video_link rows..."));
    const existing = await api("GET", "/api/training", null, token);
    const stale = existing.filter((e) => e.type === "video_link");
    for (const e of stale) {
      await api("DELETE", `/api/training/${e.id}`, null, token);
    }
    console.log(c.dim(`   removed ${stale.length} old rows`));
  }

  // Skip videos already present (match by title).
  const existing = await api("GET", "/api/training", null, token);
  const existingTitles = new Set(
    existing.filter((e) => e.type === "video_link").map((e) => e.title.trim().toLowerCase())
  );

  console.log(c.cyan(`\n📌 Seeding ${videos.length} video link entries...`));
  let created = 0;
  let skipped = 0;
  for (const v of videos) {
    if (existingTitles.has(v.title.trim().toLowerCase())) {
      skipped++;
      console.log(c.dim(`   – skipped (exists): ${v.title}`));
      continue;
    }
    const content = JSON.stringify({
      title: v.title,
      link_en: v.link_en || "",
      link_kn: v.link_kn || "",
      search_terms: v.search_terms || [],
    });
    await api("POST", "/api/training", {
      type: "video_link",
      title: v.title,
      content,
    }, token);
    created++;
    console.log(c.green(`   ✔ ${v.title}`));
  }

  console.log(c.dim("\n─".repeat(60)));
  console.log(c.bold(`\n✅ Done. Created ${created}, skipped ${skipped} of ${videos.length} videos.\n`));
  if (skipped > 0 && !PURGE) {
    console.log(c.dim("   To replace existing entries, re-run with PURGE=1 node scripts/seed-bbmp-videos.mjs\n"));
  }
}

main().catch((err) => {
  console.error(c.red(`\n❌ Error: ${err.message}\n`));
  process.exit(1);
});
