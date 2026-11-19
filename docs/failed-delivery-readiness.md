# Failed-Delivery Claim Release & Store Readiness (`CONFIRM_INCIDENT_READY`)

## Purpose

Releases an order's operational `OrderClaim` immediately in the same transaction when its canonical delivery visit is recorded as `FAILED`, without automatically making the order plannable and without requiring the original route to close before administrative resolution.

Because logical claim release does not prove physical possession of the goods at the store while the original driver may still be on route, ordinary failed-delivery `RESCHEDULE` and `PICKUP_AGREE` interventions require an explicit, audited `ADMIN` readiness attestation (`CONFIRM_INCIDENT_READY`) tied to the exact latest canonical failed `DeliveryAttempt`. Customer outreach (`CONTACT`) remains allowed immediately.

## Write-Side Lifecycle

### 1. Canonical Failed Visit (`POST /api/v1/routes/:id/stops/:stopId/failure`)

In one atomic transaction (`RouteProgressService.fail`):

- Creates the immutable `DeliveryAttempt` (`outcome = 'FAILED'`, `failureReason`, `recordedAt`).
- Transitions `RouteStop.outcome` from `PENDING` to `FAILED`.
- Sets `Order.requiresAdministrativeReview = true` without rewriting `Order.status` or `Order.routeId` (the order stays excluded from automatic planning).
- Releases only the exact old `OrderClaim` on `(routeId, orderId)` with `releasedAt = attempt.recordedAt`.
- Idempotent replay with the same `requestId`, actor, and payload returns the persisted attempt without modifying any old or newer claims or order state.

### 2. Original Route Completion (`POST /api/v1/routes/:id/complete`)

`RouteProgressService.complete` validates `FAILED` stops from their immutable historical evidence (`RouteStop`, `DeliveryAttempt`, and historical `OrderClaim` on the completing route) rather than consulting newer order state:

- If a `FAILED` stop already released its claim at `attempt.recordedAt`, completion succeeds even after the order has been resolved (`RESCHEDULE`, `PICKUP_AGREE`, `PICKUP_CONFIRM`), replanned onto a newer route, or redelivered.
- Only still-active valid claims belonging to the completing route (`SUCCESSFUL` stops and any legacy pre-migration unreleased `FAILED` stops — even when an earlier pre-start `MOVE` out/back left an unrelated released claim before `attempt.recordedAt`) are released at `completedAt`.
- Newer claims on other routes and earlier pre-start or failed-claim release timestamps are never modified.

### 3. Store Readiness Attestation (`POST /api/v1/dispatch/interventions`)

- **Action**: `CONFIRM_INCIDENT_READY`
- **Authorization**: `ADMIN` via JWT (`JwtAuthGuard` + `RolesGuard`), verified as a current `ADMIN` inside the transaction.
- **Request Body**:
  ```json
  {
    "action": "CONFIRM_INCIDENT_READY",
    "requestId": "11111111-1111-4111-8111-111111111111",
    "orderId": "22222222-2222-4222-8222-222222222222",
    "attemptId": "33333333-3333-4333-8333-333333333333",
    "reason": "Returned order or replacement verified at store"
  }
  ```
- **Persistence**: Reuses `DispatchIntervention` (`action = 'CONFIRM_INCIDENT_READY'`, `outcome = 'APPLIED'`, `orderId`, `routeId`, `payload.attemptId`, `result.attemptId`). No duplicate store-readiness table or flag is added.
- **No Side Effects on Attestation**: Never triggers auto-replanning and never mutates `Order`, `Route`, `RouteStop`, `OrderClaim`, or `DriverReservation`.
- **Preconditions under lock (`Driver -> Route -> Order`)**:
  1. Order is under administrative review (`requiresAdministrativeReview = true`) and not commercially resolved (`DELIVERED` / `CANCELLED`).
  2. No `OrderPickup` exists yet.
  3. Order is not an emergency-only or post-failure emergency custody order (`RouteUnitRecovery` / `RouteEmergency` remains separate).
  4. `attemptId` matches the exact latest canonical `FAILED` `DeliveryAttempt` on a non-legacy `FAILED` stop of a verified `IN_PROGRESS`, `COMPLETED`, or `INTERRUPTED` route.
  5. The order has zero active claims and a verified released `OrderClaim` on the failed stop's route (matching `attempt.recordedAt` while the original route is `IN_PROGRESS`).
  6. No prior `APPLIED` `CONFIRM_INCIDENT_READY` exists for `(orderId, attemptId)` (duplicate with a new `requestId` rejects with `409 INCIDENT_ALREADY_READY`; exact `requestId` + actor + payload replays `200 OK`).

