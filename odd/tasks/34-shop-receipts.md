# Issue 34 — Shop REGALIA: comprobantes de compra simulada

Branch: `feat/34-shop-receipts` (stacked on `feat/33-shop-checkout-concurrency`, itself stacked on `feat/32-shop-catalog-cloudinary`, itself stacked on `main` @ `13a557e`). Local commits only; RDD off unchanged; no push, no PR creation, no merge, no automatic approval.
This document is the ODD feature contract for issue #34: the frozen data and REST contract, the numbered specs, the work units and the decision log. The implementation is executed by the work units in `## Tasks`.

## Specs

S1 — Scope, deadline and work proposal of the issue (verbatim): "Fuente de alcance aprobada: https://docs.google.com/document/d/1hPLYkA885tqwjhNWZ08IW7KjSqUPZV1TIAge4_OQ5SQ/edit?usp=drivesdk" · "Fecha final del proyecto: 26/11/2026." · "Propuesta de trabajo: P0 · RF-SHOP-12/14."

S2 — "Una compra simulada aprobada genera referencia única y snapshot inmutable de comprador, destinatario, ítems, precios, subtotal y total."

S3 — "Mostrar aviso inequívoco: COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA."

S4 — "Exponer consulta del comprobante por CLIENT propietario y ADMIN autorizado, rechazar acceso cruzado."

S5 — "No implementar SRI/firmas tributarias/real banking ni inventar impuestos."

S6 — "Tests de unicidad, idempotencia, consulta propia, historial inmutable y rechazo de otros usuarios."

S7 — "Dependencia: checkout transaccional."

S8 — "Definition of Done: PR con revisión humana, pruebas automatizadas y de integración aplicables, CI, evidencia/documentación, sin merge automático."

S9 — A receipt exists only for an approved payment. A receipt is created only when the checkout transaction of issue #33 committed an `Order`, its `OrderItem` rows and a `PaymentAttempt` with `outcome = APPROVED`. A rejected checkout (out of stock, insufficient balance, invalid card, manipulated total, reused idempotency key with a different payload) commits no order, no item, no attempt and no receipt. Because the reference counter is incremented inside that same transaction, the reference sequence does not advance for a rejected purchase either: a rejected purchase consumes no reference.

S10 — Uniqueness. Two different orders never share a reference; the same order never gets two receipts; a concurrent double submission of the same checkout produces exactly one receipt. The database enforces both halves: `ShopReceipt.reference` is unique and `ShopReceipt.orderId` is unique.

S11 — Idempotency. The idempotency key of issue #33 also protects the receipt: a retried checkout with the same key and the same payload returns the original receipt, with the original reference, and never issues a second receipt nor consumes a second reference. A same-key retry with a different payload is still rejected with `SHOP_IDEMPOTENCY_KEY_REUSED` and issues no receipt.

S12 — Access control. A CLIENT reads only its own receipts; an ADMIN reads any receipt; a DRIVER is rejected. A CLIENT that reads another CLIENT's receipt is rejected with HTTP 403 and the code `SHOP_RECEIPT_ACCESS_DENIED`. An anonymous request is rejected with HTTP 401 on every route of this issue.

S13 — Historical immutability. The snapshot, the reference and the issue timestamp of a receipt never change. The immutability is enforced in the database by a trigger that rejects `UPDATE` and `DELETE` on the receipt table, and it is proven by a test that attempts an update and a delete and observes the refusal.

S14 — Exactness of the notice. The receipt carries the string "COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA" verbatim, character for character, including the em dash (U+2014) that separates "SIMULADO" and "SIN". The API exposes it as a field named `notice`, so the frontend renders the exact text instead of rebuilding it.

S15 — Reference format. The reference is sequential and human readable: `REG-<YYYY>-<six digits>`, where `YYYY` is the four-digit calendar year of the issue timestamp and the digits are the counter value zero-padded to six digits (for example `REG-2026-000001`). The counter is the single row of `ShopReceiptCounter`, incremented once per issued receipt under a `SELECT … FOR UPDATE` row lock inside the same transaction; it is never reset, so a reference is unique for the whole database. When the counter exceeds 999999 the numeric part is written in full and never truncated, so uniqueness is preserved.

