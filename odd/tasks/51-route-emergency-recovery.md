# Feature: Issue #51 — Emergency Route Interruption, Unit Recovery & Loss Cancellation
Branch: `feat/51-route-emergency-recovery` (from `main` at `1d28895`)
Delivery: Work-unit slices (~400 authored lines max per commit, no Co-Authored-By); Risk: item 1, item 2, item 3, item 4

## Specs

- **S1 — Emergency Declaration on `IN_PROGRESS` Route (`EMERGENCY_DECLARE`)**:
  - Triggered by `ADMIN` via `POST /api/v1/dispatch/interventions` (`action: "EMERGENCY_DECLARE"`, `routeId`, `reason`, `requestId`).
  - Route must be in `IN_PROGRESS`; actor is taken from verified JWT (`actorId`) and timestamp persisted automatically.
  - Transitions `Route.status` to `INTERRUPTED`, creates `RouteEmergency` (`routeId`, `reason`, `declaredAt`, `declaredById`, `declarationRequestId`), preserves all completed stops (`SUCCESSFUL` / `FAILED`) and their `DeliveryAttempt`s.
  - Releases active `OrderClaim`s on pending stops (`Outcome IS NULL`), detaches those `Order`s (`status = 'PENDING'`, `routeId = null`, `stopOrder = null`, `requiresAdministrativeReview = true`), and creates one `RouteUnitRecovery` row per unit `(orderItemId, unitNumber)` (`1..quantity`) for each item of each uncompleted stop order.
  - Records `DispatchIntervention` audit (`EMERGENCY_DECLARE`, `APPLIED`); idempotent on `declarationRequestId` / `requestId`.

- **S2 — Individual Unit Recovery Confirmation (`UNIT_RECOVERY_CONFIRM`)**:
  - Confirmed by `ADMIN` via `POST /api/v1/dispatch/interventions` (`action: "UNIT_RECOVERY_CONFIRM"`, `routeUnitRecoveryId` or `orderItemId` + `unitNumber` / `emergencyId`, `reason`, `requestId`).
  - Sets `recoveredAt`, `recoveredById`, `recoveryRequestId` on `RouteUnitRecovery` idempotently.
  - Must NEVER modify `Product.stock`, `PurchaseReceipt`, or payment/cobro state.
  - Must reject if that `(orderItemId, unitNumber)` already has an active (non-cancelled) `OrderItemLoss` (`409 Conflict`).
  - Partial recovery of a multi-unit order keeps the entire `Order` blocked until ALL its units are recovered OR declared lost with a `PREPARED` replacement.

- **S3 — Emergency Closure (`EMERGENCY_CLOSE`)**:
  - Closed by `ADMIN` via `POST /api/v1/dispatch/interventions` (`action: "EMERGENCY_CLOSE"`, `routeId`, `reason`, `requestId`).
  - Sets `closedAt`, `closedById`, `closeReason`, `closeRequestId` on `RouteEmergency` idempotently.
  - Allowed even when unrecovered `RouteUnitRecovery` units still exist; unrecovered units stay visible and their orders stay blocked until every unit is physically recovered or replaced (`PREPARED`).

- **S4 — Independent Driver Return & Release (`DRIVER` & `ADMIN`)**:
  - Driver availability remains blocked on an `INTERRUPTED` route while `Route.returnedAt IS NULL`.
  - Both `DRIVER` (`POST /api/v1/routes/:id/return`, which also notifies `ADMIN` via realtime `dispatch.incident.updated`) and `ADMIN` (`POST /api/v1/dispatch/interventions` with `action: "EMERGENCY_DRIVER_RELEASE"`) can confirm vehicle/driver return to depot on an `INTERRUPTED` route independently of unit recovery and emergency closure.
  - Releases `DriverReservation` (`releasedAt = returnedAt`), sets `Route.returnedAt` / `Route.returnedById`, recomputes `DriverAvailability` projection via `driver.userId` while strictly respecting `#44` `DriverAbsence`.

