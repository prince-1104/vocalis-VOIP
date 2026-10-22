# Phase 1O — Monitoring, alerting and disaster recovery

## Status and scope

Instrumentation is implemented in the repository. Local verification results are recorded below. External alert delivery is **unconfigured**; collection, retention, dashboards, notification destinations and escalation ownership have not been established. Production instrumentation, alert delivery and recovery have **not been verified**. A real restore drill remains outstanding. This document does not certify production readiness.

No production database, migration, provider request, restore, backup, notification or external resource was invoked for this phase. No new vendor, dependency or credential was introduced. Existing test-runner fixtures are reused; no new credential fixtures are added.

## Audit and existing controls

* Pino and pino-http already provide centralized structured logging and recursive secret/PII redaction (`logger.ts`, `log-redaction.ts`, `http-logger.ts`). Safe HTTP serializers remove URL queries; centralized exception handling and process error handlers already exist. These remain the logging boundary. No tracing collector, error-reporting integration, metrics backend, dashboard or operational notification destination was found.
* `/api/healthz` returns `{ "status": "ok" }` without a database/provider check. `/api/readyz` distinguishes startup/blocked/unavailable from ready. Startup checks migration history and required schema before listening or starting workers; it never applies migrations. Those contracts are preserved.
* The existing shared PostgreSQL pool is used by the application. Previously there were no aggregate pool-pressure metrics. The former readiness response timeout released its single-flight guard before the underlying query settled, allowing accumulating queries during a stall.
* Campaign polling runs every 15 seconds; webhook retries every 30 seconds with at most 50 due rows per batch; overdue invoices are checked at startup and every 24 hours. There is no separate queue broker. Campaign reconciliation already uses conditional state transitions, and usage/reservations already use the durable ledger. This phase does not change their retry, locking, delivery, charging or reconciliation policy.
* PM2 configuration runs one fork, restarts with a 3-second delay and a maximum of 10 restarts; no confirmed memory ceiling, log retention/export policy or backup policy was found. Replit's artifact declares `/api/healthz`; readiness-based traffic routing is not confirmed. CI provides build/security checks and a PostgreSQL test service, rather than production monitoring or backups. Hosted database backup coverage cannot be inferred from those files.

## Implemented health behavior

Readiness caches database results for one second and has a two-second response deadline. It validates the `select 1 as ready` response shape. At most one underlying database/schema probe remains outstanding per instance, including after a timeout; no replacement probes are queued while it is unresolved. The public route has an additional 2.5-second deadline, catches exceptions and whitelists diagnostic statuses. Public responses contain no dependency details. Liveness remains independent.

After successful startup, required schema compatibility is inspected again at most once per 60 seconds, within the same probe/deadline. A failed schema check keeps readiness unavailable until a later compatible check succeeds. Runtime schema changes can therefore take approximately 61 seconds to be noticed, plus probe completion; startup checks remain immediate. The health deadline does not cancel PostgreSQL work. A permanently stuck probe remains unavailable until it settles or the process is replaced; its outstanding work is bounded to one probe chain. Operators must configure database-side statement/connection limits under the deployment's existing policy, rather than changing business-query timeouts here.

Readiness is a database/schema gate, not a promise that every provider or the shared rate-limit store is healthy. Existing fail-closed rate limiting remains in force when its store is unavailable. Configure ingress to withdraw unready instances without restarting them for a database outage. Keep supervisor liveness separate.

## Metrics and access contract

`GET /api/superadmin/metrics` exports standard text counters, gauges and histograms. It is mounted after existing `resolveUser` and requires existing principal-based `requireSuperadmin`. Missing authentication returns 401, insufficient platform privilege 403; existing suspension/session checks still apply. Tenant members and CRM keys cannot use the export. No separate scrape credential or public bypass is added. The response is `no-store`. An approved collector must use the existing authenticated operator session or an approved authenticated gateway and handle expiry/revocation; neither is configured here.

All measurements are process-local and reset on restart. Scrape and retain per-instance samples externally; calculate counter deltas with reset handling, then aggregate. Missing series means no observation yet, not proof of zero errors. Metrics have no durable financial authority. A failed metrics export returns generic 503; recording and classification errors are isolated from business outcomes.