S16 — Snapshot semantics. The snapshot is a copy taken at approval time: buyer, recipient, items, prices, subtotal, total, delivery information, payment information, the order id, the reference and the issue timestamp. It never changes afterwards. The current `Product.price` may differ from the snapshot price later without the receipt changing: the receipt is a historical document, never a live price.

S17 — Cross-issue change, stated explicitly. The receipt is created INSIDE the same transaction that approves the payment, because that is the only way "una compra simulada aprobada genera referencia única" and "sin dos comprobantes" can be guaranteed under concurrency. The implementation therefore extends the checkout transaction of issue #33. This is an expected and intentional cross-issue change: the pre-existing checkout behavior of issue #33 stays identical — its routes, its status codes, its machine-readable error codes, its idempotency semantics and its lock order (products, then card) — and a differential check against the base of issue #33 is required before closure.

S18 — Frozen REST surface and error code. The routes are `GET /api/v1/shop/receipts` (CLIENT only), `GET /api/v1/shop/receipts/:reference` (CLIENT owner or ADMIN) and `GET /api/v1/shop/admin/receipts` (ADMIN only), all under the global prefix `api/v1` and inside the Shop namespace published by issue #32. The only stable machine-readable code this issue introduces is `SHOP_RECEIPT_ACCESS_DENIED` (HTTP 403). No other route, model, field or code is added by this issue.

S19 — No fiscal content. The receipt carries no tax field of any kind: no IVA, no fiscal document code, no fiscal signature and no banking data. The only monetary values of the receipt are `unitPrice`, `lineTotal`, `subtotal`, `total` and `payment.amount`, all of them the simulated amounts of issue #33.

## Frozen contract (do not renegotiate; issue #35 builds on it)

### Data contract (exact PSL, added by T0)

```prisma
model ShopReceipt {
  id        String   @id @default(uuid())
  reference String   @unique
  orderId   String   @unique
  order     Order    @relation(fields: [orderId], references: [id])
  clientId  String
  client    User     @relation(fields: [clientId], references: [id])
  snapshot  Json
  issuedAt  DateTime @default(now())

  @@index([clientId])
}

model ShopReceiptCounter {
  id    Int @id @default(1)
  value Int @default(0)
}
```

Exactly one relation list is added to the existing `Order` model and exactly one to the existing `User` model:

```prisma
// added inside the existing `model Order { ... }`
  shopReceipt ShopReceipt?

// added inside the existing `model User { ... }`
  shopReceipts ShopReceipt[]
```

Notes that the writer must not break:

- The table names are the model names verbatim, as in the rest of the contract: `public."shopReceipt"` and `public."shopReceiptCounter"`. The `Json` column maps to the same `pg/json@1` scalar already used by `DeliveryAttempt.context`, so the snapshot is a JSON document column and not a text column.
- `ShopReceipt.orderId` is unique, so the database itself guarantees exactly one receipt per order. `ShopReceipt.reference` is unique, so no two receipts share a reference. `@@index([clientId])` supports the CLIENT list and the ADMIN client filter.
- `ShopReceiptCounter` holds exactly one row, `id = 1`, seeded by the migration with `value = 0`. The row is never reset and never deleted; the reference sequence is monotonic for the life of the database.
- The relation `ShopReceipt.order` is the link to the purchase; `ShopReceipt.client` is the owner of the receipt (the CLIENT that bought), and it is the same `User` that the `PaymentAttempt.clientId` points at.
- The migration seam is versioned: the models and the two relation lists go into `src/prisma/contract.prisma`, the emitted artifacts `src/prisma/contract.json` and `src/prisma/contract.d.ts` are regenerated with `pnpm prisma contract emit`, a new migration package is generated under `migrations/app/<timestamp>_<slug>/` with its snapshot under `migrations/snapshots/`, and `pnpm prisma db verify` must report that the database marker matches the contract. No historical migration, snapshot, ops file or hash is edited by hand.
- The migration also installs the immutability trigger and seeds the counter row. The trigger follows the style of the existing agreement guards in `migrations/app/20261013T0005_failed_order_agreement_guards/migration.ts`: a `rawSql` operation whose `execute` step installs a `plpgsql` function with `SET search_path = pg_catalog, public` that raises with `ERRCODE = '23514'`, followed by a `DROP TRIGGER IF EXISTS` / `CREATE TRIGGER` pair, plus a `postcheck` that proves the trigger is enabled. The shape the writer must reproduce is:

