# REGALÍA Shop Checkout v1.2 — Implementation Record

## 1. Scope and Objective
This document records the architectural decisions, contract reconciliation, schema design, and verification evidence for **Task #33-A: Commercial Settings & Audit Foundation** and **Task #33-B: Commercial Quotation, Money, Delivery & Signed Token Foundation** within the feature branch `feat/33-checkout-v12`.

## 2. Contract Reconciliation
- **Authoritative Hierarchy:** `docs/CI-SHOP-001-v1.2-CONSOLIDADO.md` (sections 1, 3, 8, 8.1, 10.1, 12) and `docs/REGALIA-SHOP-OPENAPI-v1.2.yaml` define the target contracts.
- **Contract Endpoints:**
  - `GET /api/v1/shop/settings` (Public, no auth required): returns `ShopSettingsPublic` without leaking administrative identity (`updatedById`, `createdAt`).
  - `GET /api/v1/admin/shop-settings` (ADMIN only via `JwtAuthGuard` and `RolesGuard`): returns `ShopSettingsAdmin` with `updatedById` (nullable UUID) and `createdAt`.
  - `PATCH /api/v1/admin/shop-settings` (ADMIN only): partial optimistic compare-and-swap update with mandatory `expectedVersion: int >= 1`.
  - `POST /api/v1/shop/checkout/quote` (CLIENT only via `JwtAuthGuard`, `RolesGuard`, `@Roles(Role.CLIENT)`): calculates informative quote, validates catalog/delivery/schedule bounds, and generates a 15-minute cryptographically signed quote token without mutating state or reserving inventory.
- **Reconciled Business Rules:**
  - Shipping is immutable and fixed to `{ status: 'FREE_INCLUDED', amountCents: 0, includedInPrices: true }`.
  - TimeZone is immutable and fixed to `'America/Guayaquil'`.
  - Tax mode is `'SIMULATED'` with default rate `1500` bps (15%). `rateBps` is an integer in `[0, 10000]` and `ratePercent = rateBps / 100`.
  - Maximum units per SKU per order is an integer in `[1, 100]`, default 10.
  - Delivery schedule start/end times follow format `HH:mm` in `[00:00, 23:59]`, with strict `startTime < endTime` on the same calendar day.
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

## 5. Verification & Bounded Correction Evidence (#33-A)
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

## 6. Task #33-B: Commercial Quotation, Money, Delivery & Signed Token Record

### 6.1 Architectural Scope & Invariant Preservation
- **Module Structure (`src/modules/shop/checkout/**`):**
  - `dto/quote-request.dto.ts`: Nested strict DTO validation (`null != absence` via `@ValidateIf((_, val) => val !== undefined)`), item line bounds (1..50), recipient bounds (name 1..120, phone 7..40), delivery location coordinates (-90..90, -180..180), explicit ISO offset scheduled date.
  - `dto/quote-response.dto.ts`: Exact OpenAPI v1.2 contract matching `QuoteResponse` and `QuotedLine`, including `currency: 'USD'`, exact cents, immutable free shipping (`FREE_INCLUDED`, `0`, `true`), simulated tax envelope, `settingsVersion`, `validUntil`, and `quoteToken`.
  - `checkout-money.util.ts`: Exact BigInt integer arithmetic; calculates line totals, subtotal, simulated tax with `HALF_UP` rounding applied once on subtotal, and total cents. Safe integer bounds verified (< `Number.MAX_SAFE_INTEGER`).
  - `quote-token.util.ts`: Cryptographic signing and validation of 15-minute opaque quote tokens with domain-separated HMAC key derived from `JWT_SECRET`. Token format: `qtk_v1.<payloadBase64Url>.<sigBase64Url>`. Revalidation routines for settings version change (`409 SHOP_SETTINGS_CHANGED`) and price change (`409 PRICE_CHANGED`).
  - `checkout.service.ts`: Core quotation workflow. Reuses existing `consolidateOrderItems` (codepoint ordering), `validateCoordinatePair`, `parseDeliveryTiming`, `deliveryClock`, and `evaluatePlanningEligibility`. Database reads execute under PostgreSQL default READ COMMITTED transaction on a pinned connection; settings are queried separately from `ShopSettingsService`. Consistent snapshot isolation is not claimed, and no unrequested locking framework is introduced.
  - Quotation does NOT reserve stock; inventory remains available to other shoppers until order placement. Downstream Task #33-C MUST revalidate stock availability under row-level locks and verify settings version. Items with insufficient stock return `available: false` and `availableStock: 0` as part of the informative quote contract.
  - `checkout.controller.ts`: Endpoint `POST /api/v1/shop/checkout/quote` protected by `JwtAuthGuard`, `RolesGuard`, and `@Roles(Role.CLIENT)`. Uses controller-scoped `ShopHttpExceptionFilter`.
  - `checkout.module.ts`: Wires dependencies (`AuthModule`, `PrismaModule`, `ShopSettingsModule`) and exports `CheckoutService`. Integrated into `src/modules/shop/shop.module.ts`.

### 6.2 Security Invariants & Domain Separation
- **Quote Token Signing & Bearer Immunity:**
  - Token is HMAC-signed, NOT encrypted. The payload is base64url-encoded JSON and readable by clients.
  - Token contains delivery PII required for downstream order processing (recipient name, phone number, delivery address, geographic coordinates).
  - Token contains ZERO payment card data, PAN, CVV, or credentials.
  - The token must NEVER be logged in server logs, application diagnostics, or error envelopes.
  - Format and signature separation: prefix `qtk_v1.` and domain-separated HMAC key prevent standard JWT parsers and `JwtStrategy` from accepting it as an authentication bearer token (returns 401 UNAUTHENTICATED). This format and signature separation prevents authentication acceptance, not decoding/confidentiality.
  - Signing key is derived via HMAC-SHA256 with domain context `regalia:shop:quote-token:v1.2` from configured `JWT_SECRET`.
  - Refuses missing or empty secret with an explicit server exception; never falls back to hardcoded defaults.
  - Token binds buyer identity, canonical delivery payload (with normalized UTC instant for scheduledDeliveryDate), consolidated lines, unit prices, settings version, and database clock expiration.

### 6.3 Business Validation & Contract Boundaries
- **Consolidation & Dynamic Limits:**
  - Lines with identical `productId` are consolidated prior to limit checks and pricing.
  - Consolidated quantity is validated against active `ShopBusinessSettings.limits.maxUnitsPerSkuPerOrder` (default 10). Exceeding limit (e.g. 6 + 5 = 11) returns HTTP 422 `QUANTITY_LIMIT_EXCEEDED` with `{ productId, requestedQuantity: 11, maximumAllowed: 10 }`.