| Signal | Type and meaning | Allowed labels |
| --- | --- | --- |
| `dialog_http_requests_total` | Requests completed or aborted, exactly once | Registered Express `route` template, bounded `method`, `status_class` |
| `dialog_http_duration_seconds` | HTTP lifetime histogram, seconds | Same labels; includes streaming lifetime, not first-byte latency |
| `dialog_http_rejections_total` | Aggregate authorization/rate-limit responses | `reason`: 401, 403, 429 |
| `dialog_operations_total` | Completed operation **attempts**, not unique database rows | Fixed `operation`, `provider`, `outcome` domains |
| `dialog_operation_duration_seconds` | Completed operation wall-time histogram | Same domains |
| `dialog_media_sessions_active` | Locally authenticated media sessions not yet shut down | None |
| `dialog_media_sessions_created_total`, `dialog_media_disconnects_total` | Authenticated admission and first shutdown counts | None |
| `dialog_job_last_success_seconds` | Unix timestamp of last successful polling cycle | Fixed worker operation |
| `dialog_webhook_retry_batch_size` | Size of most recently loaded due batch, capped at 50 | None |
| `dialog_webhook_retry_batch_delay_seconds` | Largest observed overdue delay in that loaded batch | None |
| `dialog_db_pool_connections` | Existing pool's total/idle/waiting/configured max | `kind` fixed to those four values |
| `dialog_db_pool_exhausted` | Full pool, no idle connections, and a waiting request | None |
| `dialog_db_connection_errors_total` | Pool's idle-connection error events | None |
| `dialog_process_uptime_seconds`, `dialog_process_memory_bytes` | Uptime and RSS/heap/external memory | Memory `kind` fixed to four fields |
| `dialog_event_loop_delay_seconds` | Local p99 delay over each 15-second sample | Fixed `quantile=0.99` |

HTTP labels use only `req.route.path`, never request URLs, `baseUrl`, params or queries. Template length/characters are restricted and at most 160 templates are retained process-wide, followed by `other`; unmatched requests use `unmatched`. Mounted routes sharing a local template aggregate together. Method domain is seven standard methods plus `OTHER`; status classes include `aborted`. No customer-derived label is accepted. Histograms use fixed second buckets: .01, .05, .1, .25, .5, 1, 2.5, 5, 10, 30, 60, +Inf. Each observation updates a fixed eleven buckets; there are no per-request queries or network exports.

Operations cover outbound call setup, transfer, authenticated finalization, streaming-media STT/LLM/TTS, usage recording/resolution, reservation, campaign attempts, stale dispatch reconciliation, webhook delivery and the three polling jobs, plus database probes. Provider labels are restricted to internal/twilio/exotel/openai/sarvam/deepseek/other; outcomes to success/error/timeout/blocked/pending/needs_reconciliation/approaching_limit/over_soft_limit. Unknown labels are discarded. Setup is aggregate `internal`, transfers `other`; no extra credential lookup is performed to discover providers for those wrappers. Media model operations report actual selected providers. Sarvam/OpenAI TTS races measure both completed requests (including discarded audio); OpenAI-only TTS measures SDK request time, while race timings include conversion. Streaming LLM measures through completion/consumer cancellation (`pending`), not time-to-first-token.

Timeout classification uses known error names/codes only. Wrapped errors that hide that category remain generic errors. Reservation warnings reuse the existing 80% soft-warning policy and configured limits; no new spending threshold is imposed. Campaign `blocked` also includes calling-window deferrals. Call setup suppression/budget errors remain aggregate errors at that outer wrapper; campaign and reservation signals distinguish their own blocked outcomes.

Infrastructure sampling occurs every 15 seconds using existing pool properties and Node's event-loop histogram; it creates no connections or queries. Its timer, event-loop monitor and pool listener are disposed on server close. Session gauges decrement once through the existing idempotent shutdown. Finalization observations include durable media closure and existing finalization, without reopening sessions or changing billing logic.

### Measurement limits

Batch delay is not a total backlog, oldest global row or trend across all rows: the existing query has no ordering and sees at most 50. It retains its last observation if polling fails; consult job freshness too. Poll-cycle success does not prove every delivery/campaign succeeded because existing workers handle item failures. Webhook delivery outcomes and campaign outcomes measure those separately. There is no attempt to add full-table scans to requests or background ticks.

No authoritative all-provider active-call gauge, global unresolved-usage backlog, database-wide query latency, backup-success metric, distributed trace, tenant alert grouping or provider invoice reconciliation is fabricated. Database latency covers completed health probes only; stuck probes are detected by external readiness rather than a completed latency sample. Legacy HTTP/widget model paths are not newly instrumented for provider latency; HTTP metrics and their existing redacted logs remain. Telephony finalization outside the authenticated media lifecycle is not counted as media finalization. A business finalizer that handles its own errors can report wrapper success: existing redacted logs and ledger evidence still matter. Fatal process exits cannot flush memory counters.