```sql
CREATE OR REPLACE FUNCTION public.shop_receipt_immutability_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Shop receipt history is immutable and cannot be updated or deleted'
    USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS shop_receipt_immutability ON public."shopReceipt";
CREATE TRIGGER shop_receipt_immutability
  BEFORE UPDATE OR DELETE ON public."shopReceipt"
  FOR EACH ROW EXECUTE FUNCTION public.shop_receipt_immutability_guard();
```

  with the matching postcheck `SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='shop_receipt_immutability' AND tgenabled='O' AND tgrelid='public."shopReceipt"'::regclass) AS result`.
- The trigger is row-level, so `TRUNCATE` is not blocked by it. The E2E fixtures that need a clean slate truncate the receipt table; they must never `DELETE` a receipt, because the refusal is the behavior under test.
- The database marker must match the contract in force after the migration is applied, and `pnpm prisma db verify` is the proof. The marker of the base stack is not restored nor hand-edited: the contract legitimately changes with this issue, and the migration carries the change.

### Snapshot content

The snapshot is a JSON document written exactly once, at approval time, inside the checkout transaction. It is a copy of the facts of the purchase as they were when the payment was approved; it is never recomputed and never updated.

```json
{
  "orderId": "0f9c…",
  "reference": "REG-2026-000001",
  "issuedAt": "2026-11-05T15:04:05.000Z",
  "buyer": { "id": "b7a1…", "name": "Ana Cliente", "email": "ana@delivery.com" },
  "recipient": { "name": "Ana Cliente", "contactPhone": "0999999999" },
  "items": [
    { "productId": "c1d2…", "productName": "Set de regalo", "quantity": 2, "unitPrice": 39.9, "lineTotal": 79.8 }
  ],
  "subtotal": 79.8,
  "total": 79.8,
  "delivery": {
    "zoneId": "e3f4…",
    "deliveryAddress": "Av. Los Chasquis y Río Guayllabamba, Ambato",
    "scheduledDeliveryDate": "2026-11-10T14:30:00.000Z"
  },
  "payment": { "paymentAttemptId": "d5e6…", "cardLast4": "0001", "amount": 79.8 }
}
```

Field rules:

- `orderId` is the id of the purchased `Order`; `reference` is the reference of the receipt; `issuedAt` is the exact instant the receipt was issued.
- `buyer` is the CLIENT that bought: id, name and email, copied from the `User` row at approval time.
- `recipient` is the recipient of the delivery: name and contact phone, copied from the `Order` recipient fields written by the checkout.
- `items[]` is one entry per `OrderItem`: `productId`, `productName` (the product name at purchase time), `quantity`, `unitPrice` (the price read under the product row lock, the same value stored in `OrderItem.price`) and `lineTotal` (`unitPrice * quantity`).
- `subtotal` is the sum of the `lineTotal` values. `total` is the charged server total of issue #33, which is the persisted `Order.total` and the persisted `PaymentAttempt.amount`. Because the receipt carries no taxes (S19), `subtotal` and `total` are equal.
- `delivery` carries the zone id, the delivery address and the scheduled delivery date of the order. `scheduledDeliveryDate` is `null` when the order has none, mirroring `Order.scheduledDeliveryDate`.
- `payment` carries the id of the `PaymentAttempt` with `outcome = APPROVED`, the last four digits of the simulated card and the charged amount. No card number, no balance and no bank data are ever written into the snapshot.
- The snapshot contains no tax field of any kind, and no field that would later be recomputed from live data.

