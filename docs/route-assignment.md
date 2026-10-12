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

## Business-day schedule guard

Confirmation (`POST /routes`) and the assignment of a DRAFT accept an order only
when its non-null `scheduledDeliveryDate` falls on the **same `America/Guayaquil`
calendar day** as the route instant (`routeDate` when confirming, `Route.date`
when assigning). Orders may be scheduled at different hours of that day, which is
what the route planning proposal (`GET /route-proposals`, see
[route-planning.md](./route-planning.md)) produces: its `routeDate` is the earliest
scheduled instant of the proposal. A null schedule, or one on another local day,
is rejected with 409 before persistence.

The day boundary is local midnight, not UTC: `2026-10-11T04:59:59Z` belongs to
October 10 and `2026-10-11T05:00:00Z` to October 11. Instants on the same local day
may fall on different UTC dates (`23:30Z` and `04:00Z` the next UTC day are both
evening of the same Guayaquil day). The comparison is revalidated under the same
order locks as before; it replaces the previous exact-instant equality.

The legacy `POST /routes/assign` keeps the **stricter** rule described above: it
derives the route date from one exact common non-null scheduled timestamp and
rejects any mismatch, so its behaviour does not change.

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