## Alert catalogue and enabling requirements

`artifacts/api-server/src/lib/operational-alerts.ts` is a machine-readable, vendor-neutral catalogue of 13 decision rules with declared signals, severity, window, persistence, impact and first response. Tests validate all metric references. It does **not** run a rule evaluator or send notifications. Each rule requires an operator-approved destination, recipient, escalation path, collection interval, retention, instance labels, route inclusion filter and deduplication policy. These are all unconfigured; no team/channel is assumed.

No traffic baseline or approved service objective exists in the repository. All numeric alert thresholds below are **provisional, for owner validation**, except the existing budget warning policy and observed worker intervals. Collect at least a representative traffic week, including peak calls, long streams, deploys and known healthy database behavior, before approving or tuning these values. Verify minimum-sample gates, reset handling, scrape gaps and instance aggregation in staging.

| Alert | Proposed decision / persistence | Severity and impact | First response |
| --- | --- | --- | --- |
| API errors | >5% 5xx over 5m, >=100 completed requests; persist 5m | Critical: API unavailable | Readiness, release and redacted errors |
| API latency | p95 >1s over 10m, >=100 selected API requests; persist 10m | Warning: interactive degradation | Pool, event loop and provider operations; exclude static/streams/health/metrics |
| Health | 30s independent probes; three consecutive non-200/timeouts | Critical: dead/unready instance | Separate liveness, readiness, ingress and database failures |
| Database | Full waiting pool for 2m, >=3 idle-connection errors/5m or completed probe errors/5m | Critical: critical DB access blocked | Connection budget, DB availability, schema status |
| Call setup | >10% errors/timeouts/5m with >=20 attempts; persist 5m | Warning: calls cannot start | Provider/configuration and budget/suppression signals |
| Voice timeout | >=3 STT/LLM/TTS timeouts per provider/5m; persist 5m | Warning: conversation degradation | Provider latency, approved provider status tooling |
| Finalization | >=1 finalization error/timeout/5m; evaluate 30s | Critical: incomplete call/usage state | Durable state and provider evidence; no blind retry |
| Usage | >=1 usage/resolution error/timeout/5m; warning >=3 reconciliation outcomes/10m | Critical/warning: billing uncertainty | Reconciliation dashboard and rate cards; preserve unknown costs |
| Workers | >=3 polling errors/5m or no success for three periods after startup grace | Warning: work delayed | 30s webhook, 15s campaign, 24h overdue cadence; missing timestamp also counts after grace |
| Retry saturation | Batch delay >300s and size=50 for 10m | Warning: sampled retries delayed | Actual delivery records and destination failures; not proof of total backlog |
| Spending | >=3 reservation warnings/blocked attempts in 10m | Warning: configured limit approached/refusals | Authorized usage/limit dashboard; repeated attempts are not unique tenants |
| Runtime | Event-loop p99 >200ms for 5m; memory threshold awaits actual deployment limit | Warning: process pressure | CPU, heap/RSS trend, deployment resources |
| Backup | Verified failure, missed scheduled completion beyond approved grace, or overdue drill | Critical: recovery confidence lost | Assigned backup owner; preserve last good backup, isolated verification |

Health requires an independent probe source. Backup requires actual completion/failure evidence from a configured backup system; neither application uptime nor a scheduled cron invocation proves a backup succeeded. Backup rules cannot be evaluated until schedule, grace, owner and evidence source are supplied. Alert payloads must contain only rule, severity, instance/deployment correlation and aggregate values; link to access-controlled operational tools, not customer content or raw exceptions.

## Diagnostics and isolation

No new payload/request/response logging is added. Existing Pino redaction remains responsible for nested database/provider errors and existing webhook/job logs. New labels cannot contain IDs, phone numbers, transcripts, order details, raw URLs or credentials. Global export requires platform authorization, independent of tenant role. Business database records, authorized transcripts and dashboard content are unchanged. Existing PII suite exercises actual database HTTP failures, provider adapter failures, webhook dispatch and usage-job exceptions; new tests also check category-specific nested exceptions and metric privacy. This is representative regression evidence, not a claim that every possible error string is safe. Keep log access restricted, set retention/export policy externally, and do not attach unrestricted logs to incidents.

