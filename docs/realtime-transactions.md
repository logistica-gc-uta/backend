# Realtime transaction boundaries

Realtime events are post-commit invalidation hints. The authorized REST response remains authoritative; clients should refetch the affected resource after receiving an event and after reconnecting.

## Producer rules

- Service callbacks collect changes from rows returned by successful writes. They do not call the publisher or publish from an `InTransaction` helper.
- A public operation awaits the complete Prisma transaction before calling `RealtimePublisher.publish`. A callback rejection, commit rejection, or rejected lifecycle transition therefore publishes nothing.
- Exact idempotent replays return the established REST response without publishing the already accepted change again.
- Publication failure cannot convert a successful, committed REST operation into an error.

## Change coverage

- `order.status.updated` follows committed delivery progress, administrative cancellation, failed-visit review holds, and rescheduling. Payload state comes from the persisted order result.
- `route.updated` follows committed assignment, route start/completion, and actual route composition or lifecycle changes. A move records both changed route IDs.
- `dispatch.incident.updated` carries only an affected order ID, a bounded action where applicable, and the persisted administrative-review flag when that state is relevant. It never carries a reason, contact detail, or conversation.
- `driver.availability.updated` is emitted only after a confirmed depot return, using the availability computed and persisted by that return transaction. Route completion alone does not release or announce driver availability.

The versioned event envelope, audience rules, and client reconnection behavior are defined in [the realtime protocol](realtime-protocol.md).
