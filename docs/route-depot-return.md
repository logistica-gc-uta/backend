# Depot return and effective availability (T4a)

## Operations

`POST /api/v1/routes/:id/return` requires a validated DRIVER JWT and current
ownership. It accepts an absent or empty JSON body, never `driverId` or an actor.
Invalid UUID/body is 400; missing JWT 401; wrong role/owner 403; absent route404;
invalid lifecycle/audit/reservation409. Response200 contains `id`, unchanged
`COMPLETED` status, persisted `returnedAt` ISO instant and current typed
`availability` projection. It is a driver's explicit
physical-depot confirmation, not GPS/geolocation evidence or a RETURNED status.

Completion alone never frees the driver. Return requires genuine paired start
and completion audit and a matching verified active reservation. Supported
Prisma8 callback transactions lock Driver then owned Route using checked
conditional no-op updates. Fresh ownership is checked after acquisition. The
return timestamp/actor and matching reservation-release timestamp are persisted
atomically; every remaining reservation/current/legacy hold is then queried
before updating the compatibility `Driver.isAvailable` flag. Same-owner replay
returns the original audit without another release; availability remains a
current snapshot and may change after a later assignment. No order/stop/attempt writes
occur. Rollback covers audit, reservation and projection together.

`GET /api/v1/drivers/me/availability` requires DRIVER JWT ownership and returns
`isAvailable`, `hasPersistedHolds`, `compatibilityFlagBlocks` and sorted
`blockingRouteIds`; missing profile404. Existing ADMIN
`GET /api/v1/drivers` retains every existing field and adds
`effectiveAvailability` with the same shape. The original compatibility boolean
is retained for existing clients; operational decisions use the central query,
not that boolean alone. Shared effective `isAvailable` combines the absence of
persisted holds with a verified true compatibility flag. `hasPersistedHolds`
exposes reservation/lifecycle evaluation separately; `compatibilityFlagBlocks`
labels a false or unverified flag honestly without inventing a route state.
Assignment uses that exact central decision under its driver lock. Genuine
return first atomically recomputes the projection from remaining persisted
holds, then evaluates effective availability, so its own previous false flag
cannot prevent legitimate release. Manual availability semantics are not invented.

## Holds and pending operations

Active reservations, ASSIGNED, IN_PROGRESS, COMPLETED without genuine return,
and unresolved NULL-lifecycle legacy routes block reuse. DRAFT does not reserve
a driver. Persisted release audits require bounded nonblank reason/evidence,
recorded administrator/time and explicit `releaseDriverHold`; reading these
records does not manufacture historical execution or physical-return events.

ADMIN `POST /api/v1/routes/:id/reconcile` is **not implemented in T4a**. T4b must
provide append-only human-reviewed evidence, equal-payload replay/conflict
handling, and release only after all other holds are resolved. Until then T4a
cannot clear unresolved legacy holds. Legacy ambiguous associations remain
unchanged. Recipient contact/rescheduling belongs to #12, not return.

Confirmed DRAFT and progress handlers are assembled together without replacing
one another. Legacy `POST /routes/assign` remains fail-closed409; scheduling-day
policy and wrapper activation remain incomplete. Exact timestamp equality is a
strict temporary assignment guard, not an established timezone/day policy.
All dependencies and this candidate remain unreviewed; no integrated acceptance
or receipt is asserted.
