import type { RequestHandler } from "express";
import { monitorEventLoopDelay } from "node:perf_hooks";

// Fixed domains only. Never pass identifiers, free text or error messages here.
export const operations = ["call_setup", "transfer", "finalization", "stt", "llm", "tts", "usage", "usage_resolution", "reservation", "campaign", "stale_dispatch", "webhook_delivery", "webhook_job", "campaign_job", "overdue_job", "database_probe"] as const;
export type Operation = typeof operations[number];
export const providers = ["internal", "twilio", "exotel", "openai", "sarvam", "deepseek", "other"] as const;
type Provider = typeof providers[number];
export const outcomes = ["success", "error", "timeout", "blocked", "pending", "needs_reconciliation", "approaching_limit", "over_soft_limit"] as const;
type Outcome = typeof outcomes[number];
export function errorOutcome(error: unknown): "error" | "timeout" {
  try {
    const e = error as { name?: string; code?: string } | null;
    return e && (["TimeoutError", "APIConnectionTimeoutError"].includes(e.name ?? "") || ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(e.code ?? "")) ? "timeout" : "error";
  } catch { return "error"; }
}
const buckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
export const metricNames = ["dialog_http_requests_total", "dialog_http_duration_seconds", "dialog_http_rejections_total", "dialog_operations_total", "dialog_operation_duration_seconds", "dialog_media_sessions_active", "dialog_media_sessions_created_total", "dialog_media_disconnects_total", "dialog_job_last_success_seconds", "dialog_webhook_retry_batch_size", "dialog_webhook_retry_batch_delay_seconds", "dialog_process_uptime_seconds", "dialog_process_memory_bytes", "dialog_event_loop_delay_seconds", "dialog_db_pool_connections", "dialog_db_pool_exhausted", "dialog_db_connection_errors_total"] as const;
type MetricName = typeof metricNames[number];
type Sample = { name: MetricName; labels: Record<string, string>; value: number; histogram?: { count: number; sum: number; buckets: number[] } };
const allowedRoutes = new Set<string>();

