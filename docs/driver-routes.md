# Driver-owned routes

`GET /api/v1/drivers/me/routes` returns only routes assigned to the authenticated DRIVER. It is read-only and returns `[]` if the user has no driver profile or assigned routes.

## Request

Send a bearer JWT and optionally `?date=2024-02-29`. The server resolves the driver from the validated JWT subject; caller-provided `driverId`, `userId`, `routeId` and other unknown query fields are rejected.

The optional date is a real calendar day with exact `YYYY-MM-DD` syntax. It filters **Route.date**, not `Order.scheduledDeliveryDate`. The range is midnight inclusive through next midnight exclusive in `America/Guayaquil`, converted to UTC instants with native Temporal. For example, `2024-02-29` means `[2024-02-29T05:00:00Z, 2024-03-01T05:00:00Z)`. Calendar addition handles month/year boundaries and leap days without JavaScript date rollover or process-timezone dependence.

## Response

```json
[
  {
    "id": "route-uuid",
    "date": "2024-02-29T05:00:00Z",
    "zone": { "id": "zone-uuid", "name": "Centro", "code": "CEN-01" },
    "orders": [
      {
        "id": "order-uuid",
        "deliveryAddress": "Delivery address",
        "status": "ASSIGNED",
        "scheduledDeliveryDate": null,
        "stopOrder": 1
      }
    ]
  }
]
```

Routes are ordered by date and id. Orders are ordered by `stopOrder` ascending, NULL last, then id ascending for ties (including NULL ties). Every associated order is returned regardless of status. The response excludes user records, passwords, email, inventory, payment totals and unrelated orders.

| Status | Meaning |
|---|---|
| 200 | Assigned routes or stable empty array |
| 400 | Invalid calendar date, repeated date or unknown query field |
| 401 | Missing, invalid, expired or nonexistent-user JWT |
| 403 | Authenticated non-DRIVER role |

## Boundaries

Existing ADMIN endpoints keep their permissions. This endpoint does not enable DRIVER order-status writes: those remain fail-closed (`403`) until route lifecycle work is implemented separately. Route optimization, new lifecycle states and schema changes are out of scope.

## Verification

Unit tests cover calendar parsing, timezone conversion, delegated identity and scoped query/projection. `test/drivers-routes-security.e2e-spec.ts` uses a caller-provisioned, uniquely owned loopback disposable PostgreSQL database and scoped fixtures. It covers two-driver isolation, token/role checks, spoofed query/claim attempts, order sorting, date boundaries, empty profiles, ADMIN reads, status-write invariance and OpenAPI metadata. The existing isolated Newman runner covers the HTTP happy path and denial scenarios without connecting to a shared database.