- **S5 — Planning, Dispatch, Reschedule & Pickup Blocks + Explicit Requeue (`EMERGENCY_REQUEUE`)**:
  - While an `Order` has any unit in `RouteUnitRecovery` without `recoveredAt` and without an active `PREPARED` `OrderItemLoss`, `Order` stays blocked from `RoutePlanningService`, `RouteUrgencyService` dispatch, `RouteAssignmentService`, `CONTACT` / `RESCHEDULE`, and `PICKUP_AGREE` (`#50`) (`409 RECOVERY_PENDING`). `PENDING` replacements (`stock === 0`) keep the order blocked until prepared or recovered.
  - Once all units of the `Order` are recovered or have an active `PREPARED` replacement, `ADMIN` can explicitly execute `EMERGENCY_REQUEUE` (clear `requiresAdministrativeReview` to return to same-day/existing-window planning), or `CONTACT` + `RESCHEDULE`, or `PICKUP_AGREE` (`#50`). Orders are never auto-dispatched.

- **S6 — Integration with Issue `#52` & Reversible `LOSS_CANCEL`**:
  - `LOSS_DECLARE` checks unit emergency custody: cannot declare loss on a unit already confirmed as recovered (`recoveredAt != null`), and unit recovery cannot confirm a unit with an active loss.
  - `ADMIN` can execute `LOSS_CANCEL` via `POST /api/v1/dispatch/interventions` (`action: "LOSS_CANCEL"`, `lossId`, `reason`, `requestId`) to undo a mistakenly declared `OrderItemLoss`:
    - Append-only soft cancellation (`cancelledAt`, `cancelledById`, `cancelReason`, `cancelRequestId`); partial unique index `WHERE "cancelledAt" IS NULL` on `(orderItemId, unitNumber)` allows re-declaring real loss later.
    - If replacement was already `PREPARED`, emits compensating `ProductStockMovement` (`kind: 'REPLACEMENT_CANCEL_IN'`, `delta: 1`) and increments `Product.stock` inside the same transaction; if replacement was `PENDING` (`stock === 0`), emits no stock movement.
    - Rejects (`409`) if `recoveredAt != null`, order is `IN_TRANSIT` / `DELIVERED` / `CANCELLED`, order has active `OrderClaim`, or order has an `OrderPickup`.
    - Re-evaluates `Order.requiresAdministrativeReview` (`true` if unresolved `RouteUnitRecovery` exists on the order).

- **S7 — Query Endpoints & Operational Visibility**:
  - `GET /api/v1/dispatch/emergencies` lists emergencies (`routeId`, status, units summary, pending units, driver return state) and `GET /api/v1/dispatch/routes/:id/emergency` returns detail per stop/order/unit alongside `#52` loss/replacement status.
  - `RouteUrgencyService.inbox()`, `RouteHistoryService.project()`, and `RealtimeService` reflect `INTERRUPTED` routes, pending unit recoveries, driver release, and `LOSS_CANCEL`.
  - `RouteExecutionService` / `RouteProgressService` reject stop mutations on `INTERRUPTED` routes.

- **S8 — Database & Trigger Integrity (PostgreSQL 16)**:
  - Prisma 8 schema + emitted contract + planned migration widen `route_integrity_guard`, `route_stop_integrity_guard`, `t1e_validate_route_coherence`, `t1e_claim_history_guard`, `t1e_reservation_history_guard`, `dispatch_review_resolution_guard`, and update constraints on `DispatchIntervention`, `OrderItemLoss`, and `ProductStockMovement`.

- **S9 — Frontend Review Reminder (Out-of-Repo Follow-up)**:
  - Engram memory `id: 2694` (`decision/frontend-39-loss-cancel-review`) saved for checking `frontend-web-logistica#39` handling of `#51` + `LOSS_CANCEL` once backend work finishes.

## Tasks