### Issuance algorithm (inside the checkout transaction of issue #33)

The receipt is written by the checkout transaction, never by a second transaction afterwards. The issuance steps run inside the same transaction callback that creates the `Order`, the `OrderItem` rows and the `PaymentAttempt`:

1. Read the transaction's PostgreSQL clock once (`clock_timestamp()`, the style of `deliveryClock(tx, raw)` in `src/modules/orders/order-delivery.util.ts`). That single instant is the `issuedAt` of the receipt and the source of the `YYYY` part of the reference. The application clock is never used.
2. Lock the counter row and increment it, in the row-lock style of `lockInventoryProduct` in `src/modules/orders/order-inventory.util.ts` — a parameterized `raw.sql` plan built with `.returnsRow({...})` and executed with `tx.query(plan)` on the transaction's pinned connection, so the lock lives until commit or rollback:

```ts
const lockPlan = raw.sql`SELECT id, value FROM public."shopReceiptCounter" WHERE id = ${COUNTER_ID} FOR UPDATE`
  .returnsRow({ id: 'pg/int4@1', value: 'pg/int4@1' }).build();
```

   followed by the increment `UPDATE public."shopReceiptCounter" SET value = value + 1 WHERE id = 1 RETURNING value` executed in the same transaction. The new value is the numeric part of the reference.
3. Build the reference `REG-<YYYY>-<six digits>` from the year of the instant read in step 1 and the counter value read in step 2.
4. Build the snapshot document described in `### Snapshot content` from the already-locked and already-created rows of the transaction (the `Order`, its `OrderItem` rows, the `PaymentAttempt`, the simulated card, the buyer `User` and the product names captured under the product locks).
5. Insert the `ShopReceipt` row with `reference`, `orderId`, `clientId`, `snapshot` and `issuedAt`.
6. Commit. Any failure before the commit rolls back the order, the items, the attempt, the stock and balance decrements, the counter increment and the receipt: a failed checkout consumes no reference and leaves no receipt.

Lock order. The counter row is locked LAST, after the product locks and after the card lock, so the global lock order of issue #33 (products in the consolidated order, then card) is preserved and extended, never reordered. A transaction that locked the counter first could deadlock against a checkout that already holds a product lock.

Idempotent replay. When the checkout of issue #33 answers an idempotent replay, it does so by re-reading the committed `PaymentAttempt` for `(clientId, idempotencyKey)` and the `Order` it points at. The receipt of that order is read with the same lookup (`ShopReceipt.orderId` is unique) and returned. No new reference is consumed and no second receipt is created, in the sequential replay and in the concurrent-same-key case alike.

### REST surface

All three routes live under the global prefix `api/v1` and use the same authentication pattern as the rest of the Shop namespace: `JwtAuthGuard` + `RolesGuard` with `@Roles(...)`. An anonymous request answers 401 on all three.

- `GET /api/v1/shop/receipts` — CLIENT only (`@Roles(Role.CLIENT)`; an ADMIN or DRIVER token answers 403, an ADMIN uses the ADMIN route below).
  - Query: `page` (integer, default 1, min 1) and `pageSize` (integer, default 20, min 1, max 100), validated with the repository's existing pagination DTO convention (`@Transform(integerQuery)`, `@IsInt()`, `@Min(1)`, `@Max(...)`).
  - Success: 200 with `{ items, page, pageSize, total, totalPages }`. The `items` are the receipts of the authenticated CLIENT only, newest first (`issuedAt` descending, with `reference` descending as the stable tie-break). Every item carries `reference`, `orderId`, `total`, `issuedAt` and `notice`. The `total` of an item is read from the immutable snapshot, never from the live `Order.total`, so the list can never disagree with the detail.