- **Geographic & Depot Verification:**
  - Zone lookup in database. Missing zone returns HTTP 404 `ZONE_NOT_FOUND`.
  - Depot presence evaluated via `evaluatePlanningEligibility`. Zone without depot coordinates returns HTTP 422 `DELIVERY_INVALID`.
- **Delivery Scheduling & Operating Hours:**
  - Scheduled date parsed strictly with explicit timezone offset. Missing offset returns HTTP 400 `VALIDATION_ERROR`.
  - Scheduled instant compared against PostgreSQL database clock via `deliveryClock`. Past instant returns HTTP 422 `DELIVERY_INVALID`.
  - Operating hours evaluated in `America/Guayaquil` timezone against active settings (default 07:00..17:00 inclusive). Times 06:59 and 17:01 return HTTP 422 `DELIVERY_OUTSIDE_HOURS`. Boundary times 07:00 and 17:00 are accepted.
- **Catalog Publication & Stock:**
  - Non-existent product returns HTTP 404 `PRODUCT_NOT_FOUND`.
  - Unpublished product or product with inactive category returns HTTP 409 `PRODUCT_UNPUBLISHED`.
  - Out of stock product (`stock: 0`) is quoted successfully with `available: false` and `availableStock: 0`, without failing the quote or reserving inventory.
  - Database inventory stock, settings version, and settings audit trail remain completely untouched during quote operations.

### 6.4 Verification Evidence & Test Results
- **Unit Test Execution:**
  - Command: `env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null pnpm test --roots '<rootDir>/src' --runInBand --runTestsByPath src/modules/shop/checkout/checkout-money.util.spec.ts src/modules/shop/checkout/quote-token.util.spec.ts src/modules/shop/checkout/checkout.service.spec.ts`
  - Result: 3 passed suites, 40 passed tests, 0 failed.
  - Verified cases:
    - `checkout-money.util.spec.ts` (13 passed): exact $73.00 + 15% ($10.95) + $0 = $83.95; tax disabled $73.00; half-cent rounding boundaries; overflow checks; nonnegative subtotal and integer bps [0, 10000] validation BEFORE early return on tax disabled or rate 0.
    - `quote-token.util.spec.ts` (13 passed): secret absence rejection; token tamper rejection; buyer mismatch 403; DB clock expiration 409 QUOTE_EXPIRED; exact 15-minute boundary (`nowDb == validUntil`) rejected with 409; just-before boundary (`nowDb < validUntil`) accepted; bearer prefix immunity; settings version change 409 SHOP_SETTINGS_CHANGED; price change 409 PRICE_CHANGED.
    - `checkout.service.spec.ts` (14 passed): duplicate consolidation 6+5=11 -> 422; zone depot 422; schedule past 422; 06:59/17:01 -> 422; 07:00/17:00 -> 200; catalog 404/409; out-of-stock line -> `available: false`.
- **E2E Integration Execution (Owned Real PostgreSQL Container):**
  - Command: `env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null pnpm test:e2e --roots '<rootDir>' --runInBand --runTestsByPath test/shop-quote-v12.e2e-spec.ts`
  - Result: 1 passed suite, 38 passed tests, 0 failed.
  - Container receipt: `containerId=de1252dc0b13cee851d0d8cd4d6bba8fda39baa7091968c2f7a47fd66ca11084`.
  - Cleanup verified: `docker inspect de1252dc0b13cee851d0d8cd4d6bba8fda39baa7091968c2f7a47fd66ca11084` returned `error: no such object` (exit code 1).
  - Verified cases:
    - Anon -> 401 UNAUTHENTICATED
    - ADMIN -> 403 FORBIDDEN
    - DRIVER -> 403 FORBIDDEN
    - CLIENT -> 200 OK
    - Bearer immunity: `GET /orders/my-orders` with `Authorization: Bearer <quoteToken>` -> 401 UNAUTHENTICATED
    - Distinct buyer token binding verified with second client
    - Exact $73.00 + 15% ($10.95) + $0 = $83.95 quote contract
    - Out of stock line -> `available: false`, `availableStock: 0`
    - Duplicate SKU lines 6+5=11 -> 422 QUANTITY_LIMIT_EXCEEDED; 10 units -> 200 OK
    - Strict validation: unknown property -> 400; null delivery -> 400; null recipient -> 400; null coordinates -> 400; null deliveryNotes -> 400; missing offset -> 400; empty items -> 400
    - Trimming & Normalization validation: whitespace-only name -> 400; whitespace-only phone -> 400; padded phone passing raw 7 but trimming to 5 -> 400; whitespace-only address -> 400; non-string name -> 400; non-string deliveryNotes -> 400; padded valid strings normalize delivery payload in token.
    - OpenAPI UUID format: valid non-v4 UUID fixtures for product (UUID v5) and zone (UUID v1) accepted through public quote.
    - ScheduledDeliveryDate UTC normalization: ISO offset date string normalized to parsed UTC instant string in signed quote token payload.
    - Past delivery date -> 422 DELIVERY_INVALID
    - 06:59 -> 422 DELIVERY_OUTSIDE_HOURS; 17:01 -> 422 DELIVERY_OUTSIDE_HOURS; 07:00 -> 200 OK; 17:00 -> 200 OK
    - Non-existent zone -> 404 ZONE_NOT_FOUND; zone without depot -> 422 DELIVERY_INVALID
    - Non-existent product -> 404 PRODUCT_NOT_FOUND; unpublished product -> 409 PRODUCT_UNPUBLISHED; inactive category -> 409 PRODUCT_UNPUBLISHED
    - Immutability check: product stock, singleton settings version, and audit trail count verified unchanged before and after requests
    - Regressions: `GET /api/v1/shop/settings` returns 200; `GET /api/v1/products` returns 200 with stock > 0
- **Settings Service Regression Execution:**
  - Shared settings code was untouched during this bounded correction; regression suite `src/modules/shop/settings/shop-settings.service.spec.ts` remains at 27 passing tests.
- **Build & Quality Checks:**
  - `pnpm build`: clean, exit code 0.
  - `pnpm lint`: clean on all touched files (0 errors, 0 warnings).
  - `git diff --check`: clean, exit code 0.

## 7. Task #33-C1: Versioned Payment, Card, Attempt & Receipt Schema Foundation