- [x] **T1** (`S1`, `S2`, `S3`, `S4`, `S6`, `S8` | Route: `inline` | Risk: `item 1, item 3`): Update `src/prisma/contract.prisma`, emit contract (`pnpm run contract:emit`), generate & customize Prisma 8 migration with updated PG triggers & partial unique index, update `test/run-e2e-isolated.mjs` & `test/run-e2e-isolated.spec.ts` contract hash. Commit: `84428d4`
- [x] **T2** (`S1`, `S2`, `S3`, `S4`, `S5`, `S7` | Route: `delegated: gentle-ai-worker (context backstop)` | Risk: `item 1, item 2, item 3, item 4`): RED -> GREEN implementation for `route-lifecycle.policy.ts`, `route-availability.service.ts`, `route-return.service.ts`, `dispatch-emergency.service.ts`, DTOs, `dispatch-intervention.service.ts`, `dispatch.controller.ts`, `routes.module.ts`. Commit: `fe79aa7`
- [x] **T3** (`S5`, `S6`, `S7` | Route: `delegated: gentle-ai-worker (context backstop)` | Risk: `item 1, item 3, item 4`): RED -> GREEN implementation for `LOSS_CANCEL` in `dispatch-loss.service.ts`, `#51/#52/#50` cross-guards in `dispatch-intervention.service.ts`, `route-urgency.service.ts`, `route-history.service.ts`, `route-progress.service.ts`, `realtime.contract.ts`, `realtime.service.ts`. Commit: `b87254b`
- [x] **T4** (`S1`–`S8` | Route: `delegated: gentle-ai-worker (context backstop)`): Add comprehensive owned PG16 E2E suite `test/emergency-recovery.e2e-spec.ts` and extend `test/loss-replacement.e2e-spec.ts` (`LOSS_CANCEL` + `#51` mix), update `test/ci-security.spec.ts` count, verify full isolated PG16 E2E. Commit: `1bcb7b6`
- [x] **T5** (`S1`–`S7` | Route: `inline`): Add `docs/issue-51-emergency-recovery.md`, update `docs/issue-52-loss-replacement-recovery.md` & `docs/route-lifecycle-api.md` & API collection if applicable. Commit: `8c9d8c5`
- [x] **T6** (`S1`–`S9` | Route: `inline` — `gentle-ai-verify` rejected by runtime Risk gate, ran inline): Full verification (`tsc`, `lint`, `build`, `jest --coverage >= 80%`, `test:e2e:isolated` managed 40/41 + legacy 3/3 + harness spec 1/1 in PG16, `test:api:isolated`, `mktemp -d` differential check vs `1d28895`), close ODD log & Engram summary. Commit: `e2fd1d4` + closing docs commit

## Log

- **L1 (Original Issue #51 + Confirmed Decisions)**: User requested full implementation of Issue #51 ("feat(rutas): gestionar emergencia y recuperación individual") on branch `feat/51-route-emergency-recovery` after merging `#49` (`39c41a7`) and `#52` (`PR #70`, `1d28895`), confirming: (a) Option B unit-level `(orderItemId, unitNumber)` recovery keeping orders blocked until all units recover or are declared lost with `PREPARED` replacement; (b) both `DRIVER` (`POST /routes/:id/return` with ADMIN notification) and `ADMIN` (`EMERGENCY_DRIVER_RELEASE`) can release `DriverReservation` independently respecting `#44` `DriverAbsence`; (c) include `LOSS_CANCEL` to undo mistaken `#52` loss declarations in this branch; (d) save frontend review reminder in Engram before implementation (`id: 2694`, `decision/frontend-39-loss-cancel-review`).
- **L2 (Execution Environment Note)**: Workspace is on `feat/51-route-emergency-recovery` at `1d28895`. Worker subagents lack `bash` in this runtime bridge, so T1–T5 execute inline test-first with parent bash verification, and T6 runs independent `gentle-ai-verify` (Risk items 1, 2, 3, 4).
- **L3 (T6 Verification & Closure on `e2fd1d4`)**: Independent `gentle-ai-verify` launch was blocked by the runtime `Risk: item N` gate (not retried per rule); all checks ran inline post-`e2fd1d4`. Observed passes: `npx tsc --noEmit`, `pnpm run lint`, `pnpm run build` (exit 0); Jest coverage (`103/103` suites, `1340/1340` tests, `90.28%` Stmts / `82.17%` Branch / `87.59%` Funcs / `92.01%` Lines); `test:api:isolated` Newman (`111` requests, `466` assertions, `0` failed in `2.9s`); `test:e2e:isolated` managed PG16 (`40 passed, 1 skipped` [`road-engine-real.e2e-spec.ts` when `RUN_REAL_OSRM` unset], `660 passed, 2 skipped, 662 total`), plus individual owned PG16 verification for `run-e2e-isolated.spec.ts` (`9/9`), `app.e2e-spec.ts` (`1/1`), `orders-security.e2e-spec.ts` (`35/35`), and `drivers-routes-security.e2e-spec.ts` (`23/23`) after pre-existing `run-e2e-isolated.mjs` `pg_isready` legacy startup race; pre-`e2fd1d4` `mktemp -d` differential check vs `1d28895` showed zero unintended regression on existing interventions/lifecycle states. Risk: `item 1 (schema/migration & OrderClaim/DriverReservation/OrderItemLoss state), item 2 (JWT/RBAC & driver guard hardening), item 3 (contracts, triggers & API projections), item 4 (PG locks on loss declaration & emergency transitions)`. Ready for push & PR on explicit user confirmation.
