// Compares two voice latency benchmark reports (schema dialog-voice-latency/1).
// Usage: node scripts/voice-bench-compare.mjs <before.json> <after.json>
// Percentile changes are shown only when both runs have enough samples for that percentile.
import { readFile } from 'node:fs/promises';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) { console.error('Usage: node scripts/voice-bench-compare.mjs <before.json> <after.json>'); process.exit(1); }
const load = async file => {
  const report = JSON.parse(await readFile(file, 'utf8'));
  if (report.schema !== 'dialog-voice-latency/1') throw new Error(`Unsupported report schema in ${file}`);
  return report;
};
const [before, after] = await Promise.all([load(beforePath), load(afterPath)]);
if (before.providerMode !== after.providerMode) throw new Error('Refusing to compare mock and manual-live results.');

const fmt = v => v === null || v === undefined ? 'n/a' : String(v);
const delta = (a, b) => {
  if (typeof a !== 'number' || typeof b !== 'number') return 'n/a';
  const abs = b - a, rel = a === 0 ? null : Math.round((abs / a) * 1000) / 10;
  return `${abs >= 0 ? '+' : ''}${abs}${rel === null ? '' : ` (${rel >= 0 ? '+' : ''}${rel}%)`}`;
};
const lines = [`# Voice latency comparison (${before.providerMode})`, '',
  `- Before: ${before.label} @ ${before.timestamp}`, `- After: ${after.label} @ ${after.timestamp}`,
  `- Tuning before: ${JSON.stringify(before.configuration.tuning)}`, `- Tuning after: ${JSON.stringify(after.configuration.tuning)}`,
  `- Iterations before: ${JSON.stringify(before.configuration.iterations)}`, `- Iterations after: ${JSON.stringify(after.configuration.iterations)}`,
  '- Percentiles require 5/10/20 samples (p50/p90/p95); "n/a" means insufficient samples, not zero.', ''];
for (const name of [...new Set([...Object.keys(before.cases), ...Object.keys(after.cases)])]) {
  const b = before.cases[name], a = after.cases[name];
  lines.push(`## ${name}`, '', `Outcomes before: ${JSON.stringify(b?.outcomes ?? {})}`, '', `Outcomes after: ${JSON.stringify(a?.outcomes ?? {})}`, '');
  const counts = c => c ? `llm_start=${c.llm_start ?? 0}, llm_cancelled=${c.llm_cancelled ?? 0}, tts_start=${c.tts_start ?? 0}, tts_cancelled=${c.tts_cancelled ?? 0}, tts_no_audio=${c.tts_no_audio ?? 0}` : 'n/a';
  lines.push(`Work before: ${counts(b?.workerEventCounts)}`, '', `Work after: ${counts(a?.workerEventCounts)}`, '');
  lines.push('| Metric | n before | n after | p50 before | p50 after | Δp50 | p90 before | p90 after | Δp90 | p95 before | p95 after | Δp95 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const key of [...new Set([...Object.keys(b?.metrics ?? {}), ...Object.keys(a?.metrics ?? {})])]) {
    const x = b?.metrics?.[key] ?? {}, y = a?.metrics?.[key] ?? {};
    lines.push(`| ${key} | ${fmt(x.n ?? 0)} | ${fmt(y.n ?? 0)} | ${fmt(x.p50)} | ${fmt(y.p50)} | ${delta(x.p50, y.p50)} | ${fmt(x.p90)} | ${fmt(y.p90)} | ${delta(x.p90, y.p90)} | ${fmt(x.p95)} | ${fmt(y.p95)} | ${delta(x.p95, y.p95)} |`);
  }
  lines.push('');
}
console.log(lines.join('\n'));
