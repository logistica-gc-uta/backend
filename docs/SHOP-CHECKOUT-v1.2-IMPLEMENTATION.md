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

## Key Learnings
1. Preserving legacy Order schema integrity by projecting new commercial identifiers and receipt references from isolated order-linked tables prevents unintentional data leakage in endpoints that spread Order objects.
2. Separate monetary snapshot columns on PaymentAttempt (`subtotalCents`, `taxEnabled`, `taxRateBps`, `taxAmountCents`, `shippingAmountCents`, `totalCents`) mirror PurchaseReceipt and enable strict database CHECK constraints that enforce mathematical integrity (`amountCents = totalCents = subtotalCents + taxAmountCents`) at persistence time.
3. In PostgreSQL CHECK constraints on JSON columns, `col IS NOT NULL` is satisfied even if `col` contains the JSON literal `'null'::json`; using `json_typeof(col) = 'object'` strictly guarantees that snapshot fields hold structured object payloads rather than JSON null primitives.
4. Exhaustive composite CHECK constraints partitioning status states (`PROCESSING`, `SUCCEEDED`, `REJECTED`, `FAILED`) ensure that transition linkages (orderId, receiptId, paymentAttemptId), error payloads, and success snapshots remain strictly coherent with no ambiguous intermediate states.
5. In Prisma 8, self-emitting migrations via `node migrations/app/<dir>/migration.ts` recalculates content-addressed hashes and regenerates `ops.json` and `migration.json` deterministically from the underlying TypeScript migration AST.
6. In Prisma 8, raw parameterized queries constructed via `client.raw.sql` with `.affectedCount().build()` and executed within `client.transaction(async tx => await tx.execute(plan))` eliminate race conditions in fixture bootstrap operations by delegating uniqueness enforcement to PostgreSQL's atomic `ON CONFLICT ("fixtureId") DO NOTHING`, bypassing the read-before-insert races inherent in ORM `findUnique`/`create` sequences.
7. Strict integer validation for month and year in financial/card DTOs must verify `typeof val === 'number' && Number.isInteger(val)` to prevent implicit numeric coercion of string or float payloads prior to calendar arithmetic.
