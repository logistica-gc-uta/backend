# Realtime synchronization

Socket.IO provides authenticated, versioned invalidation hints. It is not an event log, durable queue, or replacement for REST. The authorized REST `GET` response remains the source of truth. Events can be missed while disconnected; no ordering, replay, or offline-delivery guarantee is provided. GPS tracking and road-ETA updates are out of scope.

## Connection contract

- Namespace: `/realtime`
- Socket.IO path: `/socket.io`
- JWT: pass the current JWT as `auth: { token }` in the Socket.IO handshake. Query-string tokens are not read. Socket connections fail closed when `JWT_SECRET` is missing, the signature/expiry is invalid, the current database user is absent, or the current database role is unknown. The JWT role claim is not trusted.
- Browser Origin: must exactly match `REALTIME_ALLOWED_ORIGINS`. Polling CORS and namespace middleware both enforce this allowlist; WebSocket transport does not rely on CORS alone. Credentials are not enabled and `*` is never accepted. Native clients without an `Origin` header are allowed only after the same JWT authentication.
- If `REALTIME_ALLOWED_ORIGINS` is unset, the safe development defaults are `http://localhost:3000` and `http://localhost:5173`. Set an explicit comma-separated list in deployed environments; each value must be an origin only (scheme, host and optional port; no path or wildcard). An explicitly empty/invalid list permits no browser origins.

The subscription event is `resource.subscribe`. Its payload has an exact shape: `{ resource: 'order' | 'route' | 'driver', id: '<UUID>' }`, or `{ resource: 'incidents' }` for ADMIN only. Extra keys, malformed UUIDs, unknown resources, missing IDs, foreign resources, or an unassigned driver are rejected without joining a room. The acknowledgement is exactly `{ ok: true }` on success or `{ ok: false, error: '<stable generic code>' }` on failure (`INVALID_REQUEST`, `UNAUTHENTICATED`, `FORBIDDEN`, or `UNAVAILABLE`). It never contains resource details.

Authorization is based on the current database user role and current ownership/assignment: ADMIN may subscribe to existing resources; CLIENT only to an owned order; DRIVER only to their assigned order/route or their own driver record. Incidents are ADMIN-only. Publication rechecks JWT expiry, current user/role, current assignment and room authorization before each socket emission. Revoked or stale subscribers are disconnected rather than receiving data for an old assignment.

## Version 1 events

All events use `{ version: 1, eventId, occurredAt, data }`. `eventId` is a UUID and `occurredAt` is an ISO-8601 UTC timestamp. The server projects only allow-listed fields; it never forwards raw requests, contacts, credentials, conversations, free-text notes, or failure reasons.

| Event | Minimal `data` | Audience |
|---|---|---|
| `order.status.updated` | `orderId`, optional `status`, optional `requiresAdministrativeReview` | ADMIN, owning CLIENT, currently assigned DRIVER |
| `route.updated` | `routeId`, optional `status` | ADMIN, currently assigned DRIVER |
| `dispatch.incident.updated` | `orderId`, optional allow-listed `action` (`CONFIRM`, `REJECT`, `REORDER`, `MOVE`, `REASSIGN_DRIVER`, `PRIORITIZE`, `CONTACT`, `RESCHEDULE`), optional `requiresAdministrativeReview` | ADMIN only |
| `driver.availability.updated` | `driverId`, `available` | ADMIN and that DRIVER, after confirmed depot return only |

These are authorization-scoped invalidation hints, not a claim that the client has the complete current state. After each event, clients should fetch the relevant REST resource and render the authorized response. A successful subscription ACK only confirms authorization to join; it is not a ready-state or replay boundary.

## React browser example

`API_ORIGIN` is the backend origin (for example `https://api.example.com`), `orderId` is a UUID returned by REST, and `getAccessToken`/`refreshAccessToken` are the application's existing token functions. `reloadOrder` should call the authorized REST source of truth, for example:

