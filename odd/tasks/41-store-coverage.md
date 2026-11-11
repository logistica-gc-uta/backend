# Store coverage singleton (#41)

Objective: ADMIN configures one physical store location and a general delivery coverage polygon, validated server-side, without replacing Zone/zoneId consumers. Branch: `feat/41-store-coverage`. Delivery: `ask-on-risk`. Runner: `pnpm test` (Jest ESM). Isolated mutative checks: owned PostgreSQL via `test/geolocation-migration.fixtures.ts`.

## Specs

S1. "ADMIN puede configurar la ubicación de la tienda y el área de cobertura; el backend valida coordenadas y datos de cobertura." Public write: `PUT /api/v1/admin/store-coverage` (ADMIN JWT). Payload requires both `location: { lat, lng }` and GeoJSON `coverage: { type: "Polygon", coordinates: [[[lng, lat], ...]] }`. Server is the authority.

S2. "Un punto interior o exactamente en el borde se acepta; un punto exterior se rechaza." Public check: `POST /api/v1/store-coverage/evaluate` with `{ lat, lng }`. Interior and boundary → `accepted: true`. Exterior → `accepted: false`. Coverage is planar membership, not road reachability.

S3. "Cambiar la cobertura no modifica ni cancela pedidos ya aceptados; se usa la nueva regla en pedidos nuevos o al cambiar dirección." `PUT` updates only `StoreCoverage`. Existing `Order` rows stay unchanged. New evaluates use the saved polygon. Checkout/order-create enforcement is backend #42, not this issue.

S4. "Las pruebas cubren límites, permisos y cambios de cobertura sin inventar datos históricos." Cases: unauthenticated/CLIENT/DRIVER writes forbidden; invalid location/coverage rejected; interior/boundary/exterior; coverage change vs accepted order. Fixtures are labelled test data.

S5. "Cubrir los ejemplos anteriores mediante las interfaces públicas pertinentes. Verificar respuestas, efectos persistidos y que los rechazos no dejan cambios parciales." Invalid `PUT` leaves the previous row (or absence of a row) unchanged.

S6. "Acordar y documentar los contratos/campos afectados antes de integrar con otro repositorio; no sustituir una API pendiente por datos ficticios de éxito." Unconfigured `GET /api/v1/store-coverage` returns `{ configured: false }` with no invented coordinates. Unconfigured evaluate returns typed `STORE_NOT_CONFIGURED`, never `accepted: true`. Zone APIs remain.

S7. "La tienda es el origen y retorno común." Persisted store `location` is the documented origin/return for backend #48. This issue does not change route planning.

S8. "un área de cobertura no es una ruta ni una agrupación permanente de pedidos." Do not delete Zone/zoneId. Do not implement hourly grouping, OSRM, or GPS.

## Tasks

- [x] T1 S2,S4 — inline — geometry classifier + unit tests — RED missing module, then 7/7 GREEN — Risk: none
- [x] T2 S1,S6 — inline — Prisma `StoreCoverage` singleton, emit, formal migration `20261111T0011_store_coverage_singleton` `70a695f…` → `e22e1c24…` — planned, not applied to shared DB — Risk: item 1
- [x] T3 S1–S6 — inline — HTTP module, typed errors, isolated e2e 8/8 GREEN; CI e2e count 34; isolated `--to` hash updated — Risk: items 2, 3, 5
- [x] T4 S3,S6–S8 — inline — `docs/store-coverage-contract.md` for web #32 / backend #42 / #48; those issues not implemented — Risk: item 3
- [x] T5 S2,S4–S6 — inline — review defects: boundary EPS, zero-area ring, exact error codes, singleton race, vertex cap — Risk: items 3, 4

## Log

L1. User authorized exclusive implementation of backend #41 on `feat/41-store-coverage`, following `.pi/handoffs/issue-41.md` P1–P6, test-first, preserve consumers, document related contracts without implementing them, isolated mutative state, no shared DB wipe, no push/PR/deploy.

L2. Technical contract chosen within issue rules (not a business-rule change): WGS84 GeoJSON Polygon, coordinates `[lng, lat]`, one exterior ring, closed, ≥4 positions, no holes, no self-intersections; API points use `{ lat, lng }`; singleton table `StoreCoverage`; zones kept; unconfigured is explicit non-success.

L3. Observed checks: `tsc --noEmit` exit 0; `pnpm lint` exit 0 with the same 13 baseline warnings; `pnpm build` exit 0; focused unit 50/50 then 15 store-coverage + 18 harness; isolated e2e `test/store-coverage.e2e-spec.ts` 8/8 exit 0 on owned Postgres. `pnpm test:cov` OOM (exit 134) plus a now-fixed 33→34 e2e-count assertion — full coverage suite not claimed. Independent verifier 58fec1a5-f9e8-4c2c-932a-fc93092c4eb5: S1–S8 pass, no blockers. Uncommitted. No push/PR.

L4. Review-fix T5 (authorized): reproduced EPS BOUNDARY and zero-area acceptance as RED, then GREEN. Error codes aligned (global ValidationPipe remapped). Advisory lock + unique retry. Vertex cap 256; topology skipped on public GET/evaluate. Focused units 50 then 23; isolated e2e 9/9. Full `test:cov` not rerun (prior OOM 134). No push/PR.
