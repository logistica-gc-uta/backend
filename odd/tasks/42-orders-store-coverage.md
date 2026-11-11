# Adapt orders to store coverage (#42)

Objective: Shop quote/confirm and ADMIN create validate delivery against #41 coverage and shared Guayaquil business hours, without requiring the client to pick a zone. Branch: `feat/42-orders-store-coverage`. Delivery: `ask-on-risk`. Runner: `pnpm test` (Jest ESM). Isolated mutative checks: owned PostgreSQL via `test/geolocation-migration.fixtures.ts`.

## Specs

S1. "Shop y ADMIN envían el punto de entrega y el backend valida cobertura y horario configurable." Public writes: Shop `POST /api/v1/shop/checkout/quote` and `POST /api/v1/shop/checkout`; ADMIN `POST /api/v1/orders/admin`. Coverage via `StoreCoverageService.evaluatePoint`. Hours from ShopSettings, `America/Guayaquil`, inclusive 07:00/17:00 when configured that way; 06:59 and 17:01 rejected in both channels.

S2. "No se requiere una zona fija seleccionada por el cliente; adaptar explícitamente los consumidores existentes." `delivery.zoneId` / `zoneId` is optional and ignored for eligibility. Omitted zoneId persists null; a client-supplied zoneId may be stored as FK so current dispatch can attach the order. No invented default zone.

S3. "Las validaciones rechazan puntos fuera de cobertura y conservan la conducta de stock y compra acordada." Exterior → `422 DELIVERY_OUTSIDE_COVERAGE`. Unconfigured store → `409 STORE_NOT_CONFIGURED`. Geographic/hour rejection does not create an order/receipt or debit stock/balance. Intent/idempotency keep the existing checkout-attempt contract.

S4. "Documentar cambios de contratos y probar casos de cliente y ADMIN, borde y fuera de cobertura." Contract: `docs/orders-coverage-contract.md`. Interior/boundary accepted; exterior rejected.

S5. "Cubrir los ejemplos anteriores mediante las interfaces públicas pertinentes." Quote/confirm and ADMIN create; persisted effects and no partial debit on reject.

S6. "Acordar y documentar los contratos/campos afectados antes de integrar con otro repositorio; no sustituir una API pendiente por datos ficticios de éxito." Document web #33/#34 and backend #49. Do not implement those issues. Confirm re-evaluates current coverage and current hours (no stale purchase if ADMIN changed coverage/hours after quote).

S7. Legacy CLIENT `POST /api/v1/orders`: optional date and optional coordinates remain. Null date stays null. Coverage/hours run only when those fields are present. No address-edit HTTP surface exists; do not add one. PATCH remains status-only.

S8. Out of scope: pricing/payments (#45), OSRM/GPS, deleting Zone/Route contracts, shared DB migrate/reset, push/PR.

## Tasks

- [x] T1 S1–S8 — inline — contract doc + shared hours/coverage helpers — Risk: item 3 — `docs/orders-coverage-contract.md`
- [x] T2 S1–S5 — inline — Shop quote/confirm + token/intent without required zoneId — Risk: items 2, 3, 4
- [x] T3 S1,S2,S7 — inline — ADMIN/legacy create + nullable Order.zoneId migration (isolated only) — Risk: items 1, 2, 3 — hash `5e11bbaf…`
- [x] T4 S4–S6 — inline — e2e/unit updates, OpenAPI/docs, typecheck/lint/build — Risk: item 5
- [x] T5 S2 — inline — review findings: null-zone route guards, Nest error envelopes, persist-if-sent docs — Risk: items 1, 2, 3
- [x] T6 S3 — inline — Orders create HTTP: Nest 404/400 vs shop coverage envelopes — Risk: item 3

## Log

L1. User authorized exclusive implementation of backend #42 on `feat/42-orders-store-coverage`, following `.pi/handoffs/issue-42.md` P1–P6, test-first, no push/PR/merge/shared DB.

L2. 2026-11-11 verification (owned Postgres only): focused unit 99+ shop-orders 14 + assignment 24 + planning/urgency 102; tsc 0; lint existing warnings; build 0. Isolated e2e: shop-quote, shop-checkout, shop-checkout-recovery, shop-checkout-concurrency, shop-orders, admin-guest-api, admin-guest-delivery. Full `test:e2e:isolated` not run. No push/PR/shared migrate.

L3. User authorized review-finding corrections only, still #42 scope, test-first, no push/PR/shared DB. Prisma same-hash tip packages (`from===to` at current marker) are skipped (`db migrate --to` resolves to the contract hash and stops at `20261111T1147`); trigger REPLACE was added to that package, not `20261010T0549`. ShopHttpExceptionFilter scoped to POST create/createAdmin. Docs/DTO persist FK when sent. GREEN: `test/admin-guest-orders-api.e2e-spec.ts` 59/59 owned Postgres. Full `test:e2e:isolated` still not run.

L4. Remaining create HTTP errors: Shop filter still remapped missing registered client to PRODUCT_NOT_FOUND and insufficient stock to VALIDATION_ERROR. Local `OrdersCreateHttpExceptionFilter` keeps Nest bodies unless the exception already has a shop envelope (coverage/hours). Shared ShopHttpExceptionFilter unchanged. RED then GREEN admin-guest 60/60.
