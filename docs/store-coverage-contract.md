# Unique store and general coverage contract (#41)

REGALÍA has one physical store. ADMIN saves its WGS84 location and one general delivery polygon. Coverage is planar membership (interior and boundary accepted, exterior rejected). It is not road reachability, a route, or a permanent order group.

Existing `Zone` / `zoneId` APIs stay. They remain operational grouping for current checkout and planning until backend #42 and #48 consume this contract.

## HTTP

| Method | Path | Auth | Role |
| --- | --- | --- | --- |
| `GET` | `/api/v1/store-coverage` | none | public read for web #32 |
| `PUT` | `/api/v1/admin/store-coverage` | JWT | `ADMIN` only |
| `POST` | `/api/v1/store-coverage/evaluate` | none | point classification for #42 |

### Unconfigured (no invented success)

`GET` returns HTTP 200:

```json
{ "configured": false }
```

There is no default store location. `POST /store-coverage/evaluate` returns HTTP 409:

```json
{ "error": { "code": "STORE_NOT_CONFIGURED", "message": "...", "details": {}, "requestId": "..." } }
```

Never `accepted: true` while unconfigured.

### Configured read

```json
{
  "configured": true,
  "location": { "lat": -1.24908, "lng": -78.61675 },
  "coverage": {
    "type": "Polygon",
    "coordinates": [[[lng, lat], [lng, lat], [lng, lat], [lng, lat], [lng, lat]]]
  },
  "updatedAt": "2026-11-11T00:00:00.000Z",
  "updatedById": "uuid-or-null"
}
```

Point fields on HTTP bodies use `{ lat, lng }`. Polygon positions use GeoJSON `[lng, lat]`.

### ADMIN write

Full replace of `location` and `coverage`. `401` without JWT. `403` for `CLIENT` / `DRIVER`. Rejected writes leave the previous row (or no row) unchanged and do not touch orders.

| Failure | HTTP | `error.code` |
| --- | --- | --- |
| Out-of-range, non-numeric, or incomplete `location` / evaluate point | 400 | `STORE_LOCATION_INVALID` |
| Missing, non-Polygon, zero-area, self-intersecting, or oversized `coverage` | 400 | `STORE_COVERAGE_INVALID` |
| Extra properties or mixed invalid location+coverage in one body | 400 | `VALIDATION_ERROR` |

### Evaluate

Body `{ "lat": number, "lng": number }`.

| Result | HTTP | Body |
| --- | --- | --- |
| Interior | 200 | `{ "accepted": true, "position": "INTERIOR" }` |
| Exactly on an edge or vertex | 200 | `{ "accepted": true, "position": "BOUNDARY" }` |
| Exterior | 200 | `{ "accepted": false, "position": "EXTERIOR" }` |

## Polygon rules

- GeoJSON `Polygon`, WGS84
- Exactly one exterior ring, closed (first position equals last)
- At least four positions (three distinct vertices plus close)
- At most 256 unique vertices
- Non-zero area (collinear/degenerate rings are rejected)
- No holes, no zero-length segments, no self-intersections
- Finite coordinates: latitude [-90, 90], longitude [-180, 180]
- Writes run topology checks. Public GET/evaluate parse structure and vertex cap only, then classify in linear time.

The store location is not required to sit inside the polygon. Coverage changes apply to later evaluates and (once #42 lands) to new orders or later address changes. Already accepted orders keep their stored fields.

## Consumers not implemented here

| Issue | Use this contract |
| --- | --- |
| [web #32](https://github.com/logistica-gc-uta/frontend-web-logistica/issues/32) | `GET` / `PUT` above. Treat `configured: false` as empty UI, not a fake pin. |
| [backend #42](https://github.com/logistica-gc-uta/backend/issues/42) | Call `StoreCoverageService.evaluatePoint` (or `POST .../evaluate`) on create/quote/address change. Fail closed on `STORE_NOT_CONFIGURED` and `accepted: false`. Do not auto-cancel existing orders. |
| [backend #48](https://github.com/logistica-gc-uta/backend/issues/48) | Use `location` as the common origin and return. Do not keep inventing per-zone depots as the store. |

Do not delete `Zone` until those consumers are adapted. Hourly grouping, OSRM, and live GPS stay out of #41.

## Persistence

Singleton table `public."storeCoverage"` (`singletonKey = 'GLOBAL'`). Prisma 8 migration: `migrations/app/20261111T0011_store_coverage_singleton` from `70a695f…` to `e22e1c24…`. Apply only on isolated or explicitly authorized databases.
