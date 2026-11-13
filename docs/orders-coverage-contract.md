# Orders use store coverage instead of client-selected zones (#42)

REGALÍA shop checkout and ADMIN order creation send a delivery point. The backend decides coverage with the #41 store polygon and the same configurable `America/Guayaquil` hours. Clients do not select a zone.

## HTTP (adapted consumers)

| Method | Path | Auth | Coverage + hours |
| --- | --- | --- | --- |
| `POST` | `/api/v1/shop/checkout/quote` | CLIENT JWT | Required |
| `POST` | `/api/v1/shop/checkout` | CLIENT JWT + idempotency | Re-evaluated against **current** coverage and **current** shop hours |
| `POST` | `/api/v1/orders/admin` | ADMIN JWT | Required (date and coordinates already required) |
| `POST` | `/api/v1/orders` | CLIENT JWT (legacy) | Coverage if lat/lng present; hours if `scheduledDeliveryDate` present |

`delivery.zoneId` / body `zoneId` is optional. If sent, it is ignored for eligibility. Persistence stores that FK when present so existing dispatch can attach the order; omitted zoneId stays `null`. Never invent a default zone.

## Eligibility

Reuse `StoreCoverageService.evaluatePoint` (`docs/store-coverage-contract.md`).

| Result | HTTP | `error.code` |
| --- | --- | --- |
| Interior or boundary | continue | — |
| Exterior | 422 | `DELIVERY_OUTSIDE_COVERAGE` |
| Store/coverage not configured | 409 | `STORE_NOT_CONFIGURED` |
| Invalid coordinates | 400 | `STORE_LOCATION_INVALID` or existing coordinate validation |
| Time outside inclusive shop hours | 422 | `DELIVERY_OUTSIDE_HOURS` |

Hours come from ShopSettings `deliverySchedule` (`startTime`/`endTime`, timezone `America/Guayaquil`). Inclusive bounds: with 07:00–17:00, 07:00 and 17:00 are accepted; 06:59 and 17:01 are rejected on Shop **and** ADMIN.

## Quote → confirm consistency

The quote token still binds buyer, lines, prices, `settingsVersion`, address, coordinates, and schedule. It no longer requires `zoneId`.

Confirm:

1. Keeps existing item/delivery/token/idempotency/stock/price checks.
2. Re-runs coverage against the **current** singleton polygon (not a frozen quote polygon).
3. Re-runs hours against **current** ShopSettings.

If ADMIN changed coverage or hours after quote, confirm fails closed: no order, no receipt, no stock/balance debit. Existing checkout-attempt rows follow the current idempotency contract (an attempt may exist without a purchase).

Old `qtk_v1` tokens that still contain `zoneId` remain verifiable. Confirm compares recipient/address/coordinates/schedule, not zone.

## Persistence

New orders store `Order.zoneId` only when the client still sent one. Omitted zoneId is `null`. Existing rows keep their zone. As of #49, `Route.zoneId` is optional and nullable (`string | null`) across planning, draft confirmation, route assignment, execution, completion, urgent dispatch proposals, and interventions. There is no fake default zone.

Receipt snapshots stop inventing zone names. Delivery on the receipt is address + coordinates + schedule (+ notes). `zoneId`/`zoneName` are null when unused. Shop order detail reads those nulls; it does not require a zone name.

Planning proposals (`GET /api/v1/route-proposals`), route confirmation/assignment (`POST /api/v1/routes`, `POST /api/v1/routes/assign`), execution/progress, and urgent dispatch (`GET /api/v1/dispatch/orders/:id/proposal`, `POST /api/v1/dispatch/interventions`) plan and dispatch null-`zoneId` orders using configured `StoreCoverage` as the origin depot (`zoneId: null`, `zoneCode: null` on proposals). `orderBelongsToRouteZone(order.zoneId, route.zoneId)` also allows null-`zoneId` orders to join either `zoneId: null` routes or a `Route.zoneId` selected by ADMIN, while rejecting conflicting non-null zones. Existing zoned orders remain plannable (using `StoreCoverage` when configured, or their zone depot).

## Legacy CLIENT create

Optional `scheduledDeliveryDate` and optional coordinates remain. Omitted date stays `null` (no invented schedule, no auto-assign to a route). Coverage is not treated as success when coordinates are absent.

## Address edit

`PATCH /api/v1/orders/:id` is status-only. This issue does not add address mutation. When an edit surface exists later, it must use current coverage and existing reservation/active-route policy (no silent operational edits).

## Consumers not implemented here

| Issue | Use this contract |
| --- | --- |
| [web #33](https://github.com/logistica-gc-uta/frontend-web-logistica/issues/33) | Quote/confirm bodies without required `zoneId`. Treat `configured: false` / `STORE_NOT_CONFIGURED` and `DELIVERY_OUTSIDE_COVERAGE` as hard stops. |
| [web #34](https://github.com/logistica-gc-uta/frontend-web-logistica/issues/34) | ADMIN create with point + schedule; same hour codes. |
| [backend #49](https://github.com/logistica-gc-uta/backend/issues/49) | Implemented: planning, route confirmation/assignment (`zoneId?: string | null`), execution/progress, urgent dispatch proposals, and dispatch interventions operate without requiring `Zone`/`zoneId` when `StoreCoverage` is configured. |

Do not implement #45 payments, OSRM, GPS, or delete Zone/Route APIs here.
