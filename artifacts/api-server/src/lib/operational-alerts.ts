import { metricNames } from "./operational-metrics";

// Vendor-neutral decision catalogue, NOT a running alert evaluator. A deployment
// must provide collection, rate/reset handling, evaluation and notification.
export const alertCatalogue = [
  { id: "api_errors", signals: ["dialog_http_requests_total"], severity: "critical", window: "5m, persistent 5m", rule: "5xx / completed requests > 5%, at least 100 requests; exclude health and metrics templates", response: "Check readiness, recent rollout and redacted error categories." },
  { id: "api_latency", signals: ["dialog_http_duration_seconds"], severity: "warning", window: "10m, persistent 10m", rule: "p95 > 1s, at least 100 completed API requests; exclude health, metrics, static assets and streaming routes", response: "Compare pool wait, event-loop delay and named provider operation latency." },
  { id: "health", signals: [], external: "Independent probes of /api/healthz and /api/readyz", severity: "critical", window: "30s probes, 3 consecutive failures", rule: "Non-200 or response timeout; probe instances separately from public ingress", response: "Distinguish dead process from unavailable database/schema; avoid restart loops for database outages." },
  { id: "database", signals: ["dialog_db_pool_exhausted", "dialog_db_connection_errors_total", "dialog_operations_total"], severity: "critical", window: "2m", rule: "Pool exhausted throughout 2m, or >=3 idle connection errors / 5m, or >=3 completed database_probe errors / 5m; health also detects probes that never finish", response: "Check database availability, pool waits, connection budget and schema status before scaling." },
  { id: "call_setup", signals: ["dialog_operations_total"], severity: "warning", window: "5m, persistent 5m", rule: "call_setup error or timeout / all call_setup attempts >10%, at least 20 attempts; blocked attempts tracked separately", response: "Check provider status through approved operator tooling, configuration and suppression/budget decisions." },
  { id: "voice_timeout", signals: ["dialog_operations_total"], severity: "warning", window: "5m, persistent 5m", rule: "stt/llm/tts timeout >=3 per provider; no customer labels", response: "Compare bounded provider outcomes and latency; inspect redacted logs; do not weaken authorization or spend limits." },
  { id: "finalization", signals: ["dialog_operations_total"], severity: "critical", window: "5m, evaluate every 30s", rule: "finalization error or timeout >=1", response: "Inspect persisted call and media states using authorized tools; reconcile provider evidence and usage; never blindly finalize/redial." },
  { id: "usage", signals: ["dialog_operations_total"], severity: "critical", window: "5m, evaluate every 30s", rule: "usage or usage_resolution error/timeout >=1; warning for needs_reconciliation >=3 attempts / 10m", response: "Review reconciliation dashboard, rate cards and database health; pending/unknown usage is not zero and must not be silently invoiced." },
  { id: "workers", signals: ["dialog_operations_total", "dialog_job_last_success_seconds", "dialog_process_uptime_seconds"], severity: "warning", window: "5m errors; 3 worker periods for freshness", rule: "webhook_job/campaign_job/overdue_job errors >=3 / 5m; or last success older than 3 periods (30s/15s/24h), including absent success after process uptime exceeds 3 periods", response: "Check worker exceptions and database; success denotes polling completion, not successful delivery of every item." },
  { id: "retry_delay", signals: ["dialog_webhook_retry_batch_delay_seconds", "dialog_webhook_retry_batch_size"], severity: "warning", window: "10m persistent", rule: "Observed retry batch delay >300s and batch size =50; indicative saturation, not total backlog", response: "Inspect authorized delivery statuses and receiver availability; avoid replaying already delivered work." },
  { id: "spend", signals: ["dialog_operations_total"], severity: "warning", window: "10m, evaluate every minute", rule: "reservation approaching_limit/over_soft_limit/blocked >=3 attempts; approaching_limit uses existing 80% policy, no new financial limit", response: "Review configured tenant limits in authorized dashboards; repeated attempts do not imply distinct tenants." },
  { id: "runtime", signals: ["dialog_event_loop_delay_seconds", "dialog_process_memory_bytes"], severity: "warning", window: "5m persistent", rule: "event-loop p99 >0.2s; memory alert requires deployment memory limit before choosing threshold", response: "Check CPU pressure, heap/RSS trend and workload before restarting or changing resource limits." },
  { id: "backup", signals: [], external: "Verified backup-system completion timestamp, failure result and restore verification", severity: "critical", window: "Owner-approved schedule plus documented grace", rule: "Reported backup failure, missed expected completion or restore verification overdue; blocked until evidence source and policy configured", response: "Contact the designated backup owner once assigned; preserve last known good backup; verify restore in isolation." },
] as const;

// Applies to every rule; operators must supply these before enabling evaluation.
export const alertDelivery = {
  state: "unconfigured",
  destination: null,
  owner: null,
  required: ["approved notification destination", "recipient and escalation owner", "collector and evaluator", "threshold validation", "safe payload and deduplication policy"],
} as const;

export function validateAlertCatalogue(): boolean {
  return alertCatalogue.every(rule => rule.signals.every(signal => (metricNames as readonly string[]).includes(signal)) &&
    (rule.signals.length > 0 || "external" in rule));
}