### 4. Audited Resolution (`CONTACT`, `RESCHEDULE`, `PICKUP_AGREE`, `PICKUP_DECLINE`)

- `CONTACT`: Allowed immediately after failure (before readiness confirmation and before route completion), unless a store pickup has already been agreed (`409 PICKUP_ALREADY_AGREED`) or active emergency custody owns the order (`409 EMERGENCY_CUSTODY_SEPARATE` for attempt-scoped contact; emergency-scoped `CONTACT` with `emergencyId` remains separate).
- `PICKUP_DECLINE`: Rejects with `409 RECOVERY_PENDING` when emergency unit recovery is pending, `409 EMERGENCY_CUSTODY_SEPARATE` when active emergency custody owns the order, and `409 PICKUP_ALREADY_AGREED` once a store pickup exists.
- `RESCHEDULE` and `PICKUP_AGREE` for ordinary failed deliveries:
  - Require persisted `APPLIED` `CONFIRM_INCIDENT_READY` evidence for the exact latest canonical failed `attemptId` (stale readiness from an earlier attempt is rejected with `409 INCIDENT_NOT_READY_AT_STORE`).
  - Require the verified failed claim to be released (`releasedAt = attempt.recordedAt` on `IN_PROGRESS`, or `releasedAt >= attempt.recordedAt` on `COMPLETED`/`INTERRUPTED`, distinguishing the failure release from unrelated earlier pre-start `MOVE`-out claims) and zero active claims on the order.
  - Reject with `409 PICKUP_ALREADY_AGREED` under the `Order` row lock whenever an `OrderPickup` already exists (pending or confirmed).
  - Do **not** require the original route to be `COMPLETED` or `INTERRUPTED` when the verified failed claim was canonically released.
- Normal pre-start (`DRAFT` / `ASSIGNED`) interventions, `RELEASE_DRAFT`, `CANCEL_ROUTE`, and emergency custody recovery (`EMERGENCY_DECLARE`, `UNIT_RECOVERY_CONFIRM`, `EMERGENCY_REQUEUE`, `RESCHEDULE`/`PICKUP_AGREE` with `emergencyId`) remain separate and unchanged.

## PostgreSQL Defense-in-Depth

The forward migration (`migrations/app/20261119T1717_failed_delivery_readiness`) updates:

- `dispatch_audit_valid` CHECK constraint to include `CONFIRM_INCIDENT_READY`.
- `t1e_claim_history_guard`: allows releasing an active claim on an `IN_PROGRESS` route only in the same transaction as its canonical `FAILED` `DeliveryAttempt` (`releasedAt = d.recordedAt`, `requiresAdministrativeReview = true`).
- `t1e_failed_attempt_claim_release` (scoped deferred `AFTER INSERT` constraint trigger on `deliveryAttempt` when `NEW.outcome = 'FAILED'`): enforces that every **new** canonical `FAILED` attempt atomically releases its exact matching `OrderClaim` (`releasedAt = NEW.recordedAt`, same transaction `xmin`, zero remaining active claims on that route/order) without invalidating valid pre-migration historical rows.
- `t1e_validate_route_coherence`: permits canonically failed-released stops on `IN_PROGRESS` routes without active claims or original `order.routeId` pointers, and preserves pre-migration active-claim `FAILED` stops even when unrelated earlier pre-start `MOVE`-out released claims exist (`releasedAt < d.recordedAt`), while keeping `PENDING`/`SUCCESSFUL`, `DRAFT`, `ASSIGNED`, `COMPLETED`, `INTERRUPTED`, and `CANCELLED` invariants strict.
- `t1e_validate_stop_visit`: allows clearing `requiresAdministrativeReview` for a `FAILED` stop while its original route is `IN_PROGRESS` only with audited `RESCHEDULE`/`PICKUP_AGREE`, canonically released claim, and persisted `CONFIRM_INCIDENT_READY` evidence (preserving completed/interrupted legacy histories).
- `dispatch_review_resolution_guard`: requires `CONFIRM_INCIDENT_READY` and a verified released claim (`releasedAt = d.recordedAt` on `IN_PROGRESS`, `releasedAt >= d.recordedAt` on `COMPLETED`/`INTERRUPTED`) for ordinary failed-attempt `RESCHEDULE` and `PICKUP_AGREE` without requiring original route closure, and vetoes `RESCHEDULE`/`EMERGENCY_REQUEUE` whenever an `OrderPickup` already exists for the order.
- `dispatch_pickup_conflict` (`BEFORE INSERT` on `dispatchIntervention` for `APPLIED` `CONTACT`/`RESCHEDULE`): vetoes direct SQL `CONTACT` or `RESCHEDULE` rows once an `OrderPickup` exists for that order.
- `dispatch_incident_ready_guard` (`BEFORE INSERT` on `dispatchIntervention`) and partial unique index `dispatch_incident_ready_unique_attempt_idx` on `("orderId", (payload ->> 'attemptId')) WHERE action = 'CONFIRM_INCIDENT_READY' AND outcome = 'APPLIED'`: enforce database-level uniqueness under concurrency and block direct SQL forged, stale, unreleased-claim, emergency-custody, or duplicate `CONFIRM_INCIDENT_READY` rows.