## Backup policy — owner approval and configuration required

No backup platform, completion evidence, retention policy or successful restore evidence was confirmed. The accountable database/application owners and escalation destination are **unassigned**. Before accepting production recovery risk, assign them and record approved values outside secret-bearing configuration.

Proposed policy (not currently operational): encrypted PostgreSQL PITR with recovery points no more than 15 minutes apart, daily encrypted recoverable snapshots/base backups, 30-day retention and a monthly isolated restore drill. Proposed RPO **15 minutes**, RTO **4 hours**, both pending owner approval and a timed drill. If PITR is unavailable, explicitly approve a weaker measured RPO based on the real backup schedule; do not represent a daily dump as 15-minute recovery. Retention, deletion protection and offsite/cross-failure-domain storage must be approved against customer and legal obligations. Include roles/extensions/version compatibility and schema history, not just application tables.

Use a least-privilege backup identity, approved secret manager, encryption in transit and at rest, restricted restore roles, audited access and separate deletion authority. Backup files may contain historical credentials and customer records even though current fields are encrypted. Do not place backups in this repository or local unapproved directories. Track backup ID, completion time, verification result, covered database/version, encryption-key reference, retention expiry and last tested recovery point in an access-controlled backup inventory. Never put key values or database URLs in alerts or this inventory. Alert on actual failure/missed completion and drill failure via the destination once assigned.

## Isolated restore runbook — operator only; not executed

1. Open an incident/drill record with approval, responsible operator, intended recovery point, approved RPO/RTO and evidence storage. Obtain the backup inventory, immutable build/version and all migration files. Determine source PostgreSQL version/extensions and compatible restore tooling. A DBA provisions an empty **isolated non-production** target with no production network routes, outbound provider access, webhook egress or scheduler startup. Record and independently verify its identity; never use the production `DATABASE_URL` or restore into an existing shared database.
2. Retrieve the approved backup into encrypted, access-controlled temporary storage. Verify its recorded checksum, encryption metadata, completion status and recovery-point coverage before restore. For physical/PITR backups, follow that configured system's supported procedure to the selected timestamp, including WAL continuity and version requirements. No such system has been selected, so an executable PITR command cannot be supplied honestly.
3. For an approved logical custom-format dump only, configure an operator-owned PostgreSQL service profile for the isolated target through approved secret handling (not in this repo). With `$ISOLATED_RESTORE_SERVICE` and `$APPROVED_BACKUP_FILE` set by that process, inspect `pg_restore --list "$APPROVED_BACKUP_FILE"`, then restore using `pg_restore --exit-on-error --no-owner --no-acl --dbname="service=$ISOLATED_RESTORE_SERVICE" "$APPROVED_BACKUP_FILE"`. Do not add `--clean` or target production. Restore required roles/grants via separately reviewed least-privilege scripts; validate extensions and history. A logical dump does not provide PITR by itself. Record sanitized result/exit status, never raw rows or service credentials.
4. In a separate approved non-production operator environment, set `DATABASE_URL` to that verified target through secret injection and use the matching application build. Run `pnpm --filter @workspace/api-server run db:migrate status`. Compare recorded migration hashes and missing objects. If the target needs newer committed migrations, review/backup the restored copy, run `pnpm --filter @workspace/api-server run db:migrate apply`, then run status again. `pnpm --filter @workspace/api-server run db:migrate adopt` is only for an explicitly reviewed legacy database with no migration history; never use it to conceal missing/corrupt history after restore. Do not use schema push, startup DDL or ad hoc edits. See [migration workflow](database-migrations-and-startup.md).
5. Recover configuration from approved configuration/secret management: canonical `PUBLIC_BASE_URL`, database TLS/connectivity settings, `JWT_SECRET`, `MEDIA_SESSION_SIGNING_KEY`, `WIDGET_VERIFICATION_KEY`, `RATE_LIMIT_HASH_KEY`, `RATE_LIMIT_STORE`, `CREDENTIAL_ENCRYPTION_KEYS` and `CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID`, required historical encryption keys, provider/webhook configuration and proxy/origin policy. This lists names only. A database restore does not recover independently held encryption keys. Follow [credential recovery/rotation constraints](credential-encryption.md), including legacy CBC dependencies; do not rotate away required old keys before validating restored ciphertext. Never reuse production provider credentials in a drill. Missing safe sandbox configuration is a blocker, not permission to bypass authentication.
6. Before starting a restored app, review automatic campaign and pending webhook states through approved DB tooling, and ensure egress is physically blocked. Starting a compatible build starts workers automatically; there is no new general worker-disable flag. Inspect sensitive data only through approved access. Validate table/constraint/history checks, referential integrity and aggregate row/ledger totals against backup evidence; execute isolated auth/tenant tests, credential decryption checks without logging values and representative API smoke checks. Never publish restored customer data to production endpoints. The repository's PostgreSQL tests create/drop only guarded loopback `dialog_test_*` databases and are not a production recovery drill.
7. Record actual backup age/data loss, restore duration, migration duration, application validation duration, missing keys/objects, reconciliation exceptions and final approved evidence. RPO is the recoverable data point, not the time a backup job started; RTO ends after service/data validation, not after `pg_restore` exits. Keep production promotion out of the drill; it needs a separate approved cutover plan. Securely dispose of the isolated copy and temporary backup under the approved retention process after evidence approval.

