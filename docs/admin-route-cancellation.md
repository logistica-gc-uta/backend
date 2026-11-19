# Admin Route Cancellation Before Start (`CANCEL_ROUTE`)

## Purpose

Allows an authenticated `ADMIN` to cancel an `ASSIGNED` delivery route before the driver starts it, while preserving complete operational history, restoring the route's orders to plannable `PENDING` (never commercially cancelling them), and releasing the driver's operational reservation hold.

Unassigned `DRAFT` routes continue to use the existing `RELEASE_DRAFT` action without any breaking change.

## HTTP Contract

- **Endpoint**: `POST /api/v1/dispatch/interventions`
- **Authorization**: `JwtAuthGuard` + `RolesGuard` + `@Roles(Role.ADMIN)`; actor identity is derived strictly from the JWT subject and verified as a current `ADMIN` inside the transaction.
- **Request Body** (`DispatchInterventionDto`):
  ```json
  {
    "action": "CANCEL_ROUTE",
    "requestId": "11111111-1111-4111-8111-111111111111",
    "routeId": "22222222-2222-4222-8222-222222222222",
    "reason": "Vehicle cannot depart"
  }
  ```
- **Validation**:
  - `requestId`: UUID v4 idempotency key.
  - `routeId`: UUID of the assigned route.
  - `reason`: non-blank string, 1..500 characters.
  - Extra fields (including actor impersonation fields) are rejected with `400 Bad Request`.
- **Response (`200 OK`)**: `DispatchAuditDto` with `action: "CANCEL_ROUTE"`, `outcome: "APPLIED"`, `routeId`, `orderId: null`, `actorId`, `reason`, `recordedAt`, and structured `result` (`routeId`, `driverId`, `orderIds`, `cancelledAt`, `releasedOrderCount`, `driverReleased`).
- **Idempotency**:
  - Exact replay (`requestId` + same `actorId` + identical canonical payload) returns the persisted `DispatchAuditDto` with zero business writes and zero realtime re-publication.
  - Reusing `requestId` with a different actor or payload returns `409 Conflict` with zero business writes.

## Eligibility & Invariants

A route can be cancelled via `CANCEL_ROUTE` only when ALL of the following hold under lock:

1. `route.status === 'ASSIGNED'` (rejects `DRAFT`, `IN_PROGRESS`, `COMPLETED`, `INTERRUPTED`, `CANCELLED`, and legacy `null`).
2. `route.driverId` is non-null and has exactly one matching active `DriverReservation` (`releasedAt IS NULL`, `reservedAt IS NOT NULL`).
3. No execution/completion/return/cancellation timestamps or actors exist on the route, and no `RouteEmergency` exists.
4. `1..4` non-legacy `RouteStop` rows with contiguous `1..N` sequences, `outcome = 'PENDING'`, and zero `DeliveryAttempt` rows.
5. Exact 1-to-1 matching active `OrderClaim` rows (`releasedAt IS NULL`, `claimedAt IS NOT NULL`) for every stop.
6. Every referenced `Order` is `status = 'ASSIGNED'`, `routeId = route.id`, `requiresAdministrativeReview = false`, and no stray orders point to `route.id`.

## Persistence & History Guarantees

- **Terminal State**: `Route.status = 'CANCELLED'` with `cancelledAt`, `cancelledById`, and trimmed `cancelReason`. `startedAt`, `completedAt`, and `returnedAt` remain `NULL` (no fabricated start or depot return).
- **Retained History**:
  - `Route.driverId` is retained for `ADMIN` history (`GET /api/v1/routes` and `GET /api/v1/routes/:id`).
  - `RouteStop`, `OrderClaim` (`releasedAt = cancelledAt`), and `DriverReservation` (`releasedAt = cancelledAt`) rows are preserved and never deleted.
  - `RouteHistoryService` emits a `CANCELLED` lifecycle event (`{ kind: 'CANCELLED', actorId, recordedAt }`).
- **Driver Projection**: `DriversService.findMyRoutes` (`GET /api/v1/drivers/me/routes`) excludes `CANCELLED` routes so mobile driver views stay clean without requiring mobile app changes.
- **Driver Availability**: `RouteAvailabilityService` releases the driver hold once the reservation is released and verified cancellation evidence is present, while respecting calendar `DriverAbsence` records.

## Concurrency & Lock Ordering

`RouteCancellationService.cancel`, `RouteExecutionService.start`, and `RouteAssignmentService.assignInTransaction` all acquire row locks in the same global hierarchy used across dispatch mutations:

1. `Driver`
2. `Route`
3. `Order` (sorted ascending by `id`)

This guarantees `CANCEL_ROUTE` serializes cleanly without deadlocks or double-reservations against both `POST /api/v1/routes/:id/start` and competing driver reservations (`POST /api/v1/routes/:id/assign` on the same driver). Any failure inside the transaction rolls back all business writes, `DispatchIntervention` audit rows, and skips post-commit realtime publication.

## PostgreSQL Defense-in-Depth

The forward migration (`migrations/app/*_route_cancellation`) enforces:

- `route_status_check` includes `CANCELLED`; `dispatch_audit_valid` includes `CANCEL_ROUTE`.
- `route_cancellation_consistent` CHECK enforces paired `cancelledAt`/`cancelledById`/`cancelReason`, non-null `driverId`, and null execution timestamps when `status = 'CANCELLED'`.
- `route_integrity_guard`: blocks deleting `CANCELLED` routes, direct `INSERT` as `CANCELLED`, transitions to `CANCELLED` from any state other than `ASSIGNED`, mutating `driverId`, `zoneId`, or `date` on the `ASSIGNED → CANCELLED` transition update itself (as well as after `CANCELLED`), mutations/regressions after `CANCELLED`, and transitions without a same-transaction `APPLIED` `ADMIN` `CANCEL_ROUTE` row in `dispatchIntervention`.
- `route_cancellation_order_restoration` (deferred `CONSTRAINT TRIGGER` scoped strictly to `AFTER UPDATE OF status ON public.route WHEN (OLD.status = 'ASSIGNED' AND NEW.status = 'CANCELLED')`): enforces at the cancellation transaction commit boundary that every original stop's order is restored to `status = 'PENDING'` with `routeId IS NULL` and `stopOrder IS NULL`, without ever blocking subsequent legitimate replanning, reassignment, or delivery of those orders in later transactions.
- `route_stop_integrity_guard` & `t1e_validate_stop_visit`: freeze stop structure on `CANCELLED` routes and forbid outcomes/attempts.
- `t1e_claim_history_guard` & `t1e_reservation_history_guard`: permit releasing active claims/reservations on `CANCELLED` only at `cancelledAt` with a same-transaction `CANCEL_ROUTE` audit.
- `t1e_validate_route_coherence`: verifies at commit that `CANCELLED` routes retain `1..4` pending stops, hold zero active claims/reservations, have zero order pointers, and match their released reservation and `CANCEL_ROUTE` audit.

## Post-Commit Realtime Invalidation

Published only after database commit (never inside the transaction, never on replay or rejection):

- `route.updated` (`{ routeId, status: 'CANCELLED' }`)
- `order.status.updated` (`{ orderId, status: 'PENDING', requiresAdministrativeReview: false }`) per released order
- `driver.availability.updated` (`{ driverId, available }`) respecting active `DriverAbsence`

`dispatch.incident.updated` is intentionally **not** emitted because pre-start cancellation is not a failed-delivery incident.