## Post-Commit Realtime

`CONFIRM_INCIDENT_READY` publishes `dispatch.incident.updated` (`{ orderId, routeId, action: 'CONFIRM_INCIDENT_READY', requiresAdministrativeReview: true }`) exclusively to authenticated `ADMIN` subscribers on `incidents:admin`.

## Read-Side Inbox Projection (`GET /api/v1/dispatch/inbox`)

`GET /api/v1/dispatch/inbox` preserves existing top-level collections (`date`, `timeZone`, `urgencies`, `incidents`, `interruptedRoutes`, `pendingRecoveries`) and existing incident fields (`orderId`, `routeId`, `pickup`, `attempts`) while adding typed incident readiness, ownership, and action-eligibility metadata.

> [!IMPORTANT]
> Incident evidence (`incidents`, `interruptedRoutes`, `pendingRecoveries`) is read inside a single PostgreSQL `REPEATABLE READ, READ ONLY` transaction snapshot and agreement expiry is evaluated against PostgreSQL `clock_timestamp()` (matching `POST /api/v1/dispatch/interventions`), without altering unrelated urgency proposals or exposing recipient PII or raw audit payloads. Every `POST /api/v1/dispatch/interventions` write still revalidates preconditions atomically under locks.

### Incident Status & Ownership

| Field | Values | Meaning |
|-------|--------|---------|
| `ownership` | `FAILED_DELIVERY` \| `EMERGENCY_CUSTODY` \| `ADMINISTRATIVE_REVIEW` | Distinguishes ordinary failed-delivery handling from genuine emergency custody (determined by linked `RouteUnitRecovery`/`RouteEmergency`, never by generic `INTERRUPTED` route status alone) and review orders without canonical failed-attempt evidence. |
| `status` | `WAITING_STORE_READINESS` | Ordinary failed delivery waiting for store readiness attestation (no `CONTACT` recorded for latest attempt yet). |
| | `CONTACTED` | Ordinary failed delivery with at least one applied `CONTACT` for the latest canonical failed attempt, still waiting for store readiness. |
| | `READY_AT_STORE` | `CONFIRM_INCIDENT_READY` applied for the exact latest canonical failed attempt; ready for `PICKUP_AGREE` or `RESCHEDULE` (when a valid agreement exists). |
| | `PENDING_PICKUP` | Store pickup agreed (`OrderPickup` exists with `confirmedAt = null`); ready for `PICKUP_CONFIRM`. |
| | `PICKED_UP` | Store pickup already confirmed (`confirmedAt != null`). |
| | `EMERGENCY_CUSTODY` | Active emergency custody owns resolution (`emergencyId` and `emergency` context are populated). |
| | `REVIEW_WITHOUT_FAILED_ATTEMPT` | `requiresAdministrativeReview = true` with no canonical non-legacy failed attempt and no emergency custody. |
| `latestFailedAttemptId` | `string \| null` | Exact latest canonical failed `DeliveryAttempt.id` across non-legacy failed stops. |
| `readiness` | `{ auditId, attemptId, confirmedAt, confirmedById } \| null` | Minimal persisted `CONFIRM_INCIDENT_READY` attestation for the exact `latestFailedAttemptId`; stale readiness from an earlier attempt returns `null`. |
| `emergencyId` / `emergency` | `string \| null` / `{ emergencyId, routeId, recoveryResolved, pendingUnitsCount, totalUnitsCount } \| null` | Populated only when `ownership = 'EMERGENCY_CUSTODY'`; unit counts and `recoveryResolved` are scoped strictly to the selected `emergencyId`. |
| `activeAgreementId` | `string \| null` | Latest unconsumed future confirmed `CONTACT` agreement ID for `latestFailedAttemptId` (when not in pickup or emergency custody). |

### `allowedActions` Snapshot & `reasonCode` Reference

Each incident exposes `allowedActions` keyed by existing `DispatchIntervention` actions (`CONTACT`, `CONFIRM_INCIDENT_READY`, `RESCHEDULE`, `PICKUP_AGREE`, `PICKUP_DECLINE`, `PICKUP_CONFIRM`), each with `{ allowed, reasonCode, reason }`:

