# Explicit start of an owned route

`POST /api/v1/routes/:id/start` uses the existing JWT and DRIVER role guards.
The UUID path identifies the route; the actor is the validated JWT user, never
a supplied driver identifier. Send no body or an empty JSON object. Other fields,
malformed bodies and unsupported content types fail with 400. Missing/invalid JWT
fails with 401, wrong role/ownership with 403, missing route with 404 and conflicting
lifecycle/reservation/stop evidence with 409. Successful start and replay return
200 with typed `{ id, status: "IN_PROGRESS", startedAt }`; the timestamp is the
persisted Temporal.Instant serialized to a string, not a newly generated replay time.

## Transaction and boundary

Installed Prisma rc.11 supports callback transactions and predicate ORM updates.
A no-op UPDATE locks the driver first (`userId` unchanged), then the owned route
(`driverId` unchanged), followed by a fresh route read. A conditional ASSIGNED
update persists server time and actor. PostgreSQL serializes competing starts;
IN_PROGRESS replay preserves the original audited time/actor. No availability,
commercial order or compatibility assignment data is changed. No-op updates incur
MVCC write cost but avoid an invented FOR UPDATE API and ownership overwrites;
errors roll back the entire transaction, including lock-only writes.

Start requires a verified active driver reservation, one to four nonlegacy PENDING
stops with contiguous sequence, matching active order claims, and assigned orders
in the route zone without administrative holds. Replay requires the active driver
reservation and verified original actor/time, not still-pending visit outcomes.
Future mutators must use the same driver-before-route lock protocol. Out-of-band
structure and lifecycle invariants require pending T1c database guards; this unit
does not claim those guards are active. Existing assignment creates unverified
legacy-compatible routes and cannot supply this new verified start contract yet.

## Evidence and remaining dependencies

Controlled same-date PostgreSQL fixtures prove start/replay/security, not planning
calendar semantics. The compatible-date/assignment contract remains unresolved;
no timezone rule is invented here. Native consent, review, integration, Newman
and Issue #10 business acceptance remain pending. Source dependencies are copied
unreviewed T1a policy and T1b contract, not an approved integrated feature.
