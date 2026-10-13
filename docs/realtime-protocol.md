# Realtime protocol v1

Server implementation scope: authenticated Socket.IO invalidation hints, not a durable queue. REST remains authoritative. React/Flutter integration has not been executed.

The agreed namespace is `/realtime`, standard Socket.IO path `/socket.io`. JWT is supplied in `auth.token`, never a query-string credential. `resource.subscribe` accepts `{ resource: 'order' | 'route' | 'incidents' | 'driver', id?: string }`, with strict shape/UUID and current DB role/resource validation; unauthorized subscriptions do not join rooms. Order/route/driver require id; incidents is ADMIN-only. Reconnect authenticates again, re-subscribes and performs an authorized GET; event ordering/replay/offline delivery are not guaranteed.

Every envelope is `{ version: 1, eventId, occurredAt, data }`. `data` is an allow-listed projection; no raw request/body, contact, notes, credentials or free-text failure reason.

| Event | Minimal fields | Audience |
|---|---|---|
| `order.status.updated` | orderId, optional status/requiresAdministrativeReview | ADMIN, owning CLIENT, current assigned DRIVER |
| `route.updated` | routeId, optional status | ADMIN, current assigned DRIVER |
| `dispatch.incident.updated` | orderId, optional action/requiresAdministrativeReview | ADMIN only |
| `driver.availability.updated` | driverId, available | ADMIN and that DRIVER, after confirmed depot return only |

Shared internal interface: `RealtimeService.publish(readonly RealtimeChange[]): Promise<void>`; callers await it only AFTER the outer successful PostgreSQL transaction. Rejections/rollbacks publish nothing. Publisher delivery errors are logged generically and do not turn committed REST operations into failures. Roles and resource ownership are revalidated before publication to prevent stale memberships after reassignment/revocation. Missing JWT_SECRET fails closed for socket authentication; existing REST behavior is not refactored here.

CORS/Cloudflare and client examples are documented in `realtime.md` with exact deployed-origin configuration, WebSocket and polling Origin checks, reconnection GET and explicit unverified frontend/tunnel limitation.
