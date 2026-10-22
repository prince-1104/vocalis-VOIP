# Phase 1P — Vobiz SIP integration foundation

## Outcome and verification boundary

This phase implements backend configuration handling and a disabled execution boundary. A validated saved configuration is `configured_unverified`, never connected, verified, enabled or operational. No Vobiz credential was sent to a real service. No trunk, number, LiveKit resource, SIP participant, dispatch rule or call was created. Twilio remains the existing default. Exotel behavior was not changed.

The backend contract is locally testable independently of LiveKit. Vobiz calling, inbound routing, media, transfer and provider billing verification remain blocked until Phase 1Q. There is no new settings UI because the existing tenant telephony interface primarily configures legacy providers through superadmin routes and does not yet represent this disabled foundation honestly. No LiveKit implementation or dependency is added.

## Documentation consulted, 2026-10-22

Reviewed the current official [Vobiz LiveKit integration overview](https://www.vobiz.ai/integrations/livekit/), [SIP trunking product description](https://www.vobiz.ai/products/sip-trunking/), [integration guide](https://www.vobiz.ai/docs/integrations/livekit) and [SIP trunk overview](https://www.vobiz.ai/docs/platform/sip/overview).

The integration guide maps the trunk-specific SIP domain, SIP username/password and associated numbers into LiveKit's outbound trunk configuration. It distinguishes these from Vobiz account API authentication. Inbound setup requires the LiveKit SIP host, inbound trunk and agent dispatch configuration. Dialog therefore needs saved SIP configuration but cannot execute through the existing Twilio REST adapter. This phase does not introduce Vobiz account API credentials or an API client.

The domain suffix validation reflects the currently documented trunk-specific hostname form. It does not supply an endpoint, resolve DNS or contact that hostname. Values must come from the tenant's actual trunk configuration. Documentation changes or nonstandard enterprise domains require an explicit contract review rather than accepting arbitrary SIP destinations.

## Architecture audit

| Existing component | Reusable behavior and current assumption |
| --- | --- |
| `tenants.telephony_type` | Text selector, default `TWILIO`; existing configured providers are Twilio, legacy `SIP_TRUNK` and Exotel. No default or tenant selector is changed by saving Vobiz configuration. |
| `telephony/resolve-telephony.ts` | Resolves tenant-owner configuration. Both `TWILIO` and legacy `SIP_TRUNK` return a Twilio context. Legacy SIP builds a SIP destination for Twilio REST and still requires Twilio credentials; it is not Vobiz via LiveKit. |
| `telephony/place-outbound-call.ts` | Shared outbound suppression check, provider resolution, budget reservation, call-log creation, provider request and conditional provider-ID binding. Vobiz is refused during provider resolution, before a reservation/call log/provider request. |
| Twilio webhooks/media | Canonical signed HTTP callbacks, TwiML issuance, signed upgrade, durable one-time media session admission and authenticated media pipeline. The payloads, AccountSid/CallSid binding, TwiML and media protocol are Twilio-specific and must not be reused as Vobiz transport/authentication. |
| Transfer/finalization | Existing Twilio transfer controls, durable finalization claims and billing settlement remain. New Vobiz selection is denied before Twilio transfer/client use; no SIP transfer is implemented. |
| `credential-crypto.ts`, `tenant-credentials.ts`, rotation CLI | Existing AES-256-GCM/key-ID codec binds ciphertext to owning ID and exact field/column. Existing provider credentials retain their previous compatibility policies. |
| Existing auth/settings | JWT sessions resolve active membership, tenant owner context and principal-based superadmin privilege. Existing superadmin SIP settings manage Twilio-mediated SIP; the new routes reuse auth guards and shared Drizzle connection without changing those settings. |
| Usage and budget ledger | Reservations precede paid work, ambiguous provider evidence remains unreconciled, finalization/idempotency protects repeated reports. No Vobiz rates, free usage assumptions, provider evidence or ledger entries are invented. |
| Migration/startup/tests | Versioned Drizzle migration runner and schema-gated startup are reused. Node/esbuild tests mount actual HTTP middleware/routes, use isolated repositories and mock providers; strict PostgreSQL tests exercise real migrations/concurrency. |

Configuration reads and writes are separate from provider selection. A tenant can prepare Vobiz settings while existing Twilio calls continue using the previous configuration. No existing SIP table/column is repurposed, so saving a Vobiz password cannot overwrite the password used by a Twilio-mediated SIP trunk.

## Configuration contract

The typed `VobizSipConfiguration` input and `vobizSipInputSchema` are exported with the database schema, following the existing shared-schema convention. This reuses the already installed Zod dependency; no new package is required.

| Field | Validation/storage | Visibility |
| --- | --- | --- |
| `sipDomain` | Required trunk-specific DNS host under `sip.vobiz.ai`; one valid host label, case normalized; rejects shared gateway, URI scheme, userinfo, path, port, unrelated suffix and leading/trailing whitespace | Own-tenant/authorized platform metadata only; never added to audit logs or metric labels |
| `sipUsername` | Required nonblank string, <=256 characters, no ASCII control characters; stored encrypted as `vobizSipUsername` | Never returned, including masked/ciphertext forms |
| `sipPassword` | Required nonblank string, <=4096 characters, no ASCII control characters; stored encrypted as `vobizSipPassword` | Never returned or logged |
| `phoneNumbers` | Required array of 1–100 unique canonical E.164 strings: leading `+`, nonzero initial digit, at most 15 digits | Authorized configuration metadata only; no logs/metrics |
| Tenant, timestamps | Derived from authenticated scope/database, never a writable body field | Tenant context is enforced server-side |

Credential length and number-count limits are **application input bounds**, not invented Vobiz credential-format or capacity guarantees. Credentials retain their exact accepted content; only DNS case is normalized. E.164 validation proves syntax, not number assignment, ownership, caller-ID authorization or inbound routing. No DNS lookup, SIP registration, digest challenge or connectivity test occurs.

Unknown fields are rejected, including `tenantId`, `ownerId`, provider selectors, account tokens, `isEnabled`, state and inbound destination. Configuration is a complete replacement: every PUT requires all four fields, including both credentials. An omitted/empty secret does not preserve an old value or save a draft; it fails 400 without a write. This avoids accidentally pairing a changed domain/user with a previous secret. A single PostgreSQL upsert replaces the complete configuration atomically. Concurrent requests are last-write-wins as whole records, not merged credentials. Credential rotation retains its existing compare-and-set behavior.

The data-only `vobizExecutionBoundary` is immutable and reports provider `VOBIZ_SIP`, `executionAvailable: false`, `requiredIntegration: livekit`, `inboundDestination: null`. `TelephonyProvider` includes the reserved provider identifier; executable contexts remain the existing adapters. No fake successful Vobiz context or network client is returned. A future orchestration consumer must reuse tenant-scoped authorization and validated/decrypted configuration inside the backend, not expose credentials through a browser-facing endpoint.

### Honest states and errors

* No row: 200 metadata with `state: not_configured`, null domain, empty numbers and `hasSipCredentials: false`.
* Complete, decryptable, locally valid row: 200 with `state: configured_unverified`, domain/numbers and `hasSipCredentials: true`. Execution remains false.
* Invalid input: generic 400 `Invalid Vobiz SIP configuration`; no echo of rejected values or Zod issues.
* Partially populated/corrupt row, wrong key/binding, missing key configuration or database failure: generic 503 `Vobiz configuration unavailable`; no prior verification status or plaintext fallback.
* Inactive/suspended target: 403 from the configuration service; existing identity middleware can return its established 402 suspension response first for the caller's own tenant.
* Missing target/owner mismatch or malformed platform tenant ID: generic 404. Unauthenticated callers receive the existing 401; unauthorized roles receive 403 before target lookup.

No incomplete row is treated as an active trunk. DELETE is idempotent and removes only this configuration; it does not change provider selection or reset any other provider's settings. There is no verify, enable, provision, dial or transfer action on these routes.

## Authorization and credential security

`GET`, `PUT` and `DELETE /api/telephony/vobiz-sip` require existing authentication and tenant admin authority. The tenant is always the session's tenant; supplied query/body identity cannot redirect the operation. The service rechecks the active tenant and its owner relationship. Null-linked admins retain their own membership authority and gain no platform privilege from the tenant owner.

`GET`, `PUT` and `DELETE /api/superadmin/tenants/:tenantId/telephony/vobiz-sip` require the existing principal-based superadmin guard. The explicit ID must be a canonical positive PostgreSQL integer, and the target must exist, have an owner and be active. Ordinary tenant admins/managers cannot use these routes for cross-tenant reads/writes/deletes. Superadmins may use the explicit target route; their self route still refers to their own authenticated tenant. Routes are mounted after `resolveUser`; no identity headers or new bypass are introduced. Successful metadata and handler errors set `Cache-Control: no-store`.

Both credential columns are encrypted with the existing configured keyring, active key version, random nonce and tenant/field AAD. Copying ciphertext to another tenant or swapping username/password fields fails authentication. The new fields have legacy mode `none`: plaintext or CBC is rejected even while legacy reads remain enabled for older provider fields. Missing encryption configuration never falls back to plaintext or JWT-derived encryption. Existing fields preserve their legacy policies.

`CREDENTIAL_TARGETS` includes both fields, so the existing dry-run/apply credential migration and rotation procedure covers them. Deploy migration 0010 before running the updated credential rotation CLI. Keep required old keys available until rotation/verification completes; follow the existing credential-encryption runbook. GET decrypts only in the authorized backend to validate the record, then constructs a safe view; neither secret is serialized. No new frontend state stores credentials.

Audit logging records fixed event `vobiz_configuration_changed`, operation `saved`/`deleted`, scoped tenant ID and authenticated membership ID. It includes no domain, numbers, SIP URI, username, password, request body or account data. Failure logging uses fixed event/reason codes rather than exception text or SQL parameters. Central redaction now also recognizes normalized `sipUsername` keys, covering nested Vobiz and legacy SIP username diagnostics. Existing HTTP logging and aggregate metric labels are retained.

## Persistence and rollout

Migration **`0010_vobiz_sip_configuration`** adds only `vobiz_sip_configs`: serial primary key, unique tenant FK with cascade deletion, trunk domain, encrypted SIP username/password, JSONB number array and timestamps. It changes no existing tenant provider, credential row, call, invoice, rate or reservation. Schema, generated snapshot, journal and build-time migration list agree. The SQL is guarded for the existing legacy-adoption workflow; the required new table is excluded from pre-0009 adoption baseline checks and then created by its migration. Startup checks required tables/columns; it does not deeply attest the types or every constraint of an independently created conflicting table. Such an unsupported pre-existing table requires operator review, not blind adoption. The new-table uniqueness/FK/cascade behavior is verified on disposable PostgreSQL.

Run the reviewed deployment workflow against the intended environment through approved secret injection:

1. Build the release with `pnpm run build`.
2. Inspect with `pnpm --filter @workspace/api-server run db:migrate status`.
3. Apply committed migrations with `pnpm --filter @workspace/api-server run db:migrate apply`, then inspect status again.
4. Deploy the API only after the required schema is compatible; startup/readiness also require 0010. Keep the current provider selector and Twilio configuration in place.

No production migration was run during implementation. The isolated PostgreSQL regression tests create and drop only guarded loopback `dialog_test_*` databases. There is no new environment variable, provider credential default or hardcoded dial endpoint. The existing `CREDENTIAL_ENCRYPTION_KEYS` and `CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID` must already be provisioned through approved secret management. Do not use schema push for a shared deployment. Roll back application code only according to the existing schema compatibility policy; retain the additive table and encryption keys rather than deleting configuration data.

### Files changed

* Database schema/export: `lib/db/src/schema/vobiz-sip.ts`, `lib/db/src/schema/index.ts`.
* Migration: `lib/db/drizzle/0010_vobiz_sip_configuration.sql`, `lib/db/drizzle/meta/0010_snapshot.json`, `lib/db/drizzle/meta/_journal.json`, `lib/db/src/migrations.ts`.
* Configuration service/routes/mount: `artifacts/api-server/src/lib/telephony/vobiz-configuration.ts`, `src/routes/vobiz-sip.ts`, `src/app.ts`.
* Encryption/rotation/redaction: `artifacts/api-server/src/lib/credential-crypto.ts`, `src/lib/credential-migration.ts`, `src/lib/log-redaction.ts`.
* Disabled provider boundary: `artifacts/api-server/src/lib/telephony/resolve-telephony.ts`, `src/lib/transfer-manager.ts`, `src/lib/twilio-webhook-auth.ts`, `src/lib/media-session.ts`, `src/routes/dial.ts`.
* Tests: `artifacts/api-server/test/vobiz-sip.test.ts`, `test/postgres-vobiz-sip.test.ts`, `test/run-tests.mjs`, `test/fake-db.ts`, `test/credential-encryption.test.ts`, `test/migrations.test.ts`, `test/postgres-migrations.test.ts`, `test/deployment-smoke.test.ts`.
* `.gitignore` narrowly permits this document; `docs/production-readiness/vobiz-sip-integration.md` records the phase.

Existing migration/CLI tests now expect both 0009 and 0010 when upgrading from 0008, while preserving their assertions about startup refusal, data, constraints, adoption and rollback. Rotation fixtures now cover the added encrypted fields instead of weakening read-only/idempotency assertions. No other migration SQL, dependency or frontend code was changed.

## Future routing and manual setup — Phase 1Q dependencies

The future outbound flow is authorized Dialog orchestration → suppression/calling-window/concurrency policy → budget reservation and persisted call attempt → LiveKit SIP execution → Vobiz/PSTN. It must establish durable tenant/provider/call/room/participant bindings, record actual/unknown outcomes through existing usage idempotency, and settle/reconcile reservations. A supplied SIP URI must never be passed through the Twilio REST branch for this provider. Missing rates/evidence must remain unresolved rather than priced as Twilio or zero. Provider selection/activation needs an explicit verified readiness decision in the next phase; saving this configuration does not make that decision.

The future inbound flow is Vobiz-assigned number/trunk → configured LiveKit SIP destination and dispatch → authenticated tenant-bound Dialog orchestration/agent. Match persisted trunk/number identities; never trust caller-supplied tenant, SIP headers or arbitrary room metadata as authorization. Authenticate relevant LiveKit events using its verified deployment contract and apply inbound budget/session controls before paid model/provider work. Twilio signatures and Twilio custom media parameters do not authenticate this flow.

An operator must separately obtain the actual Vobiz trunk-specific SIP host and linked SIP credential, confirm number assignment/caller-ID rights, and supply the configuration through an authorized route over HTTPS. Do not use Vobiz account API tokens in the SIP password field. No automated Vobiz provisioning or account API use is necessary for this foundation.

Phase 1Q must provide the LiveKit project/server and approved secret handling; verified SDK/deployment contract; trunk/participant/dispatch provisioning and ownership; authenticated inbound event routing; agent/media implementation; transfer controls; finalized duration/cost evidence; rate policy; cleanup/reconciliation and monitoring. The provider guide describes using the LiveKit SIP host as Vobiz's inbound destination without the scheme prefix. That destination remains unset here because no target exists. Inbound address restrictions must use approved actual carrier ranges; do not deploy permissive address ranges from quickstart examples. Live calling/transfer, number ownership, credential validity, routing, codec/media interoperability, spend enforcement across LiveKit work and production capacity still need approved staging verification.

## Local verification evidence

Tests use synthetic credentials, existing fake provider/model adapters and the existing external-HTTP-blocking harness. No application startup jobs or repository `.env` are imported by the new configuration tests. Existing deployment tests intentionally execute the built entrypoints against isolated databases. New tests mount actual JWT middleware and configuration routes, inspect actual emitted Pino output, and use independent PostgreSQL connections for whole-record update/uniqueness checks.

* Targeted strict run: `pnpm --filter @workspace/api-server test vobiz-sip.test.ts credential-encryption.test.ts migrations.test.ts` with explicit loopback `TEST_DATABASE_URL` and `DIALOG_REQUIRE_POSTGRES=1`: **49 passed, 0 failed, 0 skipped, 0 cancelled**.
* `pnpm run typecheck`: passed after moving validation to the shared database schema's existing Zod dependency; no new API dependency was added.
* `pnpm run build`: passed, including root typecheck, API and both frontends. Existing frontend sourcemap-location and >500 kB bundle warnings remain.
* `pnpm run check:secrets`, `pnpm run check:schema-push`, `git diff --check`: passed during implementation; final review/results recorded below.

The first targeted run without a configured test database had 39 passes, 2 failures and 8 explicit PostgreSQL skips. The two failures exposed migration/rotation fixtures that needed to reflect the added migration/credential fields; their assertions were extended and the strict targeted rerun passed all 49. No required database test is accepted as skipped for completion.

Final verification on 2026-10-22:

| Command / inspection | Actual result |
| --- | --- |
| `pnpm --filter @workspace/api-server test` with explicit loopback `TEST_DATABASE_URL` and `DIALOG_REQUIRE_POSTGRES=1` | **291 tests, 291 passed, 0 failed, 0 skipped, 0 cancelled**. Includes 16 new Vobiz unit/HTTP tests and two new PostgreSQL tests, plus all existing regressions. |
| `pnpm run typecheck` | Passed for shared libraries, API, sales frontend, mockup frontend and scripts. |
| `pnpm run build` | Passed including root typecheck, API production entrypoints and frontend builds. |
| `pnpm run check:secrets` | Passed, including the newly permitted documentation file. No committed credentials found. |
| `pnpm run check:schema-push` | Passed; no unguarded schema-push automation. |
| `git diff --check` | Passed; Git emitted only existing line-ending notices. |
| Complete diff, SQL and snapshot review | Reviewed all changed/new files for tenant scope, secret exposure and unrelated changes. Programmatic comparison confirms every pre-existing snapshot table/metadata entry is unchanged; only the new table and snapshot linkage differ. |

The strict suite used the cached PostgreSQL 16 Alpine image in a newly created disposable container, with an explicit loopback port, a guarded `dialog_test_` database and no production credentials. It exercised versioned migrations and concurrent connections, not any live deployment. No repository `.env` was loaded into the tests. The container was stopped and removed after verification. The suite emitted pg's existing concurrent-client-query deprecation warning in a widget concurrency fixture; this did not fail tests and was not addressed by altering unrelated behavior.

No real Vobiz or LiveKit service credentials, connections or calls were used. Documentation was retrieved over HTTPS; no authenticated provider API endpoint was contacted. Locally verified configuration handling is not a working telephony integration. Deployment migration/key provisioning, actual carrier/number verification and all LiveKit execution remain outstanding. Phase 1P stops here.
