# Geolocation API and frontend handoff (#9)

Orders and zones persist confirmed coordinates without geocoding or route optimization. New requests may omit coordinates for backward compatibility; geographical planning readiness requires both a valid destination and its zone depot.

## Write contract

| Endpoint | Authorization | Coordinate fields | Omission |
| --- | --- | --- | --- |
| `POST /api/v1/orders` | CLIENT | `deliveryLat`, `deliveryLng` | Both stored as NULL |
| `POST /api/v1/zones` | ADMIN | `depotLat`, `depotLng` | Both stored as NULL |
| `PATCH /api/v1/zones/:id` | ADMIN | `depotLat`, `depotLng` | Existing pair preserved |

Supply both values as JSON numbers: finite latitude in [-90, 90] and longitude in [-180, 180], including boundary values. A partial pair, explicit `null` (even two nulls), strings and out-of-range values are rejected with 400. JSON cannot encode NaN or Infinity; DTO/service validation also rejects nonfinite values. There is no coordinate clearing operation or order-coordinate update endpoint. PostgreSQL permits both NULLs for historical compatibility and rejects partial/nonfinite/out-of-range stored pairs.

The following is DEMO/TEST data, not a real customer location. Existing required order fields and stock validation remain unchanged:

```json
{
  "zoneId": "existing-zone-id",
  "deliveryAddress": "DEMO/TEST delivery address",
  "deliveryLat": -1.24908,
  "deliveryLng": -78.61675,
  "items": [{ "productId": "existing-product-id", "quantity": 1 }]
}
```

## POST persistence versus GET readiness

Order POST returns the created persisted record, including `deliveryLat` and `deliveryLng`; it does not promise GET-only enrichment. Authorized order GET list/detail/history responses retain scalar fields and add `deliveryLocation`, `planningEligibility`, and `zone.depotLocation`. Zone reads and writes return `depotLocation`. Each mapped point has the exact shape `GeoPoint { lat, lng }`, never `{ lng, lat }` or a positional array.

Example GET projection when both locations are valid (other order fields omitted here):

```json
{
  "deliveryLat": -1.24908,
  "deliveryLng": -78.61675,
  "deliveryLocation": { "lat": -1.24908, "lng": -78.61675 },
  "zone": {
    "depotLat": -1.241,
    "depotLng": -78.619,
    "depotLocation": { "lat": -1.241, "lng": -78.619 }
  },
  "planningEligibility": { "eligible": true, "reasons": [] }
}
```

Historical NULL records remain visible through the same authorized reads, not silently filtered out. A missing pair maps to a null point. `planningEligibility.eligible` is false whenever its reasons array is nonempty:

| Reason | Meaning |
| --- | --- |
| `MISSING_DELIVERY_COORDINATES` | Both destination values missing |
| `INVALID_DELIVERY_COORDINATES` | Destination pair malformed |
| `MISSING_ZONE` | No associated zone available |
| `MISSING_ZONE_DEPOT_COORDINATES` | Both depot values missing |
| `INVALID_ZONE_DEPOT_COORDINATES` | Depot pair malformed |

This flag denotes geography only, not permission, assignment, schedule or lifecycle eligibility. A valid destination with an absent depot remains ineligible. Coordinate ranges cannot detect a latitude/longitude swap when both values happen to fit both ranges.

## Frontend and Issue #7 responsibilities

1. Let the person select and explicitly confirm a delivery/depot marker; display the address and coordinate pair for review.
2. Submit the pair together without numeric-string coercion. The backend cannot prove map confirmation and does not derive coordinates from addresses.
3. Re-read the order to display readiness reasons. Show historical/missing locations and request correction instead of hiding records.

Issue #7 may consume the explicit points only when destination AND depot are valid; business and authorization checks remain separate. This feature does not invoke or alter Clarke & Wright, add optimization endpoints, assignments or route states. PR #19 protections remain: DRIVER status mutations return 403 until Issue #10 provides its lifecycle prerequisites.

## Fixtures and reproducible evidence

[`src/prisma/seed.ts`](../src/prisma/seed.ts) labels depot coordinates DEMO/TEST and assigns them only on fresh zone insertion. Re-running seed does not backfill existing zones, including NULL pairs. The [collection](../delivery-api.postman_collection.json) checks order POST scalar persistence, GET mapped points/readiness, visible ineligible NULL records and malformed coordinate rejection while retaining security scenarios.

The [isolated runner](../test/run-newman-isolated.sh) rejects inherited DATABASE_URL, uses an owned disposable PostgreSQL target, applies/verifies the real migration chain and seeds twice to check stable zone identities/coordinates. Recorded T3 result: 64 requests, 268 assertions, zero failures. Failed RED/intermediate runs remain failures, not successful evidence. See the [migration/recovery runbook](geolocation-migration.md) for ownership, locking and hard-termination limitations.