## Outage and interrupted-work recovery

Withdraw readiness-failing instances from traffic. Preserve liveness checks and redacted incident evidence. Check database connectivity and schema status before restarting workers repeatedly. Do not restore authentication bypasses or disable spend/tenant controls. During any release, confirm per-instance metrics and worker freshness after startup; process-local counters reset.

Existing media sockets/controllers cannot survive process loss. Drain sockets during planned deployments; after a crash, inspect persisted call/media sessions and provider status through authorized tooling. Claimed/closed media credentials remain non-replayable; do not reopen sessions or replay inbound start frames. Confirm provider end/billed duration before deciding call state. Media closure/finalization metrics are attempted local work, not proof of a committed invoice.

Campaigns retain claim tokens and `dialing`/`calling`/`dispatch_unknown` state. Existing reconciliation uses a two-minute stale claim threshold, 30-minute unknown dispatch threshold, six-hour maximum active age and one-minute ended-call grace. Let the existing conditional reconciliation run after DB recovery; investigate unresolved provider identities first. Never reset statuses en masse or blindly redial an unknown dispatch. New stale-dispatch counters cover the existing successful no-answer reconciliation branch only.

Webhook rows persist delivery status/attempts and retry schedule. Check pending/delivered/failed rows and receiver idempotency before replay; transport outcomes can be ambiguous across a crash, and the existing dispatcher does not gain exactly-once delivery here. Retry-batch counters do not reconstruct lost in-flight requests. Overdue billing runs at worker startup and then daily; verify its last successful timestamp and authorized invoice states after recovery.

Review `/api/superadmin/usage/reconciliation` through existing operator authentication and the usage/billing dashboard. Preserve ledger idempotency keys, measurement ranking, unknown cost and provisional budget amounts. Use existing reconciliation routes with verified provider evidence; do not delete entries, double-record usage or translate unknown into free usage. Inspect held reservations and interrupted calls together; existing expired-hold release occurs on the next reservation and is not a new sweeper. Reconcile before complete invoice generation; incomplete-usage overrides require the established explicit operator decision. See [usage and spend limits](usage-billing-and-spend-limits.md). Financial audit and provider-invoice comparison remain operator work.

## Deployment actions and production verification

No migration or new environment variable is required by this phase. Deploy existing schema-compatible builds in the existing order. Configure an approved authenticated metrics collection path and per-instance identity; implement the catalogue in the eventual platform's rule language, including missing-series handling and alert routing. Set collection/retention, access control, deployment resource limits, log retention/export, readiness traffic routing and independent public/instance probes. Assign operational and backup owners and approve baseline thresholds/RPO/RTO.

In staging, verify authenticated export and tenant denial, abrupt DB loss and schema incompatibility, alert firing/recovery/deduplication with safe injected failures, notification receipt in the approved destination, restart counter resets and multi-instance aggregation. Confirm overhead under approved representative traffic; no load test was run here. Verify logs/alerts contain aggregate data only. Confirm backup completion evidence, missed-backup detection, encrypted restore/key recovery and a timed drill before claiming backup coverage. All external configuration and production verification remains outstanding.

## Files and local evidence

Changed files (repository-relative):

