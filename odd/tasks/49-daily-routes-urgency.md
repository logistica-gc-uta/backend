# Feature: Daily routes and adapted urgency dispatch (#49)
Branch: feat/49-daily-routes-urgency | Issue: logistica-gc-uta/backend#49
Rules: Operational day is America/Guayaquil; non-today route confirmation/assignment returns 409; Zone/zoneId operational dependency removed using StoreCoverage.

## Specs
S1: "Aplicar regla de día operativo (`America/Guayaquil`) en la generación, confirmación y asignación de rutas, independiente de la zona horaria del navegador."
- "Permitir preview futura (solo lectura)": `GET /api/v1/route-proposals` accepts any valid `date` (`YYYY-MM-DD`) as read-only preview and exposes whether the requested `date` matches today in `America/Guayaquil` (`isToday` / `canConfirm`) without persisting routes.
- `POST /api/v1/routes` (confirm DRAFT), `POST /api/v1/routes/:id/assign` (assign DRAFT), and `POST /api/v1/routes/assign` (legacy direct assign) MUST reject any date that is not today in `America/Guayaquil` with HTTP `409 Conflict` (`code: "ROUTE_DATE_NOT_TODAY"` or matching controlled conflict) and zero partial writes/claims/reservations.

S2: "Mantener compras válidas a futuro (`POST /orders`, `POST /orders/admin`, `POST /shop/checkout/*`), sin generar ni asignar rutas antes del día de entrega."
- Future delivery purchases continue creating valid `PENDING` orders scheduled on future `America/Guayaquil` days without auto-creating or assigning routes.

S3: "Revalidar propuestas obsoletas al confirmar/asignar cuando cambie el día, los claims o la disponibilidad, usando bloqueos y protecciones actuales."
- Revalidates today's `America/Guayaquil` day, active `OrderClaim`s, `Order.status === 'PENDING'`, `requiresAdministrativeReview === false`, `OrderPickup` absence, and `Driver` availability atomically under row locks (`409` on stale state, zero duplicated routes/stops/claims/reservations).
- "Rechazar assign + liberación auditada ADMIN": When an unassigned `DRAFT` crosses midnight without assignment, `POST /routes/:id/assign` rejects with `409`, and ADMIN can execute `POST /api/v1/dispatch/interventions` with `action: "RELEASE_DRAFT"` on a `DRAFT` route to atomically delete its `RouteStop`s, release its active `OrderClaim`s, and record an audited `DispatchIntervention`, freeing orders for today's replanning.
- Already-assigned (`ASSIGNED`), started (`IN_PROGRESS`), or completed (`COMPLETED`) routes crossing midnight remain operable (`start`, `progress`, `complete`, `returnToDepot`) preserving operational history.

S4: "Adaptar urgencias y reasignaciones para proponer inserción en ruta no iniciada con cupo o nueva salida, o dejar pendiente con razón cuando no haya disponibilidad; el ADMIN confirma."
- "Nunca modificar automáticamente rutas ya iniciadas o terminadas, ni perder trazabilidad."
- `GET /api/v1/dispatch/inbox`, `GET /api/v1/dispatch/orders/:id/proposal`, and `POST /api/v1/dispatch/interventions` (`CONFIRM` / `REJECT`) evaluate `INSERT` only into today's non-started (`DRAFT` or `ASSIGNED`) routes with `< 4` stops (`> 0` stops), `NEW_ROUTE` when drivers are available and existing routes are `IN_PROGRESS`/`COMPLETED`/full, or `BLOCKED` (reason e.g. `NO_AVAILABLE_DRIVER`) keeping the pending order/incident visible for ADMIN decision.
- Expired/unassigned `DRAFT` routes or empty released `DRAFT`s are never proposed for `INSERT`.

S5: "Eliminar la dependencia operativa de `Zone`/`zoneId` en planificación, asignación, ejecución y urgencias."
- "Route.zoneId nullable + StoreCoverage": Prisma 8 migration makes `Route.zoneId` nullable (`String?`), updates PostgreSQL `route_integrity_guard` / `route_stop_integrity_guard` / `t1e_claim_history_guard` triggers and `dispatch_audit_valid` CHECK constraint (`RELEASE_DRAFT`).
- Planning (`GET /route-proposals`), draft confirmation (`POST /routes` with optional/nullable `zoneId`), assignment, execution (`start` / `complete` / `progress`), urgencies (`INSERT` / `NEW_ROUTE`), and dispatch (`RESCHEDULE` / `MOVE`) support `Order.zoneId = null` and `Route.zoneId = null` using `StoreCoverage` as the common depot/origin, while keeping backward compatibility when `zoneId` is provided.
- Verify if `Zone` table/CRUD stays as legacy compatibility only without blocking orders/routes when absent; update contracts (`docs/`, Swagger/OpenAPI, Postman collection) and cover via real isolated PostgreSQL HTTP tests.

## Tasks
- [x] T1 | S3, S5 | Schema & Prisma 8 migration (`Route.zoneId` nullable, triggers, `RELEASE_DRAFT` audit check, isolated E2E hash updates) | route: inline (Risk: item 1, 3, 5 -> verified via isolated PG migrate + migration check + integrity/coherence E2E) | commit: edda55c
- [x] T2 | S1, S2, S3 | Operational-day (`America/Guayaquil`) guards, preview metadata, `RELEASE_DRAFT` audited intervention, and test-first E2E/unit coverage | route: inline (Risk: item 3 -> verified via focused + E2E + diff check) | commit: ea4b6db, 2a5bd3a
- [x] T3 | S4, S5 | Remove operational `Zone`/`zoneId` dependency across planning, assignment, execution, urgencies, dispatch & update docs/Swagger/Postman | route: inline (Risk: item 3 -> verified via focused + E2E) | commit: ce350ec, 9cb7abc, bb1f35e, ed04a04, eec5304
- [x] T4 | S1-S5 | Full verification (`lint`, `build`, `test:cov`, `test:e2e:isolated`, `test:api:isolated`), baseline differential check, and independent `gentle-ai-verify` | route: delegated verifier (Risk: item 1, 3, 5) | commit: 47a5486, 98eb13b

## Log
L1: "implementa la issue 49 https://github.com/logistica-gc-uta/backend/issues/49"
L2: User approved 3 design decisions: (1) `GET /route-proposals` allows read-only future preview with confirmability indicator while `POST /routes`, `POST /routes/:id/assign`, `POST /routes/assign` reject non-today `America/Guayaquil` dates with 409; (2) stale `DRAFT` crossing midnight rejects assign with 409 and ADMIN releases it via audited intervention (`RELEASE_DRAFT`), while `ASSIGNED`/`IN_PROGRESS`/`COMPLETED` routes keep working; (3) `Route.zoneId` nullable + `StoreCoverage` fallback/origin via Prisma 8 migration and trigger updates.
L3: Verified `pnpm run test:cov` (101/101 suites, 1289/1289 tests), full 42-suite `test:e2e:isolated` (38 passed + 1 skipped self-managed with 626 passed / 2 skipped tests; 3/3 legacy suites with 59/59 tests, exit 0 at commit eec5304), baseline diff check vs `2d6ae85` in `mktemp -d` (0 regressions), and post-fix (`98eb13b`) `lint`, `build`, unit suite (101/101, 1289/1289), `test/route-history.e2e-spec.ts` (6/6), `test:api:isolated` (110 requests, 462/462 assertions), and static `gentle-ai-verify` recheck (`PASS`, bash unavailable in bridge).