| Action | Allowed When | Common Disabled `reasonCode`s |
|--------|--------------|-------------------------------|
| `CONTACT` | Ordinary failed delivery with resolved emergency recovery and no pickup yet (immediately after failure, before route closure or readiness). | `RECOVERY_PENDING`, `EMERGENCY_CUSTODY_SEPARATE`, `FAILED_ATTEMPT_NOT_FOUND`, `PICKUP_ALREADY_AGREED`, `PICKUP_ALREADY_CONFIRMED`, `ORDER_COMMERCIALLY_RESOLVED` |
| `CONFIRM_INCIDENT_READY` | Ordinary failed delivery with verified route evidence, released failed claim, zero active claims, and no existing readiness for `latestFailedAttemptId`. | `CLAIM_NOT_RELEASED`, `ORDER_CLAIMED_BY_ANOTHER_ROUTE`, `INVALID_FAILED_ATTEMPT`, `INCIDENT_ALREADY_READY`, `RECOVERY_PENDING`, `EMERGENCY_CUSTODY_SEPARATE`, `PICKUP_ALREADY_AGREED` |
| `RESCHEDULE` | Same readiness + claim prerequisites as `PICKUP_AGREE`, plus an unconsumed future confirmed `CONTACT` agreement for `latestFailedAttemptId` and eligible delivery/depot coordinates. | `INCIDENT_NOT_READY_AT_STORE`, `RESCHEDULE_AGREEMENT_REQUIRED`, `DELIVERY_COORDINATES_REQUIRED`, `CLAIM_NOT_RELEASED`, `ORDER_CLAIMED_BY_ANOTHER_ROUTE`, `EMERGENCY_CUSTODY_SEPARATE`, `PICKUP_ALREADY_AGREED` |
| `PICKUP_AGREE` | Ordinary failed delivery with verified route evidence, released failed claim, and `readiness` confirmed for `latestFailedAttemptId`. | `INCIDENT_NOT_READY_AT_STORE`, `CLAIM_NOT_RELEASED`, `ORDER_CLAIMED_BY_ANOTHER_ROUTE`, `EMERGENCY_CUSTODY_SEPARATE`, `PICKUP_ALREADY_AGREED` |
| `PICKUP_DECLINE` | Ordinary failed delivery with canonical failed attempt and no agreed pickup yet. | `FAILED_ATTEMPT_NOT_FOUND`, `RECOVERY_PENDING`, `EMERGENCY_CUSTODY_SEPARATE`, `PICKUP_ALREADY_AGREED` |
| `PICKUP_CONFIRM` | Agreed `OrderPickup` exists with `confirmedAt = null` and no active route claim. | `PICKUP_NOT_AGREED`, `PICKUP_ALREADY_CONFIRMED`, `CLAIM_NOT_RELEASED`, `ORDER_COMMERCIALLY_RESOLVED` |

### Example Incident Item

```json
{
  "orderId": "22222222-2222-4222-8222-222222222222",
  "routeId": "44444444-4444-4444-8444-444444444444",
  "pickup": null,
  "attempts": [
    {
      "id": "33333333-3333-4333-8333-333333333333",
      "stopId": "55555555-5555-4555-8555-555555555555",
      "outcome": "FAILED",
      "failureReason": "RECIPIENT_ABSENT",
      "recordedAt": "2026-11-19T17:10:00Z"
    }
  ],
  "status": "READY_AT_STORE",
  "ownership": "FAILED_DELIVERY",
  "latestFailedAttemptId": "33333333-3333-4333-8333-333333333333",
  "readiness": {
    "auditId": "66666666-6666-4666-8666-666666666666",
    "attemptId": "33333333-3333-4333-8333-333333333333",
    "confirmedAt": "2026-11-19T17:15:00Z",
    "confirmedById": "77777777-7777-4777-8777-777777777777"
  },
  "emergencyId": null,
  "emergency": null,
  "activeAgreementId": "88888888-8888-4888-8888-888888888888",
  "allowedActions": {
    "CONTACT": { "allowed": true, "reasonCode": null, "reason": null },
    "CONFIRM_INCIDENT_READY": {
      "allowed": false,
      "reasonCode": "INCIDENT_ALREADY_READY",
      "reason": "Store readiness has already been confirmed for the latest failed attempt"
    },
    "RESCHEDULE": { "allowed": true, "reasonCode": null, "reason": null },
    "PICKUP_AGREE": { "allowed": true, "reasonCode": null, "reason": null },
    "PICKUP_DECLINE": { "allowed": true, "reasonCode": null, "reason": null },
    "PICKUP_CONFIRM": {
      "allowed": false,
      "reasonCode": "PICKUP_NOT_AGREED",
      "reason": "No agreed store pickup to confirm"
    }
  }
}
```
