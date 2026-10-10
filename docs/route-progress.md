# Route progress integration (unreviewed)

This isolated unit depends on unreviewed T1a policy, T1b history contract, T1c
integrity guards, T2a explicit start and T5a request DTOs. It is not deployed or
approved by review, and does not claim full Issue #10 acceptance.

## HTTP behavior

All progress identities come from validated JWT and the current DRIVER profile.

- `POST /api/v1/routes/:id/stops/:stopId/failure`: requires the failed-visit DTO,
  a verified pending stop, matching active order claim and driver reservation.
  Records a FAILED attempt and marks administrative review without changing the
  commercial order status. Both recipient absence and refusal are supported.
- `PATCH /api/v1/orders/:id/status`: DRIVER progresses ASSIGNED to IN_TRANSIT,
  then DELIVERED through the existing centralized commercial transition policy.
  DELIVERED atomically records SUCCESSFUL evidence and resolves the stable stop.
- `POST /api/v1/routes/:id/complete`: requires an empty JSON object and one to
  four contiguous verified resolved visits, matching attempts and active claims.
  Persists completion actor/time and releases only those order claims. Driver
  reservation and `isAvailable` remain unchanged until later verified return.

ADMIN cancellation is blocked for operational claims or any stable visit history;
this conservative boundary requires a future administrative reconciliation path,
not a commercial endpoint shortcut. Unassociated nonterminal orders retain the
existing cancellation graph.

## Transaction and replay boundary

Each operation uses a supported Prisma callback transaction, locking Driver
before Route through no-op conditional updates and re-reading ownership. The
Route row serializes duplicate attempts and closure against progress writes.
Failure UUID keys are scoped to the stable stop; persisted canonical payload
includes the JWT actor, reason and exact untrimmed context. Structural equality
is independent of JSONB key ordering. Different actor or payload receives 409
once authorized; cross-driver ownership is rejected first with 403. Equal replay
after completion returns the original attempt identity and server timestamp.

The existing successful-delivery endpoint has no client request key. Its durable
key is `delivery:<stable stop ID>` and a persisted actor/status payload. Retries
are idempotent while the compatibility order route pointer still selects that
stop; after a future reassignment this endpoint cannot identify an old visit.
Failure replay retains explicit route/stop identity and does not share that
ambiguity. Neither endpoint automatically schedules another visit.

Context is stored as `{ description: <supplied string> }` because the installed
Prisma rc.11 JSON codec fails to decode ordinary JSON string return values. The
failure response retains the exact context string supplied by the caller.

## Evidence and remaining gaps

Tests use real HTTP, JWT database-role verification, owned labeled PostgreSQL16
containers on random loopback ports, and a fresh database per test. Concurrent
identical requests execute separate runtime transactions, and injected errors
prove rollback of attempt, outcome and review flag together. Cleanup asserts the
owned container and scratch directory are removed.

T1c protects frozen structure and append-only existing evidence, but does not
validate every inserted attempt against route state, actor, claim or outcome;
it also does not enforce complete commercial/result/claim coherence for arbitrary
SQL writers. Those are pending a dedicated database guard unit. Administrative
reconciliation, depot return, scheduling-day normalization, assignment service
integration, failed-order retry decisions and #12 rescheduling remain pending.
No HTTP test coverage alone is a catalog-wide acceptance PASS or review receipt.
