# Confirmed drafts and explicit assignment

These primitives use unreviewed T1a/T1b/T1c/T2a dependencies. They are not an
approved integrated feature. No optimization or draft composition endpoint is
implemented. Scheduling-day/timezone policy remains incomplete; no general calendar compatibility or Issue #10 acceptance is claimed.

## HTTP contracts

| Operation                        | ADMIN request                                                               | Successful response                                                    |
| -------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `POST /api/v1/routes`            | `zoneId`, explicit ISO timestamp `routeDate`, 1–4 unique ordered `orderIds` | 201 DRAFT, no driver reservation                                       |
| `POST /api/v1/routes/:id/assign` | UUID route path, `driverId`                                                 | 200 ASSIGNED, operational reservation and compatibility order pointers |

Existing JWT/database-role guards and validated JWT actor authorize both
operations; body actor fields are rejected. Required fields, bounds, timestamp
syntax and unknown body fields fail with 400; unauthenticated calls fail with
401, wrong roles with 403, missing resources with 404 and eligibility/resource/
lifecycle conflicts with 409. Responses retain `id`, `driverId`, `zoneId`, `date`
and `createdAt`, with typed DRAFT/ASSIGNED status and serialized Temporal instants.

The existing ADMIN `POST /api/v1/routes/assign` accepts the unchanged
`driverId`, `zoneId`, `orderIds` body and responds201 with ASSIGNED route fields.
The validated JWT actor is passed server-side. The wrapper derives route date
only from all selected orders' exact common non-null scheduledDeliveryDate;
null/mismatch rejects409 before persistence. No current-time or calendar/day
inference occurs. Confirmation and assignment invoke private shared primitives
inside ONE callback transaction, not two public transactional calls. Driver is
locked before route creation and sorted order locks; order eligibility/date/claims
are revalidated under locks. Competing claims/reservations reject409; any failure
rolls back route, stops, claims, reservation, commercial pointers and projection.

## Temporary stricter timestamp guard

Only explicit proposals whose nonnull order schedule instants exactly equal the
supplied route instant are accepted. Assignment revalidates the same equality.
Equivalent ISO offsets denote the same instant; no timezone/day normalization or
inference from nullable dates occurs. This is a conservative temporary guard,
not a decided business rule for same-day scheduling.

## Atomic ownership and availability

Confirmation creates its locked DRAFT row then locks orders by sorted identity, rechecks PENDING/no administrative
hold/no active claim, and creates DRAFT, stable nonlegacy PENDING stops and claims
with server timestamps in one transaction. Commercial order status stays PENDING;
claims exclude another active proposal, not future planning eligibility. Existing
order cancellation coordination with claims requires separate integration proof.

Assignment locks the driver with its freshly checked user mapping, then the route,
then sorted orders and matching active claims. It rejects non-DRAFT, unavailable
projection, active reservation, IN_PROGRESS/ASSIGNED/unreturned verified route,
and unresolved legacy driver holds. Audited legacy release is recognized only
with ADMIN identity and the existing nonblank reason/string-evidence contract;
no historical event is invented. A returned route alone cannot override an active
reservation or unavailable projection. The partial driver/claim indexes and T1c
structural guards remain enabled during owned PostgreSQL proof.

Conditional DRAFT→ASSIGNED, server reservation time, order ASSIGNED/routeId/
stopOrder compatibility pointers and driver availability projection commit
atomically. Failed validation or unexpected post-write failure rolls back every
write. No-op identity locks add MVCC write cost but never overwrite a status from
an unlocked read. Future return/edit/cancellation operations must honor shared
lock/claim protocols. No start, return, reschedule or automatic claim release is
implemented here; unresolved drafts remain reserved until a future supported
composition/release operation is authorized.

Legacy wrapper wrong-zone input returns400 after confirming zone existence (missing zone404). Active claim/date/hold conflicts remain409; fresh locked shared eligibility revalidation remains mandatory.
