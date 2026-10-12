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

## Atomic ADMIN decisions

`POST /api/v1/dispatch/interventions` requires `requestId` (UUID), `action`, and a nonblank `reason` (≤500 characters). Actor comes exclusively from the current JWT and database ADMIN role. `GET /api/v1/dispatch/audit` exposes append-only outcomes.

| Action | Required resource fields | Behavior |
| --- | --- | --- |
| CONFIRM | orderId, fingerprint; driverId for NEW_ROUTE only | Revalidate under locks, insert/resequence or atomically create and assign a departure. |
| REJECT | orderId, fingerprint | Persist rejection, leave order/route unchanged. |
| REORDER | routeId, orderIds | Exact permutation of verified pre-start stops. |
| MOVE | orderId, routeId, targetRouteId | Atomically release source claim, resequence nonempty source and reserve compatible destination. |
| REASSIGN_DRIVER | routeId, driverId | ASSIGNED only; validate effective availability and switch audited reservations. |
| PRIORITIZE | orderId | Eligible unclaimed PENDING only; prioritize inbox without changing commercial status. |

Keys are global. Exact actor/body replay returns the original outcome; altered actor/body returns 409. Stale fingerprints, frozen routes and resource conflicts return 409. Drivers are locked first, then sorted routes and sorted orders. PostgreSQL partial unique claims/reservations and lifecycle guards remain authoritative; exceptions roll back the entire mutation. Stops are recreated only before start with existing identities retained, to avoid transient unique-sequence collisions.

The new official-CLI `urgent_dispatch_audit` migration creates the audit model and narrows pre-start release exceptions to an ADMIN audit inserted in the same transaction. It does not change old migration files/hashes, frozen-route guards, failure attempts or completed stop history. No temporary proposal table exists.

B evidence: real isolated PostgreSQL/JWT HTTP tests passed (5 cases); 37 focused unit/assignment tests passed; TypeScript and focused type-aware lint passed. Rescheduling, full concurrency, full-suite evidence and independent verification remain pending.

## Explicit agreement and retry

CONTACT uses `orderId`, `agreementConfirmed` and (for an unresolved failure) the latest `attemptId`. A false agreement records management only and must omit scheduling fields. A true agreement requires `scheduledDeliveryDate`, `deliveryWindowStart`, and `deliveryWindowEnd`: explicit ISO offsets, one Guayaquil day, schedule within the window, and strictly future schedule/window start. Use minimal reasons, never conversation/contact snapshots.

RESCHEDULE uses `orderId` and `agreementId` (the CONTACT audit ID). It revalidates geography, agreement freshness/consumption and PostgreSQL wall-clock timing under locks. Failed R1 must be COMPLETED with its order claim released. Reprogramming preserves commercial order identity/items and all R1 stop IDs, sequences, outcomes and attempts; it clears the review hold and expressly sets the same order PENDING, not an automatic failure transition. A reserved pre-start order may be removed only while leaving a nonempty valid route; no started route structure is changed. A later future-date DRAFT/assignment can use existing ADMIN routes endpoints; same-day urgencies also support CONFIRM.

Driver reservations remain held through completion until DRIVER confirms depot return. R2 gets a new stable stop, while R1 retains all historical visits. The SQL-only `agreed_delivery_rescheduling` migration adds an audited review-resolution guard and a genuine data invariant (failure hold or matching audited reschedule). Its check fails closed on inconsistent legacy data; it never manufactures agreement evidence. No contract artifacts are re-emitted for this SQL-only step.

C evidence: both absence/refusal R1→R2 PostgreSQL/JWT scenarios passed, including missing agreement, duplicate/conflicting schedule, original-history equality and pre-return driver rejection. Exact fixture instants use PostgreSQL microsecond precision.
