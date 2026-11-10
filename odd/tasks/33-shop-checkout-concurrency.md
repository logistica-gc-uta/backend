# Issue 33 — Shop checkout: simulated payments and concurrency-safe ordering

Branch: `feat/33-shop-checkout-concurrency` (stacked on `feat/32-shop-catalog-cloudinary`, itself stacked on `main` @ `13a557e`). Local commits only; RDD off unchanged; no push, no PR creation, no merge, no automatic approval.
This document is the ODD feature contract for issue #33: the frozen data and REST contract, the numbered specs, the work units and the decision log. The implementation is executed by the work units in `## Tasks`.

## Specs
S1 — Scope and deadline of the issue (verbatim): "Fuente de alcance aprobada: https://docs.google.com/document/d/1hPLYkA885tqwjhNWZ08IW7KjSqUPZV1TIAge4_OQ5SQ/edit?usp=drivesdk" · "Fecha final del proyecto: 26/11/2026." · "Propuesta de trabajo: P0 · RF-SHOP-07..11/16 · Riesgo principal."

S2 — "Tarjetas ficticias en backend: saldo suficiente, saldo limitado, saldo cero; nunca tarjetas bancarias reales."

S3 — "Backend calcula total desde Product actual, verifica stock, zona, fecha, hora, coordenadas y destinatario; rechaza monto manipulado, tarjeta inválida/sin saldo."

S4 — "PostgreSQL: bloquear producto(s) y saldo de tarjeta, orden determinista, transacción atómica de Order/OrderItem, PaymentAttempt APPROVED, saldo y stock; rollback total en error; rechazo no crea compra."

S5 — "Idempotency key protege doble clic y retry; mismo key con payload distinto se rechaza."

S6 — "Prueba REAL obligatoria: dos clientes compran 1 unidad con stock inicial 1 → exactamente uno aprueba, stock 0, otro error AGOTADO, carrito recuperable, su saldo intacto; sin dos comprobantes."

S7 — "Preservar pedidos administrativos y endpoint CLIENT actual. Diseñar contrato y migraciones versionadas."

S8 — "Definition of Done: PR con revisión humana, pruebas automatizadas y de integración aplicables, CI, evidencia/documentación, sin merge automático."

S9 — Server-side total authority. The server computes the total from the current `Product` rows read under the product row lock; the client never supplies the amount that is charged. A client-declared total that differs from the server total is rejected with `SHOP_TOTAL_MISMATCH`; when `declaredTotal` is absent the server total is used and nothing is compared.

S10 — The simulated cards live in the backend. Three kinds are needed: a card with sufficient balance, a card with a limited balance, and a card with zero balance. They are fictional. No real banking card is ever involved and no real card number is ever stored: the seed data uses the ISO/IEC 7812 reserved prefix `9900` (prefix 9 is reserved for national and private use, so no real issuer can hold it), for example `9900000000000001`, `9900000000000002` and `9900000000000003`. A number that could identify a real card is never used.

S11 — One single PostgreSQL transaction covers the whole purchase: the row locks on the products and on the card, the stock decrement, the card balance decrement, the `Order`, the `OrderItem` rows and the `PaymentAttempt` with outcome `APPROVED`. Any failure rolls the whole thing back. A rejection creates no order, no item and no payment attempt. The `PaymentOutcome.REJECTED` value exists in the frozen contract, but this issue never persists a `REJECTED` attempt: a rejection produces no attempt row at all.

S12 — The lock order is deterministic: the products are locked in the order produced by the existing `consolidateOrderItems` helper, then the card row. This fixed global order (products, always in the same codepoint order, then card) is what prevents deadlocks between concurrent checkouts.

S13 — Idempotency. The same key with the same payload returns the original order and never charges twice; the same key with a different payload is rejected; a concurrent insert of the same key is resolved by re-reading the committed attempt after the unique constraint aborts the transaction.

