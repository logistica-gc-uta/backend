# Route lifecycle API contracts (unreviewed integration)

## Implemented in this isolated candidate

| Endpoint                                        | Request                | Preconditions                                                                                                                |
| ----------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/routes/:id/start`                 | Empty JSON object      | DRIVER JWT, owned ASSIGNED route, matching active reservations, verified pending ordered stops.                              |
| `POST /api/v1/routes/:id/stops/:stopId/failure` | `RecordFailedVisitDto` | DRIVER JWT, owned IN_PROGRESS route, verified pending stop, active order claim and driver reservation.                       |
| `PATCH /api/v1/orders/:id/status`               | Existing status DTO    | DRIVER uses centralized ASSIGNED → IN_TRANSIT → DELIVERED graph on an active visit. ADMIN cannot cancel operational history. |
| `POST /api/v1/routes/:id/complete`              | Empty JSON object      | DRIVER JWT, one to four verified fully resolved visits with matching persisted attempts and claims.                          |

Failure requires `reason` (`RECIPIENT_ABSENT` or `RECIPIENT_REFUSED`), nonblank
string `context` (maximum 500 characters) and UUID `requestId`. Unknown fields,
including body actor or driver identity, are rejected by ValidationPipe. Route
and failure stop path identifiers use UUID parsing. Identity comes only from JWT.

Typed success schemas are `RouteStartResponseDto`, `VisitAttemptResponseDto`
and `RouteCompletionResponseDto`; the existing order response remains unchanged.
Errors distinguish malformed input (400), invalid JWT (401), wrong role/ownership
(403), absent route/stop/order (404), and conflicting replay or operation (409).
Failure keys bind actor, stable stop and exact payload; equal replay returns the
original result even after completion. Different payload receives 409. Driver
ownership checks precede payload comparison. See [progress semantics](route-progress.md).

Completion releases operational order claims but not the driver reservation or
availability. Failed orders keep their commercial status and administrative-review
block. Claim release alone never restores planning eligibility or schedules retry.

## Still pending

`POST /api/v1/routes/:id/reconcile` remains a request DTO only, with no production
endpoint. `RegularizeLegacyRouteDto` requires nonblank reason (500 characters)
and evidence (2000 characters). Reconciliation must record an ADMIN actor and
audit evidence without invented visits, completion or depot-return timestamps.
Depot return, scheduling-day contract, administrative retry and full rescheduling
are not implemented here. All foundation and service dependencies remain
unreviewed; this documentation does not claim deployment or catalog acceptance.

## T4a depot return and availability integration

`POST /api/v1/routes/:id/return` and owner
`GET /api/v1/drivers/me/availability` are implemented by the isolated T4a unit;
ADMIN driver listing adds the same effective projection without removing fields.
See [depot return](route-depot-return.md) for ownership, errors, transaction/replay
and hold rules. ADMIN `POST /api/v1/routes/:id/reconcile` remains pending T4b;
this unit reads existing reconciliation evidence but never creates it.

## T5b stable historical reads and cancellation claim boundary

Existing ADMIN list/detail and JWT-owned DRIVER route-list reads share
`RouteHistoryResponseDto`, including stable `stops`, immutable `attempts` and
persisted lifecycle `events`. Legacy NULL lifecycle projects API `UNVERIFIED`.
Commercial address/status/schedule remain current; no snapshots are invented.
Historical compatibility `orders` derive RouteStop association and raw sequence,
not the mutable Order.routeId. See [history semantics](route-history.md).

ADMIN cancellation now locks fresh Order identity before checking claims/history,
including pointerless PENDING orders reserved by a confirmed DRAFT. Existing
commercial graph and authorization remain unchanged; claim/visit history requires
administrative reconciliation rather than unsafe cancellation. This does not
implement reprogramming, retry eligibility or new historical order access.

## Administrative legacy reconciliation

`POST /api/v1/routes/:id/reconcile` is ADMIN-only and accepts the existing
`RegularizeLegacyRouteDto` with required reason/evidence strings. Its typed
`RouteReconciliationResponseDto` contains immutable administrative audit and current
availability (null for no driver). It releases only the matching legacy hold;
NULL lifecycle, ambiguous history and order claims remain unchanged. Equal replay
preserves audit and reads availability without rewriting compatibility flags.
See [safe operational prerequisites](route-legacy-reconciliation.md). This is not
physical return, completion or recipient rescheduling.

## T5c compatibility wrapper

Existing ADMIN POST /api/v1/routes/assign now derives only the orders' exact
common non-null scheduledDeliveryDate and confirms/assigns in one transaction.
Null/mismatch409, unavailable/claimed409, invalid body400; no planning algorithm
or calendar policy is introduced. Explicit confirmation and assignment reuse
the same private transaction primitives. All dependencies remain unreviewed.