- `GET /api/v1/shop/receipts/:reference` — CLIENT owner or ADMIN (`@Roles(Role.CLIENT, Role.ADMIN)`).
  - Success: 200 with the full receipt: `reference`, `orderId`, `clientId`, `total`, `issuedAt`, `notice` and the complete `snapshot`.
  - A CLIENT that requests the receipt of another CLIENT answers 403 with the code `SHOP_RECEIPT_ACCESS_DENIED`.
  - An unknown reference answers 404, for every role, with the repository's standard error body and no additional stable code.
- `GET /api/v1/shop/admin/receipts` — ADMIN only (`@Roles(Role.ADMIN)`).
  - Query: the same `page` and `pageSize`, plus the optional `clientId` filter, which restricts the list to the receipts of that client.
  - Success: 200 with the same `{ items, page, pageSize, total, totalPages }` envelope and the same item projection as the CLIENT list.

The `notice` is a constant of the API surface: every receipt route returns the exact string `COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA` in the field `notice`, and the frontend renders that field verbatim.

Stable machine-readable codes of this issue. Only one:

| Condition | HTTP | `code` |
| --- | --- | --- |
| A CLIENT requests the receipt of another CLIENT | 403 | `SHOP_RECEIPT_ACCESS_DENIED` |

The 404 of an unknown reference and the 401 of an anonymous request use the repository's standard error bodies and carry no stable code of this issue. The six codes of the checkout of issue #33 are untouched by this issue.

## Tasks

T0 | S10,S13,S15,S16,S17 | inline | pending | Data contract and versioned migration seam: add `ShopReceipt` and `ShopReceiptCounter` plus the two relation lists to `src/prisma/contract.prisma`, regenerate `src/prisma/contract.json` and `src/prisma/contract.d.ts`, generate the new migration package under `migrations/app/` with its snapshot, install the `shop_receipt_immutability` trigger and seed the counter row in the same migration, and prove with `pnpm prisma db verify` that the marker matches the contract.
T1 | S15,S16,S19 | delegated | pending | Receipt unit: the reference builder (`REG-<YYYY>-<six digits>`), the counter lock and increment in the `lockInventoryProduct` row-lock style, and the snapshot builder that copies the buyer, recipient, items, prices, subtotal, total, delivery, payment, order id, reference and issue timestamp without any tax field.
T2 | S2,S9,S11,S17 | delegated | pending | Checkout integration: issue the receipt inside the checkout transaction of issue #33 (counter locked last, reference issued once, snapshot written once), return the original receipt on an idempotent replay, and keep the pre-existing checkout behavior of issue #33 identical.
T3 | S3,S4,S12,S14,S18 | delegated | pending | Read endpoints: `GET /api/v1/shop/receipts`, `GET /api/v1/shop/receipts/:reference` and `GET /api/v1/shop/admin/receipts`, with the guards, the pagination, the verbatim `notice` field and the `SHOP_RECEIPT_ACCESS_DENIED` rejection.
T4 | S3,S6,S9,S10,S11,S12,S13,S14 | delegated | pending | Real-PostgreSQL integration tests: uniqueness, idempotency, own consultation, immutable history (the update and the delete are refused) and rejection of other users, plus the rejected-checkout proof that no receipt and no reference are consumed, and the assertion that the `notice` is the exact string of the issue.
T5 | S1,S5,S7,S8,S16,S17 | inline | pending | Differential check of the checkout of issue #33 against its base, full regression, update of the published contract `docs/shop-api-contract.md` and the evidence document `docs/issue-34-shop-receipts.md` with the observed command results.
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

L2 — Branch plan (parent). `feat/34-shop-receipts` is created from `feat/33-shop-checkout-concurrency`, which is itself created from `feat/32-shop-catalog-cloudinary`, which is itself created from `main` @ `13a557e`. The stack is deliberate: the receipt consumes the catalog contract published by #32 and the transactional checkout of #33, so the receipt branch must sit on the checkout branch and not on `main` directly. `main` @ `13a557e` stays the frozen base of the whole stack. Local commits only; RDD off unchanged; no push, no PR creation, no merge, no automatic approval.