```tsx
async function reloadOrder(orderId: string) {
  const response = await fetch(`${API_ORIGIN}/api/v1/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${getAccessToken()}` },
  });
  if (!response.ok) throw new Error('Unable to refresh order');
  setOrder(await response.json());
}
```

```tsx
import { io } from 'socket.io-client';
import { useEffect } from 'react';

function useOrderUpdates(orderId: string, reloadOrder: () => Promise<void>) {
  useEffect(() => {
    const socket = io(`${API_ORIGIN}/realtime`, {
      path: '/socket.io',
      auth: { token: getAccessToken() },
      transports: ['websocket', 'polling'],
      autoConnect: false,
    });

    const subscribeAndReload = () => {
      socket.emit('resource.subscribe', { resource: 'order', id: orderId }, (ack) => {
        if (ack?.ok) void reloadOrder();
      });
    };
    socket.on('connect', subscribeAndReload);
    socket.on('order.status.updated', () => void reloadOrder());
    socket.io.on('reconnect_attempt', () => {
      socket.auth = { token: getAccessToken() };
    });
    socket.on('connect_error', async () => {
      socket.auth = { token: await refreshAccessToken() };
    });

    socket.connect();
    return () => socket.disconnect();
  }, [orderId, reloadOrder]);
}
```

Use the application's normal token-refresh flow; after a reconnect the client must subscribe again and issue the authorized REST `GET`. If the subscription ACK is not successful, do not display a guessed state or retry with a broader resource.

## Flutter native example

Using the `socket_io_client` package, create a fresh socket with a refreshed JWT whenever the application reconnects. A native Flutter connection typically has no browser `Origin` header; it is still authenticated and must send `auth.token`.

```dart
import 'package:socket_io_client/socket_io_client.dart' as IO;

IO.Socket createRealtimeSocket(String apiOrigin, String token) {
  final socket = IO.io('$apiOrigin/realtime', <String, dynamic>{
    'path': '/socket.io',
    'transports': ['websocket', 'polling'],
    'auth': {'token': token},
    'autoConnect': false,
  });
  socket.onConnect((_) {
    socket.emitWithAck(
      'resource.subscribe',
      {'resource': 'order', 'id': orderId},
      ack: (dynamic ack) {
        if (ack is Map && ack['ok'] == true) {
          fetchAuthorizedOrder(orderId); // REST GET is authoritative.
        }
      },
    );
  });
  socket.on('order.status.updated', (_) => fetchAuthorizedOrder(orderId));
  return socket;
}

Future<void> reconnectRealtime() async {
  socket?.disconnect();
  socket = createRealtimeSocket(API_ORIGIN, await refreshAccessToken());
  socket!.connect();
}
```

`fetchAuthorizedOrder(orderId)` performs `GET $API_ORIGIN/api/v1/orders/$orderId` with the current JWT in the `Authorization: Bearer ...` header. Call `reconnectRealtime` through the app's bounded retry/backoff policy after disconnection. Subscribe again and fetch REST state after every successful connection; Socket.IO does not replay missed events.

## Local Cloudflare Tunnel smoke setup

For a local smoke exercise, first start the backend and its required local PostgreSQL service on port 3000, then expose that local HTTP origin with a Cloudflare Quick Tunnel:

```sh
cloudflared tunnel --url http://localhost:3000
```

Use the generated `https://<tunnel-host>.trycloudflare.com` backend origin in the client and set `REALTIME_ALLOWED_ORIGINS` to the exact browser application's origin (not the API/tunnel URL unless the browser app itself is served there). Keep normal REST CORS configuration separate; this module does not change it. A tunnel does not bypass JWT validation or authorization. Quick Tunnel hostnames are temporary and must be replaced in the allowlist when they change. This documents a setup command only; no tunnel, Cloudflare deployment, React app, or Flutter app has been run or verified by this backend implementation.