S14 — The existing order routes are preserved. `POST /api/v1/orders` (CLIENT) and `POST /api/v1/orders/admin` (ADMIN) keep their current contract and behavior, and a differential check of both against the base commit is required before closure. The implementation reuses the existing order-persistence core instead of duplicating it, so that the locking and timing invariants have exactly one implementation. The helpers the implementation must reuse are `consolidateOrderItems`, `lockInventoryProduct`, `parseDeliveryTiming`, `assertDeliveryFuture`, `deliveryClock`, `validateCoordinatePair`, `evaluatePlanningEligibility`, and the `order-inventory` row-lock style used by `lockInventoryProduct` (a parameterized `raw.sql` plan with `.returnsRow({...})` executed through `tx.query(plan)` on the transaction's pinned connection) for the new card row lock.

S15 — The mandatory real-PostgreSQL concurrency test: two CLIENTs, one product with initial stock 1, two different cards with enough balance, two concurrent checkouts. Exactly one gets 201; the other gets the out-of-stock error; the final stock is 0; exactly one order and exactly one `OrderItem` exist for that product; the loser's card balance is unchanged; the loser's checkout created no order, no item and no payment attempt. Explicit reading of "carrito recuperable" used by the implementation: the checkout is stateless with respect to the cart, so a rejected checkout persists nothing and the identical request can be retried; there is no cart table in this issue.

S16 — The simulated payment is academic: no SRI, no fiscal signature, no real banking, and no invented taxes. The persisted data is a simulated card balance and a payment attempt; nothing in the contract models a fiscal document.

S17 — REST surface and error codes, frozen by the parent (the exact shapes are in `## Frozen contract` → `### REST surface`): `POST /api/v1/shop/checkout` (CLIENT only) and `GET /api/v1/shop/checkout/cards` (CLIENT only), plus the seven stable machine-readable error codes `SHOP_STOCK_AGOTADO` (409), `SHOP_SALDO_INSUFICIENTE` (402), `SHOP_CARD_INVALID` (404), `SHOP_TOTAL_MISMATCH` (400), `SHOP_IDEMPOTENCY_KEY_REUSED` (409), `SHOP_IDEMPOTENCY_KEY_REQUIRED` (400) and `SHOP_PRODUCT_NOT_PUBLISHED` (409). These codes are the contract the frontend and the tests rely on and must not change.

S18 — Dependency note (not a requirement of this issue). The real Cloudinary integration stays pending and belongs to issue #32 (`feat/32-shop-catalog-cloudinary`): the signed-upload contract, the authorization rules and the association/cleanup rules are implemented there, while the real remote upload is an explicit pending item that must never be reported as verified. This issue neither implements nor verifies Cloudinary; it only consumes the catalog contract that #32 publishes, and it never reads `ProductImage` or `ShopUpload`.

S19 — Publication is respected at checkout. Only a published product can be bought: the product row read under the lock must have `isPublished = true`, otherwise the purchase is rejected with `SHOP_PRODUCT_NOT_PUBLISHED` (HTTP 409). This follows from the catalog contract published in issue #32, where publication decides the availability of a product, and from the frontend issue #21, where unpublishing a product has an effect on its availability. The checkout never reads a category, so a product in an inactive category stays purchasable only while the product itself is published; the category rule is a catalog-visibility rule, not a purchase rule.

## Frozen contract (do not renegotiate; downstream issues #34 and #35 build on it)

### Data contract (exact PSL, added by T0)

```prisma
enum PaymentOutcome {
  APPROVED
  REJECTED
}

model SimulatedCard {
  id         String   @id @default(uuid())
  cardNumber String   @unique
  holderName String
  last4      String
  balance    Float
  isActive   Boolean  @default(true)
  createdAt  DateTime @default(now())

  paymentAttempts PaymentAttempt[]
}

model PaymentAttempt {
  id             String         @id @default(uuid())
  orderId        String
  order          Order          @relation(fields: [orderId], references: [id])
  cardId         String
  card           SimulatedCard  @relation(fields: [cardId], references: [id])
  clientId       String
  client         User           @relation(fields: [clientId], references: [id])
  idempotencyKey String
  requestHash    String
  amount         Float
  outcome        PaymentOutcome
  createdAt      DateTime       @default(now())

  @@unique([clientId, idempotencyKey])
  @@index([orderId])
}
```

Exactly one relation list is added to the existing `Order` model and exactly one to the existing `User` model:

```prisma
// added inside the existing `model Order { ... }`
  paymentAttempts PaymentAttempt[]

// added inside the existing `model User { ... }`
  paymentAttempts PaymentAttempt[]
```

Notes that the writer must not break:

- `Order` and `OrderItem` are REUSED as they are. This issue adds no column to them, changes no check constraint and creates no shop-specific order table. The shop purchase is a delivery order: it is persisted with `status = PENDING` and later enters the existing ADMIN planning and DRIVER delivery flow through the routes that already exist.
- `OrderItem.price` is the immutable price snapshot. The price written into `OrderItem` is the `Product.price` read under the product row lock at purchase time; it is never recomputed later, so a later price change never rewrites history.
- `SimulatedCard.cardNumber` is the canonical digit-only form of the fictional number and is unique; `last4` is its last four digits; `balance` is the simulated available amount; `isActive` allows a card to be retired without deleting its history. The stored and returned form is always digit-only, for example `9900000000000001`; a request may send the number in any grouping, because the lookup extracts the digits before comparing. The frontend is free to group the digits for display.
- `PaymentAttempt` is the idempotency ledger: `@@unique([clientId, idempotencyKey])` scopes the key per CLIENT, `requestHash` records which payload the key was first used with, `amount` is the charged server total and `outcome` is `APPROVED` for every attempt this issue persists.
- The `Order` check constraints the checkout must satisfy are listed in L4. They are database-enforced, so the checkout row must satisfy them on insert, not only in the service layer.
- The migration seam is versioned: the models are added to `src/prisma/contract.prisma`, the emitted artifacts `src/prisma/contract.json` and `src/prisma/contract.d.ts` are regenerated, and a new versioned migration package is generated under `migrations/app/<timestamp>_<slug>/` with its snapshot under `migrations/snapshots/`. No historical migration, snapshot, ops file or hash is edited by hand.
- The checkout reads the catalog fields that issue #32 publishes: `Product.isPublished` decides whether the product can be bought, and `Product.price` and `Product.stock` are read under the lock. It reads no category, no image and no upload record.

### REST surface

CLIENT only (`JwtAuthGuard` + `RolesGuard` with `Role.CLIENT` — never `Role.ADMIN`). Anonymous requests answer 401; ADMIN and DRIVER answer 403. Both routes live under `/api/v1/shop/**` (global prefix `api/v1`), the namespace published by issue #32.

- `POST /api/v1/shop/checkout` — creates the purchase.
  - Request header: `Idempotency-Key` (required, non-empty after trimming). A missing or blank header answers 400 `SHOP_IDEMPOTENCY_KEY_REQUIRED`.
  - Request body:
    - `items[{ productId, quantity }]` — at least one item; quantities are positive integers; the list is consolidated with `consolidateOrderItems`.
    - `zoneId` — the delivery zone; it must exist.
    - `deliveryAddress` — non-empty delivery address.
    - `scheduledDeliveryDate` — ISO 8601 with explicit offset (the existing `EXPLICIT_OFFSET` rule) and strictly in the future.
    - `deliveryLat`, `deliveryLng` — the delivery coordinates, both required, validated as a complete pair by `validateCoordinatePair`.
    - `deliveryWindowStart?`, `deliveryWindowEnd?` — optional, but paired: when one is present the other is required, and the scheduled date must fall inside the window on the same business day.
    - `cardNumber` — the fictional card number; it is normalized (digits only) before the lookup.
    - `recipient { name, contactPhone }` — the recipient of the delivery; `name` non-empty, `contactPhone` non-empty.
    - `declaredTotal` — OPTIONAL. Its only purpose is to let the server detect and reject a manipulated amount. It is never the charged amount.
  - Success: 201 with the created order projected the same way the existing order routes project it (`projectOrder(order, false)`, the CLIENT projection), plus `amount` (the charged server total, equal to the persisted `Order.total`), `cardLast4` and `paymentAttemptId` (the id of the `PaymentAttempt`).
  - Idempotent replay: the same `Idempotency-Key` with the same payload answers 201 with the original order and the original `amount`, `cardLast4` and `paymentAttemptId`, and never charges or reserves anything a second time. The replay keeps the success status of the original request so that a double click and a retry are indistinguishable to the client.
- `GET /api/v1/shop/checkout/cards` — lists the simulated cards available for testing.
  - Success: 200 with `{ items: [{ cardNumber, holderName, last4, balance }] }`. It exposes nothing but those four fields: no ids, no timestamps, no payment attempts, no other client data.

Stable machine-readable error codes. Every business rejection of the checkout answers with a JSON body whose `code` field is exactly the code below and whose `statusCode` field is the listed HTTP status; `message` carries human-readable text and no other body field is part of the contract.

| Condition | HTTP | `code` |
| --- | --- | --- |
| Not enough stock for one of the requested products | 409 | `SHOP_STOCK_AGOTADO` |
| Card balance is insufficient, including a zero balance | 402 | `SHOP_SALDO_INSUFICIENTE` |
| Unknown card number or inactive card | 404 | `SHOP_CARD_INVALID` |
| `declaredTotal` differs from the server-computed total | 400 | `SHOP_TOTAL_MISMATCH` |
| The same `Idempotency-Key` reused with a different payload | 409 | `SHOP_IDEMPOTENCY_KEY_REUSED` |
| Missing or blank `Idempotency-Key` header | 400 | `SHOP_IDEMPOTENCY_KEY_REQUIRED` |
| The product is not published and therefore not purchasable | 409 | `SHOP_PRODUCT_NOT_PUBLISHED` |

Structural violations of the body (for example a negative or non-finite `declaredTotal`, a missing field, an unknown field) are answered by the repository's existing global `ValidationPipe` with HTTP 400. They are not business rejections and carry none of the six codes above.

The frozen algorithm of the checkout, in order, inside one single transaction:

1. `parseDeliveryTiming` the request and `assertDeliveryFuture` against `deliveryClock(tx, raw)` (the PostgreSQL clock, never the application clock).
2. `validateCoordinatePair` the delivery coordinates, resolve the zone and require `evaluatePlanningEligibility(dto, zone).planningEligibility.eligible` to be true, so an order that will enter planning is never born geographically ineligible.
3. `consolidateOrderItems` the requested items; the resulting order is the global lock order.
4. Idempotency pre-check: read the `PaymentAttempt` for `(clientId, idempotencyKey)`. Found with the same `requestHash` → return the original order. Found with a different `requestHash` → `SHOP_IDEMPOTENCY_KEY_REUSED`.
5. Lock each product in the consolidated order with the `lockInventoryProduct` row-lock style, check the stock and decrement it. Insufficient stock → `SHOP_STOCK_AGOTADO`. The locked row must also have `isPublished = true`, otherwise → `SHOP_PRODUCT_NOT_PUBLISHED`.
6. Compute the server total from the locked `Product.price` values; compare `declaredTotal` when present (tolerance 1e-6 absolute, because both values are non-negative currency amounts in the same unit) → mismatch is `SHOP_TOTAL_MISMATCH`.
7. Lock the card row with the same row-lock style. **The storage names are the camelCase ones Prisma 8 actually emits: the table is `public."simulatedCard"` and the column is `"cardNumber"`.** The lock is `SELECT … FROM public."simulatedCard" WHERE "cardNumber" = $1 FOR UPDATE`. No row → `SHOP_CARD_INVALID`. `isActive = false` → `SHOP_CARD_INVALID`. `balance < amount` → `SHOP_SALDO_INSUFICIENTE`. Otherwise decrement the balance. The same camelCase rule applies to every other table and column this issue touches: `public."paymentAttempt"`, `public."shopUpload"`, `public."productImage"`, `public."category"`, and the quoted column names `"cardNumber"`, `"balance"`, `"isActive"`, `"publicId"`, `"orderId"`, `"clientId"`, `"idempotencyKey"`, `"requestHash"`. Prisma 8 maps a model to a camelCase table and camelCase columns; a snake_case name in raw SQL does not exist.
8. Create the `Order` (the delivery order, `status = PENDING`, `total` = server total, `userId` = the CLIENT, `createdById` = the same CLIENT, `recipientType = REGISTERED_CLIENT`, `recipientName` / `recipientPhone` from `recipient`), then the `OrderItem` rows with the locked price snapshot, then the `PaymentAttempt` with `outcome = APPROVED`.
9. Commit. Any throw rolls back the whole transaction: no order, no item, no attempt, no stock decrement and no balance decrement.

Idempotency details that the writer must implement exactly:

- The key travels in the `Idempotency-Key` header, not in the body, and is trimmed before use.
- The key is scoped per CLIENT by `@@unique([clientId, idempotencyKey])`: two different CLIENTs may use the same key.
- `requestHash` is the lowercase hex SHA-256 of the UTF-8 JSON of a canonical object with lexicographically sorted keys and no whitespace: `items` (the consolidated array of `{ productId, quantity }` in consolidated order), `zoneId`, `deliveryAddress` (trimmed), `scheduledDeliveryDate` / `deliveryWindowStart` / `deliveryWindowEnd` (the ISO instant strings normalized to UTC, `null` when absent), `deliveryLat` / `deliveryLng` (the numbers rounded to 7 decimals, `null` when absent), `cardNumber` (digits only, uppercased), `recipient` (`{ name, contactPhone }`, trimmed) and `declaredTotal` (the number as sent, `null` when absent).
- When two concurrent requests carry the same key, the unique constraint aborts the losing transaction. The loser then re-reads the committed attempt in a NEW transaction (the aborted one cannot be reused) and answers the replay or `SHOP_IDEMPOTENCY_KEY_REUSED` exactly as the pre-check would.
- The replayed order is the one referenced by the stored `PaymentAttempt.orderId`.

## Tasks
T0 | S7,S10,S16,S18 | inline | pending | Frozen data contract and versioned migration seam: add `PaymentOutcome`, `SimulatedCard`, `PaymentAttempt` and the two relation lists to `src/prisma/contract.prisma`, regenerate the emitted artifacts, generate the new versioned migration package and snapshot, and confirm `pnpm prisma db verify` reports the marker matching the contract.
T1 | S14 | delegated | pending | Extract and reuse the shared order-persistence core: one implementation of the product locks, the stock decrement, the timing checks and the order/item creation, reused by `POST /api/v1/orders`, `POST /api/v1/orders/admin` and the checkout, with the existing routes keeping their current status codes and messages.
T2 | S3,S4,S5,S9,S11,S12,S13,S16,S17,S19 | delegated | pending | Checkout service and `POST /api/v1/shop/checkout`: the single transaction, the products-then-card lock order, the server-computed total, the publication check, the header idempotency key and the seven machine-readable error codes.
T3 | S2,S10,S17 | delegated | pending | Simulated card catalogue: the shared card-seed module `src/prisma/seed-shop-cards.ts` with its `seed:shop-cards` package script, defining ONCE the three fictional cards (sufficient, limited, zero balance) in the canonical digit-only form, plus `GET /api/v1/shop/checkout/cards`, exposing only `cardNumber`, `holderName`, `last4` and `balance`. The card seed is create-if-absent, so it never overwrites a card whose balance an earlier purchase already changed. The integration tests create their own card fixtures instead of relying on the seeded ones. Issue #35 owns the wider shop seed of gifts and categories and calls this module; it must not define a second set of card numbers or balances.
T4 | S4,S5,S6,S15 | delegated | pending | Real-PostgreSQL integration tests: the two-CLIENT stock-1 concurrency test, the rollback proof and the idempotency tests (same key same payload, same key different payload, concurrent same key). The suite also covers the shared simulated-card seed: running it twice creates nothing the second time and never resets a stored balance, which is the create-if-absent property the seed and issue #35 depend on.
T5 | S1,S7,S8,S14,S17 | inline | pending | Differential check of `POST /api/v1/orders` and `POST /api/v1/orders/admin` against the base commit, full regression, and the evidence document with the observed command results.
T6 | S1,S8 | inline | pending | Parent closure: work-unit commit decision, review handoff and the Definition of Done checklist against the observed evidence.

## Log
L1 — Original user request (verbatim)
`tengo asigando estas issue completalas con los agente los mas repido :`
```
Orden    Issue    Prioridad    Motivo
1    #31 — Seguridad y autenticación CLIENT    P0    Corregir la creación de usuarios y asegurar los roles
2    #32 — Catálogo y Cloudinary    P0    Desbloquear las Issues frontend #19 y #21 de Kerly
3    #33 — Checkout y pagos simulados    P0    Implementar la compra segura con control de concurrencia
4    #34 — Comprobantes simulados    P0    Completar el proceso posterior a la compra
Paralelo    #35 — Catálogo de prueba y QA    P0    Mateo prepara los datos y las pruebas progresivamente
```

L2 — Branch plan (parent). `feat/33-shop-checkout-concurrency` is created from `feat/32-shop-catalog-cloudinary`, which is itself created from `main` @ `13a557e`. The stack is deliberate: the checkout consumes the catalog contract that #32 publishes, so the Shop purchase must sit on the catalog branch and not on `main` directly. `main` @ `13a557e` stays the frozen base of the whole stack. Local commits only; RDD off unchanged; no push, no PR creation, no merge, no automatic approval.

L3 — Environment facts (parent, observed). The local `.env` points at PostgreSQL on port 5433 after the container repair of issue #32 (the project container was recreated through the repository's own `docker-compose.yml` with `POSTGRES_PORT=5433`, reusing the same named volume, so the data and the contract marker survived). The database is reachable and the contract marker matches the contract in force at the start of this issue. Unit inventory command: `pnpm test --roots src test`. Integration inventory command: `pnpm run test:e2e`. Known environmental failure (pre-existing, not a regression of this issue): plain `pnpm test` fails before any change with a jest-haste-map parse error caused by the leftover `.issue13-*` scratch directories in the repository root. The `.env` is local, untracked configuration; `.env.example` is untouched.

L4 — Existing code facts the implementation must build on (parent, read-only).
- Order routes: `src/modules/orders/orders.controller.ts` declares `@Controller('orders')` under the global prefix `api/v1` (`src/main.ts`) with `@UseGuards(JwtAuthGuard, RolesGuard)`. `POST /api/v1/orders` is `@Roles(Role.CLIENT)` and answers 201; `POST /api/v1/orders/admin` is `@Roles(Role.ADMIN)` and answers 201. Both project through `projectOrder(order, false)` / `projectOrder(order, true)` in `src/modules/orders/order-response.util.ts`, the CLIENT projection omitting `recipientPhone`.
- Persistence core: `OrdersService.persistOrder` in `src/modules/orders/orders.service.ts` is today the only place that locks the products, decrements the stock, computes the total and creates the `Order` and the `OrderItem` rows. `consolidateOrderItems` orders the products by codepoint, so its output is the deterministic lock order.
- Helpers to reuse, with their exact modules: `consolidateOrderItems` and `lockInventoryProduct` (`src/modules/orders/order-inventory.util.ts`); `parseDeliveryTiming`, `assertDeliveryFuture` and `deliveryClock` (`src/modules/orders/order-delivery.util.ts`); `validateCoordinatePair` and `evaluatePlanningEligibility` (`src/modules/orders/order-geography.util.ts`); `projectOrder` (`src/modules/orders/order-response.util.ts`).
- Row-lock style to reuse for the card lock: the style of `lockInventoryProduct` in `src/modules/orders/order-inventory.util.ts` — a parameterized `raw.sql` plan (`SELECT id, name, price, stock FROM public.product WHERE id = $1 FOR UPDATE`) built with `.returnsRow({...})` and executed with `tx.query(plan)` on the transaction's pinned connection, so the lock lives until commit or rollback and never runs on a pooled connection outside the transaction.
- `Order` check constraints the checkout must satisfy, from `src/prisma/contract.prisma`: `failed_order_commercial_hold`, `order_recipient_identity_valid`, `order_delivery_window_valid`, `order_delivery_coordinates_valid`. `order_recipient_identity_valid` requires, for `recipientType = 'REGISTERED_CLIENT'`, a non-null `userId`, a non-null `createdById` and a non-blank `recipientName`, so the CLIENT checkout sets `createdById` to its own user id. `order_delivery_window_valid` requires, when a window is present, a non-null `scheduledDeliveryDate` inside the window and both window ends on the same business day. `order_delivery_coordinates_valid` requires both coordinates to be null or both present and in range.
- `OrderItem.price` is already an immutable snapshot: `persistOrder` writes the `price` read under the product row lock at purchase time and never recomputes it.
- `Product.price` is `Float` and `Product.stock` is `Int` (PostgreSQL `int4`); `Order.total` is `Float`.
- `PrismaService` (`src/database/prisma.service.ts`) exposes one accessor per model, so `SimulatedCard` and `PaymentAttempt` need their accessors there; the global `ValidationPipe` in `src/main.ts` runs with `whitelist: true, forbidNonWhitelisted: true`.

L5 — Parent's frozen decisions for this issue.
1. Reuse the order-persistence core instead of duplicating it. The locking and timing invariants must have exactly one implementation, shared by the existing CLIENT route, the existing ADMIN route and the checkout. The existing routes keep their current status codes and messages (for example the current 400 on insufficient stock), so the shared core must let each caller map the same typed rejection to its own surface; the differential check in T5 proves it.
2. Lock order: products first, in the order produced by `consolidateOrderItems`, then the card row. The card is never locked first.
3. The idempotency key travels in the `Idempotency-Key` request header, required and non-empty, and is scoped per CLIENT.
4. "Carrito recuperable" reading: the checkout is stateless with respect to the cart, so a rejected checkout persists nothing and the identical request can be retried. There is no cart table in this issue.
5. The six error codes and their HTTP statuses listed in `### REST surface` are the exact stable contract.

L6 — Dependency note (parent). The real Cloudinary integration remains pending and belongs to issue #32 (see S18). It is not a requirement, not an acceptance criterion and not a verification item of issue #33, and it must never be reported as verified from this branch.