export class OperationalMetrics {
  private samples = new Map<string, Sample>();
  // Optional sink is a test seam. Every caller is isolated from sink failures.
  constructor(private sink?: () => void) {}
  safe(work: () => void): void { try { this.sink?.(); work(); } catch { /* telemetry must never change business outcomes */ } }
  private sample(name: MetricName, labels: Record<string, string>): Sample {
    const key = JSON.stringify([name, labels]);
    let item = this.samples.get(key);
    if (!item) { item = { name, labels, value: 0 }; this.samples.set(key, item); }
    return item;
  }
  private count(name: MetricName, labels: Record<string, string>, value = 1) { this.sample(name, labels).value += value; }
  private observe(name: MetricName, labels: Record<string, string>, seconds: number) {
    const item = this.sample(name, labels);
    const h = item.histogram ??= { count: 0, sum: 0, buckets: buckets.map(() => 0) };
    h.count++; h.sum += seconds;
    buckets.forEach((bound, i) => { if (seconds <= bound) h.buckets[i]++; });
  }
  operation(operation: Operation, provider: Provider = "internal") {
    const started = performance.now();
    let ended = false;
    return (outcome: Outcome = "success") => this.safe(() => {
      if (ended) return;
      ended = true;
      if (!operations.includes(operation) || !providers.includes(provider) || !outcomes.includes(outcome)) return;
      const labels = { operation, provider, outcome };
      this.count("dialog_operations_total", labels);
      this.observe("dialog_operation_duration_seconds", labels, Math.max(0, performance.now() - started) / 1000);
      if (outcome === "success" && ["webhook_job", "campaign_job", "overdue_job"].includes(operation))
        this.sample("dialog_job_last_success_seconds", { operation }).value = Date.now() / 1000;
    });
  }
  async measure<T>(operation: Operation, work: () => Promise<T>, provider: Provider = "internal", result?: (value: T) => Outcome): Promise<T> {
    const finish = this.operation(operation, provider);
    try {
      const value = await work();
      let outcome: Outcome = "success";
      // Classification is also telemetry: it cannot change a successful result.
      try { outcome = result?.(value) ?? "success"; } catch { /* ignore classifier failure */ }
      finish(outcome); return value;
    } catch (error) {
      finish(errorOutcome(error));
      throw error;
    }
  }
  mediaSession(): () => void {
    let closed = false;
    this.safe(() => { this.count("dialog_media_sessions_created_total", {}); this.count("dialog_media_sessions_active", {}); });
    return () => this.safe(() => {
      if (closed) return; closed = true;
      this.count("dialog_media_sessions_active", {}, -1); this.count("dialog_media_disconnects_total", {});
    });
  }
  http(): RequestHandler {
    return (req, res, next) => {
      const started = performance.now(); let finished = false;
      const record = () => this.safe(() => {
        if (finished) return; finished = true;
        // Express's registered template, never originalUrl/baseUrl/params.
        const template: unknown = req.route?.path;
        let route = "unmatched";
        if (typeof template === "string" && template.length <= 100 && /^\/[A-Za-z0-9_/:.{}-]*$/.test(template)) {
          if (allowedRoutes.has(template) || allowedRoutes.size < 160) { allowedRoutes.add(template); route = template; }
          else route = "other";
        }
        const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(req.method) ? req.method : "OTHER";
        const status_class = res.writableFinished ? `${Math.floor(res.statusCode / 100)}xx` : "aborted";
        const labels = { route, method, status_class };
        this.count("dialog_http_requests_total", labels);
        this.observe("dialog_http_duration_seconds", labels, (performance.now() - started) / 1000);
        if ([401, 403, 429].includes(res.statusCode)) this.count("dialog_http_rejections_total", { reason: String(res.statusCode) });
      });
      res.once("finish", record); res.once("close", record); next();
    };
  }
  infrastructure(pool: { totalCount: number; idleCount: number; waitingCount: number; options?: { max?: number } }, eventLoopSeconds: number) {
    this.safe(() => {
      this.sample("dialog_process_uptime_seconds", {}).value = process.uptime();
      const memory = process.memoryUsage();
      for (const kind of ["rss", "heapUsed", "heapTotal", "external"] as const) this.sample("dialog_process_memory_bytes", { kind }).value = memory[kind];
      this.sample("dialog_event_loop_delay_seconds", { quantile: "0.99" }).value = eventLoopSeconds;
      for (const kind of ["total", "idle", "waiting", "max"] as const) this.sample("dialog_db_pool_connections", { kind }).value = kind === "max" ? pool.options?.max ?? 10 : pool[`${kind}Count`];
      this.sample("dialog_db_pool_exhausted", {}).value = pool.waitingCount > 0 && pool.idleCount === 0 && pool.totalCount >= (pool.options?.max ?? 10) ? 1 : 0;
    });
  }
  connectionError() { this.safe(() => this.count("dialog_db_connection_errors_total", {})); }
  retryBatch(deliveries: { nextRetryAt: Date | null }[]) {
    this.safe(() => {
      this.sample("dialog_webhook_retry_batch_size", {}).value = deliveries.length;
      this.sample("dialog_webhook_retry_batch_delay_seconds", {}).value = deliveries.reduce((max, d) => Math.max(max, d.nextRetryAt ? (Date.now() - d.nextRetryAt.getTime()) / 1000 : 0), 0);
    });
  }
  render(): string {
    const lines: string[] = [];
    const labelText = (labels: Record<string, string>) => Object.keys(labels).length ? `{${Object.entries(labels).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(",")}}` : "";
    for (const name of metricNames) {
      const histogram = name.includes("duration_seconds");
      const gauge = /active$|last_success_seconds$|uptime_seconds$|memory_bytes$|delay_seconds$|connections$|exhausted$|batch_size$/.test(name);
      lines.push(`# HELP ${name} Dialog aggregate operational measurement.`, `# TYPE ${name} ${histogram ? "histogram" : gauge ? "gauge" : "counter"}`);
      for (const item of this.samples.values()) {
        if (item.name !== name) continue;
        if (item.histogram) {
          const h = item.histogram;
          buckets.forEach((bound, i) => lines.push(`${name}_bucket${labelText({ ...item.labels, le: String(bound) })} ${h.buckets[i]}`));
          lines.push(`${name}_bucket${labelText({ ...item.labels, le: "+Inf" })} ${h.count}`, `${name}_sum${labelText(item.labels)} ${h.sum}`, `${name}_count${labelText(item.labels)} ${h.count}`);
        } else lines.push(`${name}${labelText(item.labels)} ${item.value}`);
      }
    }
    return lines.join("\n") + "\n";
  }
}

export const metrics = new OperationalMetrics();

// No new connections, queries or network requests. Disposed with the HTTP server.
export function startInfrastructureMonitoring(pool: Parameters<OperationalMetrics["infrastructure"]>[0] & { on(event: "error", listener: () => void): unknown; off(event: "error", listener: () => void): unknown }, registry = metrics) {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  const sample = () => registry.safe(() => {
    registry.infrastructure(pool, Number.isFinite(delay.percentile(99)) ? delay.percentile(99) / 1e9 : 0);
    delay.reset();
  });
  const onError = () => registry.safe(() => registry.connectionError());
  pool.on("error", onError);
  sample();
  const timer = setInterval(sample, 15_000); timer.unref();
  let disposed = false;
  return () => { if (disposed) return; disposed = true; clearInterval(timer); delay.disable(); pool.off("error", onError); };
}
