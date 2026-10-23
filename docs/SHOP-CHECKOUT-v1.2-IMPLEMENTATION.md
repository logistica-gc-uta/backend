# REGALÍA Shop Checkout v1.2 — Implementation Record

## 1. Scope and Objective
This document records the architectural decisions, contract reconciliation, schema design, and verification evidence for **Task #33-A: Commercial Settings & Audit Foundation** within the feature branch `feat/33-checkout-v12`.

## 2. Contract Reconciliation
- **Authoritative Hierarchy:** `docs/CI-SHOP-001-v1.2-CONSOLIDADO.md` section 8.1 and `docs/REGALIA-SHOP-OPENAPI-v1.2.yaml` define the target contracts.
- **Contract Endpoints:**
  - `GET /api/v1/shop/settings` (Public, no auth required): returns `ShopSettingsPublic` without leaking administrative identity (`updatedById`, `createdAt`).
  - `GET /api/v1/admin/shop-settings` (ADMIN only via `JwtAuthGuard` and `RolesGuard`): returns `ShopSettingsAdmin` with `updatedById` (nullable UUID) and `createdAt`.
  - `PATCH /api/v1/admin/shop-settings` (ADMIN only): partial optimistic compare-and-swap update with mandatory `expectedVersion: int >= 1`.
- **Reconciled Business Rules:**
  - Shipping is immutable and fixed to `{ status: 'FREE_INCLUDED', amountCents: 0, includedInPrices: true }`.
  - TimeZone is immutable and fixed to `'America/Guayaquil'`.
  - Tax mode is `'SIMULATED'` with default rate `1500` bps (15%). `rateBps` is an integer in `[0, 10000]` and `ratePercent = rateBps / 100`.
  - Maximum units per SKU per order is an integer in `[1, 100]`, default 10.
  - Delivery schedule start/end times follow format `HH:mm` in `[00:00, 23:59]`, with strict `startTime < endTime` on the same calendar day. Partial updates (e.g. only `startTime`) validate against the stored DB companion boundary.
  - Outdated `expectedVersion` returns HTTP 409 `SETTINGS_VERSION_CONFLICT`.
  - No-op or empty updates return HTTP 400 `VALIDATION_ERROR` with zero DB writes or audit rows.

## 3. Data Model & Migration
- **Model `ShopBusinessSettings`:**
  - Singleton enforced at the database level via PostgreSQL CHECK constraint `"singletonKey" = 'GLOBAL'` and `@unique`.
  - Field integrity enforced via PostgreSQL CHECK constraint `shop_settings_valid`: bounds for `rateBps`, `maxUnitsPerSkuPerOrder`, `deliveryStartTime < deliveryEndTime`, regex for `HH:mm`, fixed currency and shipping status.
- **Model `ShopSettingsAudit`:**
  - Append-only transactional audit trail recording `actorId`, `expectedVersion`, `newVersion`, `changedFields`, `snapshot` (before/after states), and `recordedAt`.
  - Monotonic version step invariant: `"newVersion" = "expectedVersion" + 1`.
- **Prisma 8 Migration (`20261023T2132_shop_settings_v12`):**
  - Origin: `b263aff9f248d0da2ead5a0700a5b035ab3653ec79e1f8c651ab5f936e21e1ea` (current catalog baseline).
  - Target: `d2724cd80d3f574f0e1fb083c0426dab7b696331f1ca7b50fb62a3473125576e`.
  - Migration hash: `a8913504dc4b18edfc9c8ed0e2f28d20459ad8e10dcd415f4f3879a16dee2acf`.
  - Includes idempotent SQL data operation inserting initial singleton settings (`ON CONFLICT ("singletonKey") DO NOTHING`) with exact S4 defaults.

## 4. Concurrency & Atomicity
- Optimistic concurrency control is implemented using PostgreSQL row locks (`SELECT id FROM public."shopBusinessSettings" WHERE "singletonKey" = 'GLOBAL' FOR UPDATE`) on the transaction's pinned connection.
- Compare-and-swap checks `current.version === patch.expectedVersion`.
- State mutation, version increment (`version + 1`), `updatedById` attribution, and audit row creation execute atomically within the same transaction.
- Concurrent PATCH requests from two administrators with the same `expectedVersion` yield exactly one HTTP 200 and one HTTP 409 `SETTINGS_VERSION_CONFLICT`.

