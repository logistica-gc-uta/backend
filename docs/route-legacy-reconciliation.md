# Administrative legacy hold reconciliation

`POST /api/v1/routes/:id/reconcile` requires a current ADMIN account and a valid
JWT. This is an administrative decision about an **unverified legacy hold**,
not confirmation of physical depot return or completion.

Before calling it, independently verify current dispatch and physical state with
reliable operational records and the dispatcher/depot operator. Supply a nonblank
`reason` (maximum 500 characters) and `evidence` (maximum 2000 characters). Do not
infer safety from absent GPS points, elapsed time, or a legacy compatibility flag.

## Request and response

```json
{
  "reason": "Dispatch independently checked",
  "evidence": "Depot operator and dispatcher confirmed no current load"
}
```

Only these fields are accepted; actor and recording time come from the validated
session and server. Only routes whose status is NULL qualify. The response contains
`audit` (id, routeId, administratorId, recordedAt, reason, structured evidence,
releaseDriverHold) and current `availability`, or null for a driverless route.

## Preserved history and replay

The transaction locks the bound driver before the route, appends immutable audit,
releases only that driver's unreleased reservations for this same legacy route,
and recomputes compatibility availability. Reservation creation time remains
unchanged; release time is a new administrative event. Verified-route reservations,
order claims, order status, legacy associations, missing/ambiguous positions, and
historical execution timestamps are NOT rewritten. Other unresolved holds still
prevent availability. The legacy route remains consultable and unverified.

Same actor and identical reason/evidence replay the original audit and read current
availability; replay never overrides a subsequently set false compatibility flag.
A different actor/payload or a verified route returns 409. Malformed UUID/body is 400,
missing authentication 401, non-ADMIN 403, and absent route 404. A later role change
cannot invalidate an already persisted valid audit, but that actor cannot create
or replay reconciliation without current ADMIN authority.

## Boundaries

No planning, automatic GPS inference, contact, retry, or #12 rescheduling occurs.
An audit does not establish a failed order's planning eligibility. Database
append-only guards remain enabled; a role-at-insert database guard is a separate
pending coherence unit. This endpoint verifies stored ADMIN authority in its
transaction; deployments must not treat direct database writes as this HTTP contract.
