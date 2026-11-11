# ADMIN declared external purchase and commercial receipt (#45)

This is the D0 decision record for backend issue #45. It is the contract web #34 may consume. It does not implement frontend #34 or unified history #46. Shop simulated-card checkout is unchanged.

Base: `37050c02ceea940e03cb051a740258dc60e6391b` (includes #42). Path `POST /api/v1/orders/admin` remains the ADMIN write; it is extended, not replaced by a parallel unused endpoint.

## Buyer identity

| Case | `buyer.type` | Owner `Order.userId` | Account |
| --- | --- | --- | --- |
| Registered CLIENT | `REGISTERED_CLIENT` + `clientId` | that User | Must exist and `role=CLIENT`. ADMIN actor is never the buyer. Non-CLIENT → 400 `Registered owner must be a CLIENT`. Missing → 404 Nest `Registered client not found` (not `PRODUCT_NOT_FOUND`). |
| Guest | `GUEST` + `name` | `null` | No User/email/password is created. Phone matching a registered account does not link, grant access, or mutate that account. |

## Buyer phone

Required for both buyer types. Validation (no country policy): trim; length 1–40; must contain a non-whitespace character (same family as existing guest `recipientPhone`). Never read `User` for a phone (User has none). Registered buyer without `buyer.contactPhone` → 400, no sale.

## Recipient / operational contact

| Body | Delivery `recipientName` / `recipientPhone` | Buyer snapshot on the order |
| --- | --- | --- |
| `giftRecipient` omitted | Buyer name + buyer phone (registered name from User.name at sale) | `buyerName`, `buyerPhone` |
| `giftRecipient` `{ name, contactPhone }` | Gift name/phone | Buyer name/phone stay distinct |

ADMIN may later correct **operational** fields on the order only: `buyerPhone`, `recipientName`, `recipientPhone`, and guest `buyerName`. Not `userId`, `createdById`, amounts, payment, receipt, or User rows.

`contactRevision` starts at 0 and increments on each successful correction. PATCH must send the current revision; mismatch → 409 `CONTACT_REVISION_CONFLICT`.

## External declaration

Body `payment.method` is `CASH` or `TRANSFER` only. Optional `payment.note` max 200, not a bank reference and not required.

Server-owned (ignored/stripped if sent; extra keys → 400 `forbidNonWhitelisted`):

- `declaredById` = JWT `sub` (ADMIN)
- `declaredAt` = database `clock_timestamp()`
- money totals, tax rate applied, receipt number

No simulated card, debit, gateway approval, or mandatory bank reference. Transfer without a reference is a **declaration**, not a verified bank credit. Unsupported method → 400.

Persisted as `ExternalPaymentDeclaration` (1:1 with the order). Shop `PaymentAttempt` is **not** created for these sales.

## Pricing

Authoritative product `priceCents` (safe integer), Shop settings tax (HALF_UP once on subtotal via `calculateMoneyAmounts` / `calculateTaxAmountCents`), shipping `FREE_INCLUDED` amount 0. Client totals are not trusted.

Golden case: subtotal 7300, rate 1500 bps (15%) enabled, VAT 1095, shipping 0, total 8395. All stored on the receipt and snapshot.

ADMIN eligibility stays current ADMIN rules (no Shop publication/SKU/category extra gates). Coverage + inclusive Guayaquil hours remain #42.

## Legacy totals

| Field | Semantics |
| --- | --- |
| `Order.total` | Unchanged: float **subtotal** of line `price * quantity` (legacy). Not tax-inclusive. |
| `Order.subtotalCents` | Integer-cent subtotal of the sale. |
| `PurchaseReceipt.totalCents` | Tax-inclusive commercial total (`subtotalCents + taxAmountCents`). |

Do not redefine `Order.total` as the receipt grand total.

## Persistence

| Row | Guest | Registered |
| --- | --- | --- |
| `PurchaseReceipt.buyerId` | `NULL` | owner User id |
| `Order.userId` | `NULL` | owner User id |
| Snapshot `buyer` | `{ name, phone }` no email fabricated | `{ name, phone, email }` from User |
| Snapshot `payment` | `{ kind: 'ADMIN_DECLARED_EXTERNAL', status: 'DECLARED', method, declaredById, declaredAt }` | same |
| Snapshot `recipient` | `{ name, phone }` delivery contact | same |

Shop card receipts keep `{ kind omitted or SIMULATED_CARD, status: APPROVED, reference, cardLast4 }`. Parsers must not require card fields on declared receipts or email/phone fabrication on historical card receipts.

SQL: unique order↔receipt; unique order↔declaration; `buyerId` nullable **only** when the paired order has `userId IS NULL` and a declaration exists. No placeholder email, fake ADMIN buyer, or fake gateway reference.

## Atomicity and locks

One transaction, lock order:

1. Advisory lock `hashtext('admin_purchase')`, `hashtext(actorId || ':' || idempotencyKey)` (same idea as Shop `checkout_intent`).
2. Stock product rows with existing `lockInventoryProduct` / `FOR UPDATE` order (product id sort).
3. Insert order, items, declaration, receipt, attempt SUCCEEDED snapshot together.

Insufficient stock: existing Nest 400 Spanish stock message; no order/receipt/declaration/stock change. Coverage/hours: existing #42 Shop envelopes (422/409). Late failure after a write rolls back the transaction: no success body, no orphan rows.

Rejected input does **not** require an `AdminPurchaseAttempt` row except after an attempt key was reserved as PROCESSING (then REJECTED/FAILED with errorCode). Validation failures before lock may have zero attempt row.

## Repeat / uncertain result

Header `Idempotency-Key` required UUIDv4 (same as Shop confirm).

| Situation | Result |
| --- | --- |
| Same actor + key + canonical payload hash | Replay original success or original rejection; no second stock decrement |
| Same actor + key + different hash | 409 `IDEMPOTENCY_KEY_REUSED`; no other buyer/actor data |
| PROCESSING and lock held | 409 `ADMIN_PURCHASE_IN_PROGRESS`; `GET /api/v1/orders/admin/purchase-attempts/:idempotencyKey` |
| PROCESSING stale ≥ 15 min and lock free | mark FAILED `INTERNAL_ERROR` (no stock mutation), same as Shop orphan reconciler |
| Lost success response | GET attempt or POST replay returns stored success snapshot |

Canonical hash covers buyer, gift recipient, payment.method, items, address, coordinates, schedule, zoneId. Actor and server time are not client-supplied.

`GET` attempt is ADMIN-only and scoped to the JWT actor. Another ADMIN's key → 404 indistinguishable.

## Authorized reads

| Who | Order | Receipt |
| --- | --- | --- |
| Registered buyer CLIENT | existing `GET /api/v1/shop/orders/:id` and `GET /api/v1/orders/:id` (own) | `GET /api/v1/shop/orders/:id/receipt` |
| Other CLIENT / DRIVER | 403/404 as today | 404 `ORDER_NOT_FOUND` |
| ADMIN | existing `GET /api/v1/orders/:id` | **new** `GET /api/v1/orders/:id/receipt` printable JSON (registered and guest). Not a PDF generator. Guest phone is not a credential. |

## HTTP create body (success)

`POST /api/v1/orders/admin` ADMIN JWT + `Idempotency-Key`.

```json
{
  "buyer": { "type": "REGISTERED_CLIENT", "clientId": "<uuid>", "contactPhone": "+593…" },
  "giftRecipient": { "name": "…", "contactPhone": "+593…" },
  "payment": { "method": "CASH" },
  "deliveryAddress": "…",
  "deliveryLat": -1.249,
  "deliveryLng": -78.616,
  "scheduledDeliveryDate": "2030-02-14T15:00:00.000Z",
  "items": [{ "productId": "<uuid>", "quantity": 1 }],
  "zoneId": "<optional uuid>"
}
```

Guest buyer: `{ "type": "GUEST", "name": "…", "contactPhone": "…" }`. `giftRecipient` optional. `payment.method` `CASH` | `TRANSFER`. `recipient` from #11 is **replaced** by `buyer` + optional `giftRecipient` (breaking ADMIN create; fixtures/Newman adapted in T6).

Legacy CLIENT `POST /api/v1/orders` unchanged (no receipt, optional phone).

## Errors (create)

| Case | HTTP | Envelope |
| --- | --- | --- |
| Unauthenticated | 401 | Nest |
| CLIENT/DRIVER | 403 | Nest |
| DTO / missing buyer phone / bad method | 400 | Nest validation or `BadRequestException` |
| Missing registered client | 404 | Nest `Registered client not found` |
| Insufficient stock | 400 | existing Spanish stock message |
| Exterior | 422 | `DELIVERY_OUTSIDE_COVERAGE` |
| Hours | 422 | `DELIVERY_OUTSIDE_HOURS` |
| Unconfigured store | 409 | `STORE_NOT_CONFIGURED` |
| Idempotency conflict | 409 | `IDEMPOTENCY_KEY_REUSED` |
| In progress | 409 | `ADMIN_PURCHASE_IN_PROGRESS` |

Do not attach class-wide `ShopHttpExceptionFilter` on OrdersController. Keep `OrdersCreateHttpExceptionFilter` dual-path.

## Contact correction

`PATCH /api/v1/orders/:id/contact` ADMIN. Body `{ contactRevision, buyerPhone?, recipientName?, recipientPhone?, buyerName? }`. At least one contact field. Guest-only `buyerName`. Server actor/time. Append-only `OrderContactAudit` (field, previous, next, actorId, createdAt).

`GET /api/v1/orders/:id/contact-history` ADMIN.

Unauthorized/invalid/conflict: no contact, audit, or business mutation.

## Out of scope

Real PSP, SRI invoice, bank verification, automatic messaging, React/PDF UI, #46 unified list. Shop card flow and historical receipt numbering stay.

## Consumer inventory (T6)

See plan D6 table: `test/admin-guest-orders-*.ts`, `test/run-e2e-isolated.mjs` migration target, `delivery-api.postman_collection.json` ADMIN bodies, `src/prisma/seed.ts` DEMO coverage/settings, `orders.controller.spec.ts`, Shop receipt parsers, load seeds. Re-search after DTO land.