* `.gitignore`: narrow exception for this requested document; other notes remain ignored.
* `artifacts/api-server/src/lib/operational-metrics.ts`: bounded dependency-free registry, HTTP measurement and pool/runtime sampling.
* `artifacts/api-server/src/lib/operational-alerts.ts`: 13 decision definitions and shared explicitly unconfigured delivery contract.
* `artifacts/api-server/src/routes/metrics.ts`: superadmin export and generic export-error handling.
* `artifacts/api-server/src/app.ts`, `src/index.ts`: metrics mounting, overdue-job measurement and sampler lifecycle.
* `artifacts/api-server/src/routes/health.ts`, `src/lib/schema-readiness.ts`: bounded/sanitized health, retained underlying single-flight and periodic schema validation.
* `artifacts/api-server/src/lib/media-ws-auth.ts`, `src/lib/twilio-ws-server.ts`: authenticated media/session finalization and model timings.
* `artifacts/api-server/src/lib/telephony/place-outbound-call.ts`, `src/lib/transfer-manager.ts`: setup/transfer attempt outcomes.
* `artifacts/api-server/src/lib/campaign-dialer.ts`, `src/lib/webhook-dispatcher.ts`: polling/delivery outcomes, stale reconciliation and loaded-batch delay.
* `artifacts/api-server/src/lib/billing/usage-ledger.ts`, `src/lib/billing/spend-budget.ts`: usage/resolution and reservation measurements around unchanged business implementations.
* `artifacts/api-server/test/monitoring.test.ts`, `test/run-tests.mjs`, `test/migrations.test.ts`: 16 new monitoring tests, suite registration and realistic health query fixture.
* `docs/production-readiness/monitoring-alerting-disaster-recovery.md`: this audit, signal contract, alert catalogue and recovery evidence/runbook.

Prior Phase 1N changes were already present/committed in the workspace and were not undone. No migration SQL, authentication policy, rate card, suppression rule or delivery policy was changed here.

Executed on 2026-10-22, Windows/PowerShell:

| Command / check | Actual result |
| --- | --- |
| `pnpm --filter @workspace/api-server typecheck` | Passed after fixing two new TypeScript diagnostics during implementation |
| `pnpm run typecheck` | Passed: library build references, API, sales frontend, mockup frontend and scripts |
| `pnpm run build` (final code) | Passed including root typecheck, API production entrypoints and both frontends |
| `pnpm --filter @workspace/api-server test monitoring.test.ts migrations.test.ts` | Targeted loopback-enabled run: 28 tests, 22 passed, 0 failed, 6 PostgreSQL skips (before two additional monitoring regressions were added) |
| `pnpm --filter @workspace/api-server test` without a test DB | Initial complete run: 271 tests, 256 passed, 0 failed, 15 PostgreSQL skips (before the two additional regressions) |
| Same full test command with explicit loopback `TEST_DATABASE_URL` and `DIALOG_REQUIRE_POSTGRES=1` | **Final strict run: 273 tests, 273 passed, 0 failed, 0 skipped, 0 cancelled**. Includes 16 new monitoring tests and all 15 existing PostgreSQL-gated tests |
| `pnpm run check:secrets` | Passed; no committed credentials found, including newly unignored documentation |
| `pnpm run check:schema-push` | Passed; no unguarded schema-push automation |
| `git diff --check` and complete tracked/new-file review | Passed whitespace check; reviewed instrumentation boundaries, added content, unchanged migration SQL, no new secrets or unrelated code changes |

The first targeted attempt inside the restricted sandbox had 16 passes, 6 loopback `EACCES` failures and 6 PostgreSQL skips; it was rerun with permitted localhost access, rather than weakening tests. Docker initially returned access denied inside the sandbox. A permitted read-only check established daemon availability and cached PostgreSQL images. The final strict run used cached PostgreSQL 16 Alpine in a newly created disposable container, published only on loopback, with trust authentication and a `dialog_test_` database. No new password/credential was created, no application `.env` was loaded, and no shared database was accessed. The existing test harness blocks external HTTP; its existing test fixtures were reused. Test helpers create/drop guarded disposable databases, and the container was removed afterward.

Build warnings remain: Vite could not resolve original sourcemap positions for three existing UI components and reported a frontend chunk over 500 kB. The strict suite also emitted pg's existing warning about concurrent queries on one client in a widget concurrency fixture. These did not fail validation and were not addressed by changing unrelated code. A generated mockup file produced a Git line-ending warning but no content diff.

No backup completion verification, restore command, recovery drill, production load test or external notification test was performed. PostgreSQL migration/concurrency tests are **not** backup/restore verification. RPO/RTO remain proposed, external collection/alert delivery and backup policy remain unconfigured, and production status remains unverified.