L3 — Environment facts (parent, observed). The local `.env` points at PostgreSQL on port 5433 after the container repair of issue #32 (the project container was recreated through the repository's own `docker-compose.yml` with `POSTGRES_PORT=5433`, reusing the same named volume, so the data and the contract marker survived) and the contract marker matches the contract in force at the start of this issue. Unit inventory command: `pnpm test --roots src test`. Integration inventory command: `pnpm run test:e2e`. Known environmental failure (pre-existing, not a regression of this issue): plain `pnpm test` fails before any change with a jest-haste-map parse error caused by the leftover `.issue13-*` scratch directories in the repository root. The `.env` is local, untracked configuration; `.env.example` is untouched.

L4 — Existing code facts the implementation must build on (parent, read-only).
- Row-lock style to reuse for the counter lock: `lockInventoryProduct` in `src/modules/orders/order-inventory.util.ts` — a parameterized `raw.sql` plan (`SELECT id, name, price, stock FROM public.product WHERE id = $1 FOR UPDATE`) built with `.returnsRow({...})` and executed with `tx.query(plan)` on the transaction's pinned connection, so the lock lives until commit or rollback and never runs on a pooled connection outside the transaction. The counter lock must use exactly this style.
- PostgreSQL clock to reuse for the issue instant: `deliveryClock(tx, raw)` in `src/modules/orders/order-delivery.util.ts` — `SELECT clock_timestamp() AS instant` with the `pg/timestamptz-temporal@1` codec, executed on the transaction's pinned connection. The application clock is never used for the reference or for `issuedAt`.
- Trigger style to reuse for the immutability trigger: `migrations/app/20261013T0005_failed_order_agreement_guards/migration.ts` — a `rawSql` operation with `execute` steps that install `plpgsql` functions with `SET search_path = pg_catalog, public` raising with `ERRCODE = '23514'`, followed by `DROP TRIGGER IF EXISTS` / `CREATE TRIGGER … BEFORE UPDATE ON public."order" FOR EACH ROW EXECUTE FUNCTION …`, plus a `postcheck` that proves the trigger is enabled.
- Authentication and authorization pattern to reuse: `JwtAuthGuard` in `src/modules/auth/guards/jwt-auth.guard.ts`, `RolesGuard` in `src/modules/auth/guards/roles.guard.ts` and the `@Roles(...roles)` decorator in `src/modules/auth/decorators/roles.decorator.ts`. The `Role` enum stays importable from `src/modules/auth/dto/register.dto.ts`. An anonymous request is rejected by `JwtAuthGuard` with 401; a role that is not listed is rejected by `RolesGuard` with 403.
- Response projection pattern to reuse: `projectOrder(order, includeContact)` in `src/modules/orders/order-response.util.ts`, the explicit API allowlist used by the existing order routes. The receipt projections follow the same discipline: an explicit allowlist of fields, no raw entity is ever serialized.
- Pagination DTO convention to reuse: `src/modules/orders/dto/list-admin-orders.dto.ts`, with the `integerQuery` transform, `@IsInt()`, `@Min(1)`, `@Max(...)` and the defaults `page = 1` and `pageSize = 20`. The list envelope of the repository is `{ items, total, page, pageSize }`; the Shop namespace published by #32 uses `{ items, page, pageSize, total, totalPages }`.
- Model accessor convention: `PrismaService` in `src/database/prisma.service.ts` exposes one accessor per model, so `ShopReceipt` and `ShopReceiptCounter` need their accessors there. The global `ValidationPipe` in `src/main.ts` runs with `whitelist: true, forbidNonWhitelisted: true`.
- Transaction convention: `OrdersService.persistOrder` in `src/modules/orders/orders.service.ts` is the reference for the transaction shape — `this.prisma.client.transaction(async (tx) => { … })`, with the raw-SQL locks executed through `tx.query(plan)` on the callback's pinned connection and every write performed through `tx.orm.public.<Model>`.
- Table naming: the table name is the model name verbatim (`OrderItem` → `orderItem`, `RouteStop` → `routeStop`, `DeliveryAttempt` → `deliveryAttempt`), so the tables of this issue are `public."shopReceipt"` and `public."shopReceiptCounter"`.

