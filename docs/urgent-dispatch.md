# Urgent dispatch and ADMIN intervention (#12)

`GET /api/v1/dispatch/inbox` lists today's PENDING urgencies in `America/Guayaquil` and failed visits requiring administrative review. `GET /api/v1/dispatch/orders/:id/proposal` computes a temporary proposal; both require the current JWT actor to be ADMIN.

## Read-only proposals

| Kind | Meaning |
| --- | --- |
| INSERT | Compatible verified DRAFT/ASSIGNED route, fewer than four stops, same zone/business day, eligible orders and coordinates. The proposed sequence is recalculated with Clarke & Wright/Haversine. |
| NEW_ROUTE | No insertion fits; a one-order departure is proposed with effectively available drivers. Availability is advisory until locked confirmation. |
| BLOCKED | The order remains unchanged; `reasons` exposes invalid geography, eligibility, date, claim/review holds or `NO_AVAILABLE_DRIVER`. |

No GET creates proposals, routes, claims, reservations or assignments. A proposal fingerprint identifies the relevant snapshot, not an authorization or reservation. Frozen IN_PROGRESS/COMPLETED routes are never insertion targets. Availability retains the depot-return hold.

## Privacy and compatibility

The inbox omits recipient contact and free-text attempt context. DRIVER failure, route start/progress/history/return and existing planning/assignment endpoints retain their contracts. Socket.IO and frontend work are outside this issue; later events must follow successful persistence.

## Verification status

Unit A: 13 proposal/inbox tests passed after an observed missing-implementation RED. HTTP/PostgreSQL confirmation and the remaining ADMIN intervention workflow are still under implementation; this document does not claim complete Issue #12 acceptance.