### 7.1 Scope & Architectural Seam
- **Delimitation:** Bounded foundation only (Task #33-C1); atomic checkout transactions, lock acquisition, inventory decrement, order creation, receipt generation, and HTTP endpoints remain deferred to Task #33-C2.
- **Relational Integrity & Order Protection:**
  - In accordance with Issue #33 S3/S5/S8, no scalar columns were added to `Order` to eliminate information leakage risks through existing endpoints that spread `Order` (e.g. legacy route histories).
  - Reverse relations `paymentAttempt`, `receipt`, and `checkoutAttempts` added to `Order` allow downstream queries in C2 without mutating legacy default rows or adding unmigrated column defaults.
  - Reverse relations `checkoutAttempts`, `payments`, and `receipts` added to `User` bind buyer identity across payment records.

### 7.2 Persisted Data Models & Constraints
- **Model `SimulatedCard`:**
  - Synthetic card table storing `fixtureId` (unique text), `last4` (4 digits text), `active` (boolean, default true), `balanceCents` (int8, default 0), and timestamps (`createdAt`, `updatedAt`).
  - Plaintext PAN and CVV exist strictly in backend in-memory fixtures; the database NEVER stores PAN, CVV, hash of CVV, or raw card payload.
  - PostgreSQL CHECK constraint `simulated_card_valid`: validates `balanceCents >= 0 AND balanceCents <= 9007199254740991` (safe JavaScript integer boundary), `last4 ~ '^[0-9]{4}$'`, and fixture identifier length between 1 and 64 characters.
- **Model `CheckoutAttempt`:**
  - Intention tracking table ensuring idempotency under composite unique key `(userId, idempotencyKey)`.
  - Captures `requestHash`, `status` (`PROCESSING`, `SUCCEEDED`, `REJECTED`, `FAILED`), nullable references to `orderId`, `receiptId`, and `paymentAttemptId`, error details (`errorCode`, `errorMessage`, `errorDetails`), `successSnapshot`, and timestamps.
  - PostgreSQL CHECK constraint `checkout_attempt_status_consistency`: strictly enforces link consistency and nullability across states:
    - `PROCESSING`: requires null `orderId`, `receiptId`, `paymentAttemptId`, null error (`errorCode`, `errorMessage`, `errorDetails`), and null `successSnapshot`.
    - `SUCCEEDED`: mandates non-null `orderId`, `receiptId`, `paymentAttemptId`, non-null `successSnapshot` (distinguishing SQL null from JSON null via `json_typeof("successSnapshot") = 'object'`), and null error fields (`errorCode`, `errorMessage`, `errorDetails`).
    - `REJECTED` and `FAILED`: mandate safe non-null `errorCode` (`length BETWEEN 1 AND 64`), null sale links (`orderId`, `receiptId`, `paymentAttemptId`), and null `successSnapshot`.
- **Model `PaymentAttempt`:**
  - Transaction record representing approved simulated charges linked uniquely to `orderId`.
  - Foreign keys: `orderId` -> `Order(id)`, `buyerId` -> `User(id)`, `cardFixtureId` -> `SimulatedCard(fixtureId)`.
  - Captures separate money snapshots: `subtotalCents` (int8), `taxEnabled` (bool), `taxRateBps` (int4, 0..10000), `taxAmountCents` (int8), `shippingAmountCents` (int4, default 0), `totalCents` (int8), and `amountCents` (int8).
  - Also captures `cardLast4` (4 digits), `reference` (unique text, e.g. `PAY-DEMO-XXXXXX`), `currency = 'USD'`, and `status = 'APPROVED'`.
  - PostgreSQL CHECK constraint `payment_attempt_valid`: bounds all monetary values in [0, 9007199254740991], enforces `shippingAmountCents = 0`, `totalCents = subtotalCents + taxAmountCents`, `amountCents = totalCents`, `((NOT taxEnabled AND taxAmountCents = 0) OR taxEnabled)`, `cardLast4 ~ '^[0-9]{4}$'`, and reference length between 1 and 64 characters.
- **Model `PurchaseReceipt`:**
  - Immutable purchase snapshot and commercial numbering model linked uniquely to `orderId`.
  - Enforces individual uniqueness on `orderId`, receipt `number` (`CMP-RG-XXXXXX`), and `commercialOrderNumber` (`RG-XXXXXX`).
  - Stores monetary snapshots: `subtotalCents`, `taxMode` (`SIMULATED`), `taxEnabled`, `taxRateBps`, `taxAmountCents`, `shippingStatus` (`FREE_INCLUDED`), `shippingAmountCents` (`0`), `totalCents`, and immutable `snapshot` JSON.
  - PostgreSQL CHECK constraint `purchase_receipt_valid`: validates `totalCents = subtotalCents + taxAmountCents`, zero shipping amount, safe integer bounds, simulated disclaimer, and tax enablement consistency.

### 7.3 Prisma 8 Migration Record
- **Migration Package:** `migrations/app/20261023T2325_shop_payments_foundation_v12`
- **Origin Contract:** `d2724cd80d3f574f0e1fb083c0426dab7b696331f1ca7b50fb62a3473125576e` (settings baseline).
- **Target Contract:** `70a695f73c329e3d06c6ee0a3d8b301de993c376613442e431adde1392ca8710`.
- **Migration Hash:** `df620cd4b6f7db2058dc2164ababf39b852d238b86e10e665acd04d5a0c7e2e8`.
- **Planned Operations:** 28 operations (all additive: 4 tables, 7 unique constraints, 9 indices, 8 foreign keys, and 4 check constraints). Zero data operations on production/shared DB; foundation starts empty.

### 7.4 In-Memory Fixtures & Synthetic Card Gating
- **Module:** `src/modules/shop/checkout/simulated-card.ts`
- **In-Memory Fixtures:**
  - `DEMO_APPROVED`: `9000 0000 0000 0001` / `PRUEBA APROBADA` / `12/2030` / `111` / Initial Balance: `50000n` cents ($500.00).
  - `DEMO_LIMITED`: `9000 0000 0000 0002` / `PRUEBA LIMITADA` / `12/2030` / `222` / Initial Balance: `2000n` cents ($20.00).
  - `DEMO_EMPTY`: `9000 0000 0000 0003` / `PRUEBA SIN SALDO` / `12/2030` / `333` / Initial Balance: `0n` cents ($0.00).
- **Environment Gating:** `assertPaymentSimulationEnabled()` fails closed with HTTP 503 `PAYMENT_SIMULATION_DISABLED` unless `NODE_ENV` is `'test'` or `'demo'` AND `SIMULATED_PAYMENTS_ENABLED` is `'true'`.
- **Card Validation:** `validateSimulatedCard(input, authoritativeNow)` normalizes spaces and holder casing, performs constant-time in-memory matching, enforces strict integer validation on `expiresMonth` and `expiresYear` (rejecting string coercion and non-integer floats), enforces calendar expiration against authoritative `Temporal.Instant`, and returns only safe identity `{ fixtureId, last4 }`. Throws controlled HTTP 422 `CARD_INVALID` or `CARD_EXPIRED` without logging or leaking sensitive fields.
- **Idempotent Bootstrap:** `bootstrapSimulatedCards(db)` checks environment gating, accepts typed Prisma 8 handle (`PrismaService` or `db.client`), and executes parameterized `raw.sql` with `INSERT INTO public."simulatedCard" ... ON CONFLICT ("fixtureId") DO NOTHING` in a pinned transaction (`client.transaction`). Inserts missing fixtures only, completely eliminates read-before-insert race conditions under concurrency, and strictly preserves existing cards, spent balances, and deactivated states.

### 7.5 Verification Evidence
- **TDD RED / GREEN Execution:**
  - RED: In `test/shop-payments-foundation-v12.e2e-spec.ts`, adding assertions for `CheckoutAttempt` status consistency produced an observed test failure: creating a `PROCESSING` attempt with a non-null `orderId` resolved instead of rejecting with `/checkout_attempt_status_consistency/i` on the baseline constraint.
  - GREEN: Updated `contract.prisma` with exhaustive status consistency check and separate `PaymentAttempt` money snapshots; regenerated contract artifacts and re-emitted official migration package; all 12 tests passed cleanly.
- **Owned PostgreSQL Container Execution:**
  - Test suite: `test/shop-payments-foundation-v12.e2e-spec.ts`.
  - Container receipt: `containerId=ccf324a6f281f54400dec989ef6e0e4ddf5be85cfaaee49e30902dd1a0de2fb4`.
  - Cleanup verified: `docker inspect ccf324a6f281f54400dec989ef6e0e4ddf5be85cfaaee49e30902dd1a0de2fb4` returned `error: no such object` (exit code 1).
  - Results: 1 passed suite, 12 passed tests, 0 failed.
  - Verified assertions:
    - Empty foundation on migration: 0 simulated cards, 0 checkout attempts, 0 payments, 0 receipts.
    - Explicit bootstrap: exactly 3 simulated cards created with correct balances and last4 identifiers.
    - Idempotent bootstrap: spent balance on `DEMO_LIMITED` (updated to 450n) and deactivated status on `DEMO_EMPTY` remained unaltered upon repeated bootstrap invocation.
    - SimulatedCard integrity: negative balance and overflow balance (> `MAX_SAFE_INTEGER`) rejected by PostgreSQL CHECK constraint.
    - Idempotency uniqueness: duplicate `(userId, idempotencyKey)` rejected by unique constraint.
    - Purchase receipt uniqueness: duplicate `orderId`, duplicate `number`, and duplicate `commercialOrderNumber` rejected by unique constraints.
    - PurchaseReceipt calculation invariant: mismatched `totalCents != subtotalCents + taxAmountCents` rejected by CHECK constraint.
    - PaymentAttempt calculation & money invariants: mismatched `amountCents != totalCents` rejected; mismatched `totalCents != subtotalCents + taxAmountCents` rejected; disabled tax with non-zero tax amount rejected; non-zero shipping amount rejected; valid paymentAttempt with separate money snapshots succeeds.
    - CheckoutAttempt status consistency: `PROCESSING` with orderId, errorCode, or successSnapshot rejected; valid `PROCESSING` succeeds; `SUCCEEDED` with missing links, null successSnapshot, or errorCode rejected; valid `SUCCEEDED` with all 3 links and object snapshot succeeds; `REJECTED` and `FAILED` with orderId or successSnapshot rejected; valid `REJECTED` and `FAILED` succeed.
    - Concurrent card bootstrap: two simultaneous bootstrap executions on real PostgreSQL both resolve cleanly without unique constraint collisions, verifying exact 3 fixtures and preserving spent balances.
    - Legacy compatibility: `Order` preserves existing scalar fields (`total`, `subtotalCents`) without default leaks.
- **Build & Quality Checks:**
  - `pnpm test --roots '<rootDir>/src' --runInBand --runTestsByPath src/modules/shop/checkout/simulated-card.spec.ts`: 18 passed, 18 total.
  - `env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null pnpm test:e2e --roots '<rootDir>' --runInBand --runTestsByPath test/shop-payments-foundation-v12.e2e-spec.ts`: 13 passed, 13 total.
  - `pnpm build`: clean, exit code 0.
  - `pnpm lint`: clean on all touched files (0 errors, 0 warnings).
  - `git diff --check`: clean, exit code 0.

## 8. Task #33-C2: Atomic Purchase Confirmation & Safe Idempotency Engine

### 8.1 Scope & Design
- **Endpoint:** `POST /api/v1/shop/checkout` restricted strictly to `Role.CLIENT` via `JwtAuthGuard` and `RolesGuard`.
- **Idempotency Control & Advisory Lock Serialization:**
  - Mandatory `Idempotency-Key` HTTP header validated as trimmed UUIDv4.
  - Safe canonical intent constructed from consolidated lines (codepoint ascending order), trimmed delivery recipient/address/notes, normalized UTC delivery instant and coordinates, original `quoteToken`, and synthetic `cardFixtureId` (`'UNKNOWN_FIXTURE'` for unmapped cards).
  - Zero storage, logging, or derivatization of PAN, CVV, or cardholder credentials in the database, hashes, or logs.
  - Pre-lock fast path retrieves existing `CheckoutAttempt` for `(userId, idempotencyKey)`:
    - Same key and matching hash: replays exact previous decision (`successSnapshot` with HTTP 201 or previous typed rejection) BEFORE simulation gating, quote expiration, current settings checks, or card calendar expiry.
    - Same key with differing hash: returns HTTP 409 `IDEMPOTENCY_KEY_REUSED`.
  - Transaction-level PostgreSQL advisory lock `SELECT 1 FROM pg_advisory_xact_lock(hashtext('checkout_intent'), hashtext(userId || ':' || idempotencyKey))` serializes concurrent requests per `(userId, idempotencyKey)` at the database level BEFORE product, category, or card checks. Losers block and recheck committed winner attempt under that serialization, eliminating non-existent row FOR UPDATE concurrency gaps.
- **Global Deadlock-Free Locking Hierarchy:**
  - **Level 0:** PostgreSQL Transaction Advisory Lock on `(userId, idempotencyKey)`.
  - **Level 1:** `ShopBusinessSettings` locked `FOR SHARE` via `settingsService.getPublicSettings(tx)`. Multiple checkouts read settings concurrently without contention; concurrent ADMIN CAS (`FOR UPDATE`) cleanly serializes without circular wait.
  - **Level 2:** `Category` rows in deterministic ascending codepoint order (`categoryId ASC`) locked `FOR SHARE`. Consistent with `CatalogService` (which always locks Category before Product), provably eliminating cross-module lock inversion deadlocks.
  - **Level 3:** `Product` inventory rows locked in deterministic ascending codepoint order (`productId ASC`) via `lockInventoryProduct(tx, raw, productId) FOR UPDATE`.
  - **Level 4:** `SimulatedCard` locked `FOR UPDATE` on `cardFixtureId`.
- **Atomic Business Validation & Execution:**
  - DB clock re-read after lock acquisition (`nowDb = await deliveryClock(tx, raw)`).
  - In-ledger simulated card validation against authoritative `nowDb` clock (not application clock).
  - Validation under locks: card active & calendar expiry; card `balanceCents >= totalCents` (exposing only `requiredCents` in rejection details; never `availableCents`); `verifyQuoteToken` verifying HMAC signature, buyer ownership, and expiration against `nowDb`.
  - **Signed Intent Binding:** Compares canonical items (exact composition and quantities) and complete delivery snapshot (recipient name, phone, zoneId, address, coordinates, scheduled delivery instant, notes) against signed quotation payload BEFORE business mutations. Mismatch strictly rejects with HTTP 400 `VALIDATION_ERROR` with zero charges or state modifications.
  - `settingsVersion` matching current settings; tax rules matching current settings; per-line unit price matching quoted snapshot; live product stock >= requested quantity; category active verified under share lock; dynamic SKU limits; future delivery instant and America/Guayaquil delivery operating hours; zone depot planning eligibility.
  - Buyer existence check: fails closed with HTTP 401 `UNAUTHORIZED` if user row missing; never synthesizes fake `'Cliente Registrado'`.
  - On business rejection: audits terminal `CheckoutAttempt` (`status = 'REJECTED'`, `errorCode`, `errorMessage`, `errorDetails`) under advisory lock serialization, resolving any committed winner decision, and never swallowing database record failures; returns typed error.
  - On approval (all-or-nothing transaction):
    - Decrements product stock and card balance in integer cents.
    - Creates `Order` with `status = 'PENDING'`, `total = subtotalCents / 100` (preserving Float subtotal semantics), `subtotalCents = BigInt(subtotalCents)`. No new scalar columns added to `Order`.
    - Creates `OrderItem` records with `unitPriceCents` and `price`.
    - Creates approved `PaymentAttempt` with full integer money snapshots and unique `reference` (`PAY-DEMO-YYYY-` + 32-char UUID hex).
    - Creates `PurchaseReceipt` with unique commercial order number (`RG-YYYY-` + 32-char UUID hex), receipt number (`CMP-RG-YYYY-` + 32-char UUID hex), and immutable minimal base (#34) `snapshot` JSON using `items[].productId` (not `id`).
    - Creates `CheckoutAttempt` with `status = 'SUCCEEDED'` linking all entities and storing exact public `successSnapshot` (with `order.taxEnabled` required).
  - Concurrent same-key race resolution: unique constraint on `("userId", "idempotencyKey")` safely catches code 23505, re-reads committed attempt, and returns winner's `successSnapshot` without double debiting.

### 8.2 Error Envelope & Filter Hardening
- Updated `ShopHttpExceptionFilter` to safely pass through explicit HTTP 503 `PAYMENT_SIMULATION_DISABLED` without widening or degrading unhandled server exceptions into generic leaks.
- Baseline differential vs `693d243` proves that all status < 500 responses (400, 401, 403, 404, 409, 413, 415, 422) and 502 UPLOAD_FAILED remain completely unchanged in status and response envelope (excluding random UUID `requestId`). Explicit 503 `PAYMENT_SIMULATION_DISABLED` is the single requested addition.
- Preserved all baseline error mappings (400, 401, 403, 404, 409, 413, 415, 422, 500, 502).

### 8.3 Verification Evidence (#33-C2 Bounded Corrections)
- **Unit Tests:**
  - `src/modules/shop/shop-http.filter.spec.ts`: 5 passed, 5 total.
  - `src/modules/shop/checkout/checkout-intent.util.spec.ts`: 4 passed, 4 total.
  - `src/modules/shop/checkout/checkout-confirmation.service.spec.ts`: 5 passed, 5 total.
  - `src/modules/shop/checkout/simulated-card.spec.ts`: 18 passed, 18 total.
  - Full shop checkout unit suite (6 suites, 67 tests): 67 passed, 67 total.
  - Full shop settings unit suite: 27 passed, 27 total.
- **PostgreSQL Real Container E2E Tests:**
  - `test/shop-checkout-v12.e2e-spec.ts`: 27 passed, 27 total (10.244 s).
    - Authentication & RBAC: 401 unauthenticated, 403 admin, 403 driver.
    - Request validation: 400 missing Idempotency-Key, 400 invalid UUIDv4, 400 unknown forbidden payload fields.
    - Card synthetic validation: 422 `CARD_INVALID` (non-existent fixture), 422 `CARD_INVALID` (mismatched calendar expiry), 422 `INSUFFICIENT_DEMO_FUNDS` (verifying `availableCents` is NEVER exposed; card balance, stock, and orders intact).
    - Signed Intent Binding Integrity: Real HTTP quote followed by tamper test:
      - Tamper recipient name -> 400 `VALIDATION_ERROR` with reason `DELIVERY_MISMATCH` (no charge, no orders).
      - Tamper recipient coordinates -> 400 `VALIDATION_ERROR` with reason `DELIVERY_MISMATCH` (no charge).
      - Tamper delivery date -> 400 `VALIDATION_ERROR` with reason `DELIVERY_MISMATCH` (no charge).
      - Tamper item composition using equal-price products ($73 total) -> 400 `VALIDATION_ERROR` with reason `ITEMS_MISMATCH` (no charge, stock untouched).
    - DTO Contract & Array Limits:
      - 25 product lines accepted and quoted (when settings limit fixture >= 50).
      - 51 product lines rejected with 400 `VALIDATION_ERROR` before business execution.
    - Base flow via real HTTP quote: 7300 subtotal, 1095 simulated tax, 8395 total cents ($73.00 + $10.95 = $83.95).
      - Response envelope matching OpenAPI with full 32-char UUID entropy in commercial numbers (`RG-YYYY-[0-9A-Z]{32}`, `CMP-RG-YYYY-[0-9A-Z]{32}`, `PAY-DEMO-YYYY-[0-9A-Z]{32}`).
      - Database side-effects: card balance decremented 50000 -> 41605; stock decremented 8 -> 6; exactly 1 Order (total 73.0, subtotalCents 7300n, PENDING), 1 OrderItem, 1 PaymentAttempt (APPROVED), 1 PurchaseReceipt (#34 minimal base snapshot with `items[0].productId`), 1 CheckoutAttempt (SUCCEEDED).
    - Sequential idempotent replay: returns exact previous response and deep identical references (`expect(replayRes.body).toEqual(successBody)`) without double debiting balance or decrementing stock; order count strictly unchanged.
    - Replay approved key after quote expiration: returns original 201 before quote expiry check.
    - Replay with altered payload: returns 409 `IDEMPOTENCY_KEY_REUSED`.
    - New unknown key with expired quote: returns 409 `QUOTE_EXPIRED`.
    - Stock unavailable: 409 `STOCK_UNAVAILABLE`.
    - Price change: modified in database after quote -> 409 `PRICE_CHANGED`.
    - Settings version change: 409 `SHOP_SETTINGS_CHANGED`.
    - Competitor concurrency race (stock=1): TWO CLIENTs with TWO DIFFERENT CARDS (`DEMO_APPROVED` and `DEMO_LIMITED`); exactly one gets 201 SUCCEEDED, the second gets 409 `STOCK_UNAVAILABLE` with stock=0; loser's card balance is COMPLETELY UNTOUCHED, zero loser orders or receipts.
    - Same-key concurrent race with identical payload: both receive 201 with identical body, card debited ONCE.
    - Same-key concurrent race with different payload: one original decision, other gets 409 `IDEMPOTENCY_KEY_REUSED`.
    - Concurrent category under locks recheck regression: category deactivated concurrently during checkout lifecycle rejected with 409 `PRODUCT_UNPUBLISHED` with zero debits or row writes.
    - Late write failure rollback probe: database-level fault trigger (`trg_test_fail_receipt` on `public."purchaseReceipt"` `BEFORE INSERT`) temporarily installed in owned test fixture and cleanly removed in `finally`; returns 500; asserts all stock, balance, orders, payment attempts, and receipts remain completely unchanged; subsequent request with those exact same delivery notes succeeds with 201 SUCCEEDED after trigger fault removal, proving zero production-path test branches or reserved notes.
- **Docker Container Absence Verification:**
  - Exact container IDs inspected via `docker inspect <id> --format '{{.Id}} {{.State.Status}} {{index .Config.Labels "owner"}}'`:
    - `6da4a0e155cde39aa8e47383ed9fa563cedb722e4129b03791b3530a5d4d3dd6`: absent (`error: no such object`).
    - `2b0c660a9046eb9b5301073cd7a2f5199fbcd596d8cb068bdcc4867bc3410569`: absent (`error: no such object`).
    - `2058ae0c60de8d287ff5f52d0b03e497f03d28cb97cf4fb294649266f963dee1`: absent (`error: no such object`).
    - `80f40b524d2548ed1d65bc7f421f2d661f676375f3cce0cdc550064ceddd0e68`: absent (`error: no such object`).
    - `91f09aea36214fa5d4ad705e7311ae13db55c936e18d74edb2e2b4cb166723af`: absent (`error: no such object`).
    - `1dba7b9d25c86930174d8d6fdf75a4bb7e38318a3e1687dd45fd3bcf6193836f`: absent (`error: no such object`).
- **Differential & Regression Verification:**
  - `test/shop-payments-foundation-v12.e2e-spec.ts`: 13 passed, 13 total (9.874 s).
  - `test/shop-quote-v12.e2e-spec.ts`: 38 passed, 38 total (9.921 s).
  - `test/shop-settings-v12.e2e-spec.ts`: 33 passed, 33 total (10.065 s).
- **Build & Quality:**
  - `pnpm build`: exit code 0.
  - `pnpm lint`: clean on all touched files (0 errors, 0 warnings).
  - `git diff --check`: clean, exit code 0.

## 9. Task #33-D: Attempt Status, Durable Recovery & Concurrency Immunity Record

### 9.1 Architectural Scope & Invariant Preservation
- **Module Structure (`src/modules/shop/checkout/**`):**
  - `checkout-attempt.controller.ts`: Exposes `GET /api/v1/shop/checkout-attempts/:idempotencyKey`. Protected with `JwtAuthGuard` and `RolesGuard`, restricted strictly to `Role.CLIENT`. Validates `idempotencyKey` as strict UUIDv4; throws HTTP 400 `VALIDATION_ERROR` for non-UUID strings. Returns exact `CheckoutAttemptStatusDto` projection. Returns HTTP 404 `CHECKOUT_ATTEMPT_NOT_FOUND` indistinguishably for both unknown keys and keys owned by another client (preventing IDOR enumeration).
  - `dto/checkout-attempt-status.dto.ts`: Exact projection DTO defining `status` (`PROCESSING`, `SUCCEEDED`, `REJECTED`, `FAILED`), `checkoutAttemptId`, `orderId` (nullable), `receiptId` (nullable), `errorCode` (nullable), and `updatedAt` (ISO-8601 string). Strips `requestHash`, `paymentAttemptId`, `successSnapshot`, PAN, CVV, and internal balances.
  - `checkout-attempt.service.ts`: Implements attempt status lookup and the internal bounded stale reconciler.
    - Inspects PostgreSQL DB clock (`clock_timestamp()`) and evaluates conservative staleness (`>= 15 minutes`).
    - Uses non-blocking `pg_try_advisory_xact_lock(hashtext('checkout_intent'), hashtext(userId || ':' || idempotencyKey))` in the identical namespace as the confirmation service.
    - If the lock is acquired (proving no business transaction is actively running) and status remains `PROCESSING`, transitions the orphan attempt to `FAILED` with `INTERNAL_ERROR` and metadata `reason: STALE_PROCESSING_ORPHAN`.
    - Never mutates inventory stock, never debits card balance, and never synthesizes orders or receipts.
  - `checkout-confirmation.service.ts`:
    - Pre-purchase durable reservation: Acquires unique `(userId, idempotencyKey)` reservation with status `PROCESSING` in a discrete transaction before the main business transaction.
    - Lock serialization: Only the owner of the `PROCESSING` reservation proceeds to execute the business transaction.
    - Atomic transition: The business transaction atomically updates the existing `PROCESSING` attempt to `SUCCEEDED` with `orderId`, `receiptId`, and frozen `successSnapshot`, ensuring `checkoutAttemptId` remains consistent across POST and GET.
    - Serialization of duplicates: Duplicate requests with identical key and payload wait on the transaction advisory lock and replay the winner's confirmed 201 response. Different payloads with the same key reject with HTTP 409 `IDEMPOTENCY_KEY_REUSED`.
    - Error resolution: Business rejections and failures atomically record terminal `REJECTED` or `FAILED` state under the advisory lock.

### 9.2 Incident Diagnosis & Root Cause Analysis
- **Historical account (not independently verified):** Previous Gemini D report attributed a stall to socket teardown; the actual cause of all ACP stalls is undetermined. The historical test counts and cleanup receipts below are not fresh execution evidence.
- **Previously reported suspected causes (not a universal stall diagnosis):**
  1. *Unbounded Socket Proxy Teardown in Recovery Test:* In `test/shop-checkout-recovery-v12.e2e-spec.ts`, the TCP socket proxy did not track active client/target sockets and invoked `proxyServer.close(callback)` without forcibly destroying open sockets. In Node.js, `server.close()` waits indefinitely for active keep-alive HTTP connections to close, causing the Jest test process and event loop to hang indefinitely. Combined with `jest.setTimeout(240_000)` (4 minutes) and no external command timeout, bash hung until the 30-minute harness stall watchdog fired.
  2. *Prisma 8 Raw Codec & Type Errors:* `checkout-attempt.service.ts` attempted to use `'pg/timestamptz@1'` instead of the emitted contract codec `'pg/timestamptz-temporal@1'`, and compared `SqlStatementStats` directly against numeric primitives (`stats === 1` and `stats === 0`), failing `pnpm build` with 7 TypeScript compilation errors.
  3. *Malformed Quote Payload in Concurrency Test:* `test/shop-checkout-concurrency-v12.e2e-spec.ts` signed tokens using incorrect property keys (`sub`, `version`, `pricing`) instead of the canonical `QuoteTokenPayload` (`buyerUserId`, `issuedAt`, `validUntil`, `settingsVersion`), causing intent validation to fail immediately with HTTP 400.
- **Remediation Applied:**
  - Tracked all active sockets in `Set<Socket>` and forcibly destroyed them before closing proxy server, with bounded timeouts and Superagent request deadlines.
  - Corrected codecs to `'pg/timestamptz-temporal@1'` and extracted `affectedRows` from `SqlStatementStats`.
  - Reconciled quote token payloads with canonical schema and ensured sorted item composition in test helpers.

### 9.3 Historical worker report (unverified)

The following original worker claims are retained for traceability, not accepted as current verification. Section 9.5 supersedes these counts and cleanup claims.
- **Unit Test Execution:**
  - Command: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --roots '<rootDir>/src' --runInBand --runTestsByPath src/modules/shop/checkout/*.spec.ts`
  - Result: 7 passed suites, 74 passed tests, 0 failed (2.155 s).
  - Suites:
    - `checkout-attempt.controller.spec.ts`: 6 passed (UUIDv4 validation, 404 IDOR protection, exact projection, REJECTED state, FAILED state, stale reconciliation).
    - `checkout-confirmation.service.spec.ts`: 6 passed.
    - `checkout-intent.util.spec.ts`: 12 passed.
    - `checkout-money.util.spec.ts`: 13 passed.
    - `checkout.service.spec.ts`: 14 passed.
    - `quote-token.util.spec.ts`: 13 passed.
    - `simulated-card.spec.ts`: 10 passed.
- **E2E Recovery & Durability Execution (Owned Real PostgreSQL Container):**
  - Command: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --config ./test/jest-e2e.json --runInBand --runTestsByPath test/shop-checkout-recovery-v12.e2e-spec.ts`
  - Result: 1 passed suite, 13 passed tests, 0 failed (10.223 s).
  - Container receipt: `containerId=52c71dcf759888ac56547aaea534dd7a70dceb8890084e0f3e1efb5574f9ff7c`.
  - Cleanup verified: `[TEST-CONTAINER-CLEANUP] containerId=52c71dcf759888ac56547aaea534dd7a70dceb8890084e0f3e1efb5574f9ff7c`.
  - Verified cases:
    - 401 unauthenticated
    - 403 ADMIN / 403 DRIVER
    - 400 VALIDATION_ERROR for non-UUIDv4
    - 404 CHECKOUT_ATTEMPT_NOT_FOUND for unknown key
    - 404 IDOR protection for key owned by another client
    - Exact DTO projection matching OpenAPI without sensitive leakage
    - Non-mutating GET: 5 repeated status queries produce zero changes to stock, card balance, or orders
    - Observable `PROCESSING` state while attempt is active under advisory lock
    - Stale orphan reconciler: marks stale (>15 min) unowned PROCESSING attempt FAILED with safe `INTERNAL_ERROR` without money/stock side-effects
    - Replay of FAILED POST with identical key/payload does not create new purchase
    - Real lost response after backend commit simulated via fixture-only socket proxy: socket abruptly severed upon commit; client recovers order/receipt IDs via GET and retries POST with identical Idempotency-Key receiving original 201 with identical body; card debited ONCE and stock decremented ONCE
    - Snapshot immutability: PurchaseReceipt and OrderItem snapshots remain 100% frozen after admin updates product price, product name, and settings tax rate
- **E2E Concurrency Protection Execution (Owned Real PostgreSQL Container):**
  - Command: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --config ./test/jest-e2e.json --runInBand --runTestsByPath test/shop-checkout-concurrency-v12.e2e-spec.ts`
  - Result: 1 passed suite, 2 passed tests, 0 failed (9.893 s).
  - Container receipt: `containerId=ef944c14a43fd00c4014941fc52c034433021594e24b49e7d22303e06a0569eb`.
  - Cleanup verified: `[TEST-CONTAINER-CLEANUP] containerId=ef944c14a43fd00c4014941fc52c034433021594e24b49e7d22303e06a0569eb`.
  - Verified cases:
    - Two CLIENTs on same LIMITED card with insufficient combined balance: exactly one succeeds (201 SUCCEEDED), the other rejected (422 INSUFFICIENT_DEMO_FUNDS); no overdraft, loser untouched, card debited only once.
    - Two CLIENTs with opposite product input order: both succeed without deadlock; orders count increments by exactly 2.
- **C2 Main Checkout Regression Execution (Owned Real PostgreSQL Container):**
  - Command: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --config ./test/jest-e2e.json --runInBand --runTestsByPath test/shop-checkout-v12.e2e-spec.ts`
  - Result: 1 passed suite, 28 passed tests, 0 failed (28.436 s).
  - Container receipt: `containerId=63f1780fd9597f825c8f87dd5c9a5ecee7b7be912c1c9e234702be135ae6fa0c`.
  - Cleanup verified: `[TEST-CONTAINER-CLEANUP] containerId=63f1780fd9597f825c8f87dd5c9a5ecee7b7be912c1c9e234702be135ae6fa0c`.
- **Build & Quality Checks:**
  - `pnpm build`: clean, exit code 0.
  - `pnpm lint`: clean on all touched files (0 errors, 0 warnings).
  - `git diff --check`: clean, exit code 0.

### 9.4 Fresh native Pi correction (2026-10-24)
- The previous D evidence above is historical and was not reproduced by its original worker's tracked Pi tools. This pass used `PI_MODEL=gpt-6-sol` (effort metadata not available from the tool).
- New behavior-level RED: two ownership-guard cases (missing row and replaced owner row) failed before implementation, returning 404 from later business work and uncontracted `OWNERSHIP_LOST` respectively. After correction, both fail closed before settings/inventory work with safe HTTP 500 `INTERNAL_ERROR`; all 11 focused confirmation unit tests pass. Terminal FAILED replay also uses the neutral public code/message, and internal failures are recorded as FAILED rather than REJECTED.
- Observed focused checkout units: 7 suites/80 tests passed. Type-check `pnpm exec tsc --noEmit --incremental false` initially found six pre-existing `clientUser.id` type errors in the attempt controller spec; after giving the test fixture a consistent `id`/`userId`, rerun exited 0. Targeted oxlint exited 0 with one existing unused-parameter warning in the confirmation spec. `git diff --check` exited 0.
- Real-PostgreSQL recovery/concurrency/C2 and legacy regression, build and coverage gate were **not run in this pass**: the available Pi bash tool has no background execution capability for unknown-length commands; build and coverage also produce artifacts outside the authorized edit surfaces. No owned container was created or cleaned in this pass. Do not treat historical container IDs or counts as this pass's receipts.

### 9.5 Current verified candidate (2026-10-24)

- Global unit/coverage gate: **931 tests, 78 suites, exit 0**. Coverage: **87.20% statements, 80.06% branches, 84.07% functions, 89.16% lines**.
  - Command: `env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null NODE_OPTIONS=--max-old-space-size=4096 pnpm run test:cov --runInBand --coverageThreshold='{"global":{"statements":80,"branches":80,"functions":80,"lines":80}}'`.
  - The 4 GB heap limit applies only to this local process; CI configuration and coverage thresholds were not weakened. The manifest assertion now expects the actual 31 E2E suites.
- Focused checkout units: **87 passed**, including stored-decision replay and deadline final-read cases through public `confirmCheckout(...)`; no private method invocation.
- Real PostgreSQL checkout: **28 core + 2 concurrency + 14 recovery tests passed**. Each suite ran with `pnpm test:e2e --roots '<rootDir>' --runInBand --runTestsByPath test/<suite>.e2e-spec.ts`, ambient DB/JWT removed, and `DOTENV_CONFIG_PATH=/dev/null`.
  - Recovery fixtures now eagerly start the POST, commit the durable reservation before simulating a held key, verify the actual owner's advisory lock, and await lock teardown.
  - The bounded duplicate wait checks the unchanged public sanitized 500 envelope, 4.5–10 second elapsed bound, unchanged attempt DTO/timestamp, stock and card balance.
  - Latest recovery container: `52dd652794c18d7938d43d6e96dd969a8a810ad2a61d6216780d21ec658064f7`; cleanup independently confirmed by Docker reporting no such object. Core and concurrency containers were also independently confirmed absent.
- Legacy HTTP regression: **149 passed** — CLIENT orders 35, DRIVER routes 23, ADMIN guest orders 57, route assignment 28, route history 6. Legacy external-DB suites received separate freshly owned databases, never an ambient/shared URL.
- `pnpm build`, strict `tsc --noEmit --incremental false`, and `git diff --check`: exit 0. Full lint: exit 0 with **13 warnings**; warnings were not hidden or treated as zero.
- Prior failures are resolved, not counted as passes: fixture deadlock (300-second timeout), incorrect internal-message assertion, stale suite count, default-heap OOM, and a new parameterized test's missing TypeScript narrowing.
- These local results do not claim remote CI approval or authorize merging.

### 9.6 Independent bounded verification

- The independent verifier found **no functional blocker** and personally reran the core checkout **28/28** and recovery **14/14** PostgreSQL suites (exit 0), then confirmed both owned containers absent. It made no source changes.
- Its overall verdict was **PARTIAL**, not an unconditional feature/delivery approval: settings/quote/card and legacy acceptance used source review plus the recorded prior evidence; it did not repeat the global coverage gate, all acceptance suites, or remote CI.
- Independently cleaned containers: `9d24bce7618baa5369556c567d4d803d0da619a6407efdb757e1d723ac0732d7` and `ad4e4658e4fc630172a3cd7eedc85a28a71b84640d0a35c24d2f4cc03ee8fa42`.
- Advisory only: the passing recovery suite emits a `DEBUG 404 BODY` fixture log. No production credentials or payment data are included. This advisory did not trigger another correction or test sweep.
- Remaining delivery steps: commit the reviewed D candidate, prepare the PR, and observe actual target-required remote CI. No merge is authorized.

## Key Learnings
1. Preserving legacy Order schema integrity by projecting new commercial identifiers and receipt references from isolated order-linked tables prevents unintentional data leakage in endpoints that spread Order objects.
2. Separate monetary snapshot columns on PaymentAttempt (`subtotalCents`, `taxEnabled`, `taxRateBps`, `taxAmountCents`, `shippingAmountCents`, `totalCents`) mirror PurchaseReceipt and enable strict database CHECK constraints that enforce mathematical integrity (`amountCents = totalCents = subtotalCents + taxAmountCents`) at persistence time.
3. In PostgreSQL CHECK constraints on JSON columns, `col IS NOT NULL` is satisfied even if `col` contains the JSON literal `'null'::json`; using `json_typeof(col) = 'object'` strictly guarantees that snapshot fields hold structured object payloads rather than JSON null primitives.
4. Exhaustive composite CHECK constraints partitioning status states (`PROCESSING`, `SUCCEEDED`, `REJECTED`, `FAILED`) ensure that transition linkages (orderId, receiptId, paymentAttemptId), error payloads, and success snapshots remain strictly coherent with no ambiguous intermediate states.
5. In Prisma 8, self-emitting migrations via `node migrations/app/<dir>/migration.ts` recalculates content-addressed hashes and regenerates `ops.json` and `migration.json` deterministically from the underlying TypeScript migration AST.
6. In Prisma 8, raw parameterized queries constructed via `client.raw.sql` with `.affectedCount().build()` and executed within `client.transaction(async tx => await tx.execute(plan))` eliminate race conditions in fixture bootstrap operations by delegating uniqueness enforcement to PostgreSQL's atomic `ON CONFLICT ("fixtureId") DO NOTHING`, bypassing the read-before-insert races inherent in ORM `findUnique`/`create` sequences.
7. Strict integer validation for month and year in financial/card DTOs must verify `typeof val === 'number' && Number.isInteger(val)` to prevent implicit numeric coercion of string or float payloads prior to calendar arithmetic.
8. Checkout follows a documented advisory/settings/category/product/card lock order; this is not a universal guarantee against deadlocks with every external transaction.
9. Constructing a canonical intent hash strictly from non-sensitive parameters (consolidated items, normalized recipient/address, UTC scheduled instant, quote token, and fixtureId) enables reliable idempotency tracking and reuse detection while strictly guaranteeing that PAN, CVV, or cardholder credentials are never persisted, hashed, or logged.
10. Validating idempotency before checking quote token expiration allows clients that experienced network disconnects or timeouts after commit to safely replay their request and retrieve their confirmed order references, even if the original quotation token expired during the transport retry window.
11. Acquire the durable intent with PostgreSQL INSERT ON CONFLICT DO NOTHING before the purchase transaction. A duplicate waits for the stored decision rather than creating another purchase; terminal updates require the original attempt ID, request hash and PROCESSING state.
