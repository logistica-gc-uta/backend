# Admin Registered Clients Search Contract (#64)

This document defines the HTTP and OpenAPI contract for searching and paginating registered `CLIENT` accounts from administration (`GET /api/v1/admin/clients`) so an administrator can select a verified `buyer.clientId` for `POST /api/v1/orders/admin`.

## Endpoint

- **Method & Path**: `GET /api/v1/admin/clients`
- **Authentication**: Bearer JWT required (`@ApiBearerAuth('JWT-auth')`, `JwtAuthGuard`)
- **Authorization**: `Role.ADMIN` only (`RolesGuard`, `@Roles(Role.ADMIN)`)
  - Missing or invalid JWT returns `401 Unauthorized`.
  - Authenticated `CLIENT` or `DRIVER` callers receive `403 Forbidden` (role is verified against PostgreSQL via `JwtStrategy`, never trusted from a spoofed JWT claim).

## Query Parameters (`ListAdminClientsDto`)

Validated through NestJS `ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })`:

| Parameter | Type | Required | Default | Constraints | Description |
| --- | --- | --- | --- | --- | --- |
| `search` | `string` | No | `undefined` | Trimmed; length `2..100` when provided | Case-insensitive partial match (`ILIKE ... ESCAPE '\'`) against `User.name` or `User.email`. SQL LIKE wildcards (`%`, `_`, `\`) are escaped as literal characters. When omitted, lists all registered `CLIENT` users. |
| `page` | `integer` | No | `1` | `1..1000000` | 1-based page index. |
| `pageSize` | `integer` | No | `20` | `1..50` | Maximum number of items returned per page. |

Any unknown query parameter (such as `phone`, `role`, or arbitrary keys), out-of-range pagination parameter, or `search` string shorter than 2 trimmed characters returns `400 Bad Request`.

## Response Contract (`200 OK` — `AdminClientsPageDto`)

```json
{
  "items": [
    {
      "id": "00000000-0000-4000-8000-000000000001",
      "name": "Ana Cliente",
      "email": "client1@delivery.com"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

### Invariants

1. **Strict Role Filtering**: Queries filter strictly by `User.role = 'CLIENT'`. `ADMIN` and `DRIVER` accounts are never returned, even when their `name` or `email` matches `search`.
2. **Allowlist Projection**: Each item in `items` exposes only `id`, `name`, and `email`. Password hashes (`password`), `role`, `createdAt`, and order records are never projected in SQL or serialized in the HTTP response.
3. **Deterministic Ordering**: Results are ordered stably by `name ASC, id ASC`.
4. **Snapshot Consistency**: `total` and `items` are read within a single `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY` transaction on PostgreSQL.
5. **Read-Only & No Phone Lookup**: This endpoint does not create, mutate, deactivate, or link accounts, and does not search by phone (`User` does not persist a phone number; operational phones belong to order snapshots and guest orders never link to accounts by phone).

## Integration with `POST /api/v1/orders/admin`

An administrator searches for a registered client via `GET /api/v1/admin/clients?search=ana`, selects the matching item (`Ana Cliente`, `client1@delivery.com`), and submits its `id` as `buyer.clientId` in `POST /api/v1/orders/admin`:

```json
{
  "buyer": {
    "type": "REGISTERED_CLIENT",
    "clientId": "<id from GET /api/v1/admin/clients>",
    "contactPhone": "+593 99 888 7777"
  },
  "payment": { "method": "CASH" },
  "deliveryAddress": "Av. Cevallos y Montalvo",
  "deliveryLat": -1.24908,
  "deliveryLng": -78.61675,
  "scheduledDeliveryDate": "2030-02-14T15:00:00.000Z",
  "items": [{ "productId": "<uuid>", "quantity": 1 }]
}
```