L5 — Parent's frozen decisions for this issue.
1. The receipt is created INSIDE the same transaction that approves the payment. That is the only way "una compra simulada aprobada genera referencia única" and "sin dos comprobantes" can be guaranteed under concurrency. The implementation therefore extends the checkout transaction of issue #33; that is an expected, intentional cross-issue change, and the pre-existing checkout behavior of issue #33 stays identical (S17).
2. Exactly one receipt per order, enforced by a unique constraint on `orderId`.
3. The reference is sequential and human readable: `REG-<YYYY>-<six digits>`. Prisma 8's contract has no sequence support, so the counter is a table `ShopReceiptCounter` with a single row whose value is incremented under a `SELECT … FOR UPDATE` row lock inside the same transaction, using the same raw-SQL row-lock style as the existing helper `lockInventoryProduct` in `src/modules/orders/order-inventory.util.ts`. The counter increments once per issued receipt and never resets.
4. The snapshot is stored as a JSON column and is written exactly once. Immutability is enforced at the database level with a trigger that rejects UPDATE and DELETE on the receipt table, in the style of the existing agreement-guard triggers in `migrations/app/20261013T0005_failed_order_agreement_guards/migration.ts`. The test that proves the trigger refuses an update and a delete is required.
5. The receipt body carries the notice exactly as the issue writes it: `COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA`. The string is required verbatim, character for character including the em dash, and the API exposes it as a field so the frontend renders it.
6. No SRI, no fiscal signature, no real banking, no invented taxes. The receipt carries no tax fields at all.

L6 — Data contract consumed from issue #33 (parent). This issue adds no column to `Order`, `OrderItem` or `PaymentAttempt` and never rewrites them. A purchase is an `Order` plus its `OrderItem` rows plus a `PaymentAttempt` with `outcome = APPROVED`, all written in one PostgreSQL transaction that also decrements the product stock and the simulated card balance. The models consumed as they are: `Order` (with `userId`, `recipientName`, `recipientPhone`, `zoneId`, `deliveryAddress`, `scheduledDeliveryDate`, `total`), `OrderItem` (`productId`, `quantity`, `price`), `PaymentAttempt` (`id`, `orderId`, `cardId`, `clientId`, `idempotencyKey`, `requestHash`, `amount`, `outcome`, `createdAt`, unique on `(clientId, idempotencyKey)`), `SimulatedCard` (`cardNumber`, `holderName`, `last4`, `balance`, `isActive`) and the enum `PaymentOutcome { APPROVED REJECTED }`. The `PaymentAttempt` is the idempotency ledger that protects the receipt (S11).

L7 — Published contract alignment (parent). Issue #32 published the Shop REST contract in `docs/shop-api-contract.md`; its section 5 already describes the receipts of this issue: the three routes, the `notice` string, the `SHOP_RECEIPT_ACCESS_DENIED` code and the receipt shape. The implementation of this issue must stay compatible with that published document, and the differences introduced here (the pagination envelope, the optional `clientId` filter of the ADMIN list, the delivery block and the order id, reference and issue timestamp inside the snapshot) are published as an update of `docs/shop-api-contract.md` in T5, so the frontend issues #19 and #21 keep consuming a single contract.

L8 — Scope boundary of this issue (parent). This issue adds no route to the logistics namespace (`/api/v1/orders`, `/api/v1/products` and the rest keep their exact current meaning), no cart, no fiscal document, no tax, no payment provider and no new error code besides `SHOP_RECEIPT_ACCESS_DENIED`. The simulated cards, the checkout algorithm and its six error codes belong to issue #33 and are consumed here without modification.