## 5. Verification & Bounded Correction Evidence
- **Observed Gap:** `@IsOptional()` in class-validator skips `null` inputs. Explicitly supplied `null` values for optional settings sections or properties bypassed validation rather than being rejected.
- **Behavioral RED Reproduction:**
  - Before the fix, parameterized e2e tests for cases (a)-(f) confirmed that sending `{ expectedVersion: 1, tax: null, limits: { maxUnitsPerSkuPerOrder: 20 } }` returned HTTP 200 instead of HTTP 400 `VALIDATION_ERROR`, advancing the singleton version from 1 to 2.
- **Correction Applied:**
  - DTOs updated: replaced `@IsOptional()` with `@ValidateIf((_, val) => val !== undefined)` and applied `@IsObject()`, `@ValidateNested()`, `@IsNotEmptyObject()` on nested sections.
  - Service updated: `validatePatchInput()` enforces explicit non-null checks on `tax`, `limits`, `deliverySchedule`, and their sub-fields (`tax.enabled`, `tax.rateBps`, `deliverySchedule.startTime`, `deliverySchedule.endTime`).
  - Service typing: eliminated `tx: any` in favor of inferred `type Transaction = Parameters<Parameters<Client['transaction']>[0]>[0]`; imported `nowInstant()` from `src/common/temporal.util.ts`.
  - Fail-closed timestamp representation: `toIsoTimestamp()` throws closed on absent (`null`/`undefined`/`""`) or invalid timestamps; never synthesizes fallback `new Date()`. Compatible with `Temporal.Instant` runtime codecs.
- **S4 Boundaries & Rejection Assertions:**
  - Parameterized null tests (a) `tax: null`, (b) `limits: null`, (c) `deliverySchedule: null`, (d) `tax.enabled: null`, (e) `deliverySchedule.startTime: null`, (f) `deliverySchedule.endTime: null` all return HTTP 400 `VALIDATION_ERROR`. Public/admin GET projections and audit record counts verified identical before and after each rejected request.
  - Empty nested patches (`tax: {}`, `limits: {}`, `deliverySchedule: {}`) rejected with HTTP 400 `VALIDATION_ERROR` with state and audit count unchanged.
  - Schedule equal-time boundary (`12:00` == `12:00`) rejected with HTTP 400 `VALIDATION_ERROR` with state and audit count unchanged.
  - Valid S4 boundaries accepted: `rateBps: 0` and `10000`, `maxUnitsPerSkuPerOrder: 1` and `100`, `deliverySchedule: { startTime: '00:00', endTime: '23:59' }`.
- **Transaction Rollback Proof:**
  - Injected late audit-write failure inside transaction using nested Proxy intercepting `tx.orm.public.ShopSettingsAudit.create`. Verified atomic rollback on real PostgreSQL: service call rejected with error, singleton `version` and `taxRateBps` remained untouched, and audit count remained unchanged.
  - Note: Audit trail append-only invariant is enforced via application transactional writes; PostgreSQL has no DB-level append-only trigger.
- **Owned Container Lifecycle:**
  - Test session executed against owned container created via `startOwnedContainer()`.
  - Receipt captured: `containerId: 45ccf03b312ba87065e36c8e9c77b88ef063799d42b91936b326815cff99fc30`.
  - Cleanup verified: `cleanupOwnedResources()` removed container; post-test `docker inspect 45ccf03b312ba87065e36c8e9c77b88ef063799d42b91936b326815cff99fc30` returned `error: no such object` (exit code 1).
- **Test Suite Results:**
  - Unit Tests: `src/modules/shop/settings/shop-settings.service.spec.ts` (27 passed, 27 total).
  - Integration Tests: `test/shop-settings-v12.e2e-spec.ts` (33 passed, 33 total).
  - Build: `pnpm build` clean (0 errors).
  - Lint: `pnpm lint` clean (0 errors, 0 warnings on target files).
  - Whitespace: `git diff --check` clean (0 output).
