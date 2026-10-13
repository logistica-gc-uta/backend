# Read stable route history without inventing snapshots

Existing ADMIN `GET /api/v1/routes` and `/routes/:id`, and JWT-owned DRIVER
`GET /api/v1/drivers/me/routes`, now share history fields with role-specific typed
responses. ADMIN uses `AdminRouteHistoryResponseDto`; DRIVER retains restricted
`RouteHistoryResponseDto`. No parallel
history endpoint is added. ADMIN contact and explicit rescheduling are now available through [urgent dispatch](urgent-dispatch.md); prior stops and attempts remain intact. These isolated
implementation bytes and their dependencies remain unreviewed.

## What each field means

| Field                              | Meaning                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `date`                             | Persisted historical route date, not the order's current schedule.                                                                            |
| `status`                           | Persisted lifecycle; API `UNVERIFIED` projects legacy NULL without updating it.                                                               |
| `stops[].routeId/orderId/sequence` | Stable visit association and position. NULL, duplicate and invalid legacy positions are retained.                                             |
| `stops[].outcome`                  | Persisted visit outcome; NULL is not a fabricated success or failure.                                                                         |
| `stops[].attempts`                 | Immutable actor (`driverId`), recorded time, outcome, failure reason and textual context. Private request payload and replay key are omitted. |
| `events`                           | Persisted STARTED/COMPLETED/RETURNED actor/time pairs. No event is inferred for legacy rows.                                                  |
| `orders`                           | Historical associations with **current** commercial address/status/schedule; `stopOrder` aliases stable `RouteStop.sequence`.                 |

There are no historical address or schedule snapshots in this contract. A later
commercial pointer or address change must not rewrite the first visit's route,
position, outcome or attempts. ADMIN retains its previous relation/scalar fields;
DRIVER retains only its existing safe commercial order fields plus history.

## Authorization and ordering

DRIVER identity comes only from the verified JWT subject and persisted profile.
Routes are scoped by `Route.driverId` before fetching history, including after
`Order.routeId` moves elsewhere. Another driver's list cannot expose those routes.
ADMIN detail returns 404 for absent routes; direct DRIVER route-detail access
remains forbidden. Existing direct `GET /orders/:id` DRIVER ownership intentionally
still follows the **current operational pointer**; history authorization is not
expanded into that endpoint.

The optional local-day date filter, unknown/repeated query rejection and empty
list behavior remain unchanged. Stops sort by raw sequence, NULL last, then stop
ID; attempts sort by actual instant, then attempt ID. A route list performs one
batched RouteStop query (including Order) and one batched DeliveryAttempt query,
not a query per route or stop. Empty lists avoid empty IN queries.

## Cancellation and DRAFT coordination

A confirmed DRAFT creates an active claim while commercial status remains PENDING
and the order may have no live route pointer. Cancellation therefore locks fresh
Order identity before reading claims and history, after any Driver → Route locks.
It rereads assignment after the lock and retains the centralized commercial graph.
A DRAFT-first transaction makes cancellation wait and return 409; cancellation
first makes the DRAFT wait and reject CANCELLED eligibility. A status-only CAS
cannot protect this claim boundary.

## Verification boundary

Owned PostgreSQL16 tests use fresh databases, real production modules/JWT/Swagger,
legacy seeding before structural guards, injected transaction rollback and actual
`pg_blocking_pids` barriers in both lock orders. Future associations in the history
test are fixture-only SQL, not an implemented administrative retry API. Existing
legacy create-and-assign and calendar-policy gaps are intentionally unchanged.

## Swagger and physical return

The exact history lifecycle enum is UNVERIFIED/DRAFT/ASSIGNED/IN_PROGRESS/COMPLETED.
Physical return records a RETURNED **event** and nullable return actor/time audit;
it does not introduce a RETURNED route state. ADMIN metadata includes the existing
full Order scalar fields and driver/user/zone relations already returned by the
service. DRIVER metadata includes its existing selected nullable audit fields,
safe order attributes and restricted zone fields, not ADMIN-only relations.
Serialized Swagger schemas are checked against actual HTTP property sets.
The existing ADMIN user relation includes its password field; this metadata-only
correction documents that pre-existing response and does not expand DRIVER access
or silently change the ADMIN response policy.
