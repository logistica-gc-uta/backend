# Issue 31 — Registro público exclusivo CLIENT y endurecimiento de respuestas

Branch: `feat/31-auth-client-only-registration` (base `main` @ `13a557e`). Local commits only; RDD off unchanged; no push, no PR creation, no merge, no automatic approval.

## Specs
S1 — "POST /auth/register no permite fijar ADMIN/DRIVER, ni mediante body manipulado."
S2 — "Los usuarios y conductores no exponen hashes de contraseñas u otros secretos."
S3 — "Conservar login de ADMIN, CLIENT y DRIVER existente."
S4 — "Aceptación: 201 CLIENT, 403/400 en escalada, regresiones de autenticación y seguridad."
S5 — "Dependencia: habilita checkout CLIENT y administración."
S6 — "Definition of Done: PR con revisión humana, pruebas automatizadas y de integración aplicables, CI, evidencia/documentación, sin merge automático."

S7 — User request (verbatim): "tengo asigando estas issue completalas con los agente los mas repido" with the assignment table row "1    #31 — Seguridad y autenticación CLIENT    P0    Corregir la creación de usuarios y asegurar los roles". The agent roster is the set of `subagent_run` agents available in this session.

## Tasks
T0 | S1,S4 | inline baseline + RED observation for role escalation | done | Baseline 51 suites / 684 tests, exit 0, `pnpm test --roots src test`; plain `pnpm test` fails pre-existing on the leftover `.issue13-*` haste collision.
T1 | S1,S4 | delegated writer: registration role lock (DTO whitelist + service hardcode) | done | `role` removed from `RegisterDto`; `AuthService.register` persists `Role.CLIENT` unconditionally. Observed escalation: 400 `property role should not exist`. RED seen first (E2E `expected 400, got 201`).
T2 | S2 | delegated writer: redact password hashes and secrets from user/driver responses | done | Explicit allowlist projections in `drivers.service.ts` and `routes.service.ts`; `password` removed from `AdminRouteHistoryUserDto`. Independent parent sweep of `src/` found no remaining unprojected user serialization.
T3 | S3,S4,S5,S6 | inline: regression, CI inventory, evidence doc, closure | done | 52 suites / 688 tests green, build 0, lint 0 (one pre-existing warning in an untouched file); isolated E2E manifest 22 suites exit 0 with owned PostgreSQL cleanup confirmed; differential check against `13a557e` found only the intended differences.

## Log
L1 — Original user request (verbatim)
`tengo asigando estas issue completalas con los agente los mas repido :`
```
Orden    Issue    Prioridad    Motivo
1    #31 — Seguridad y autenticación CLIENT    P0    Corregir la creación de usuarios y asegurar los roles
2    #32 — Catálogo y Cloudinary    P0    Desbloquear las Issues frontend #19 y #21 de Kerly
3    #33 — Checkout y pagos simulados    P0    Implementar la compra segura con control de concurrencia
4    #34 — Comprobantes simulados    P0    Completar el proceso posterior a la compra
Paralelo    #35 — Catálogo de prueba y QA    P0    Mateo prepara los datos y las pruebas progresivamente
```

L2 — Baseline exploration (parent, read-only). `main` @ `13a557e`; branch `feat/31-auth-client-only-registration` created from it. Stack: NestJS 12 + Prisma 8 (`src/prisma/contract.prisma`, `prisma contract emit`), Jest unit (`*.spec.ts` under `src/`) + E2E (`test/*.e2e-spec.ts`, `test/jest-e2e.json`), CI at `.github/workflows/ci.yml` (oxlint, build, `test:cov` with global 80% gates, isolated E2E manifest, Newman). PostgreSQL 16 container `logistica_postgres` is up and healthy on 5432.

L3 — Evidence for S1 (parent, read-only). `src/modules/auth/dto/register.dto.ts:26-34` declares an optional `role?: Role` and `src/modules/auth/auth.service.ts:28` persists `role: dto.role ?? Role.CLIENT`. Global `ValidationPipe` in `src/main.ts:12-17` runs with `whitelist: true, forbidNonWhitelisted: true`, so a `role` key in the body is currently accepted and persisted. `src/prisma/seed.ts` creates ADMIN/DRIVER users directly through Prisma, not through `POST /auth/register`, so locking registration to CLIENT does not remove any legitimate role-provisioning path.

L4 — Evidence for S2 (parent, read-only). `src/modules/drivers/drivers.service.ts:58` uses `this.prisma.driver.include('user')` and returns the full user row, which carries the `password` column. `src/modules/routes/routes.service.ts:31` and `:40` use `.include('driver', (d) => d.include('user'))`, which nests the same unprojected user. `src/modules/routes/dto/route-history-response.dto.ts:127` declares `password!: string` on `AdminRouteHistoryUserDto`. `src/modules/orders/orders.service.ts:180` already projects `.include('user', (user) => user.select('id', 'name'))` and is the in-repo pattern to reuse. `src/modules/orders/order-response.util.ts` already allowlists `user: { id, name }`.

L5 — Constraint for the writer (parent). The `Role` enum must stay importable from its current path `src/modules/auth/dto/register.dto.ts`; roles.guard, roles.decorator, drivers.controller and other modules import it from there. Moving it would widen the review surface beyond this issue. `src/prisma/seed.ts` is the ADMIN/DRIVER provisioning path and must keep working unchanged.

L6 — Constraint for the writer (parent). This issue changes code shared with existing behavior: the global `ValidationPipe` whitelist, the register DTO contract, and the user/driver projection shape. Every pre-existing command or option that shares that code must keep its previous behavior: ADMIN/CLIENT/DRIVER login, the ADMIN `GET /drivers` listing, and the route-history ADMIN projections. Differential check required against the base commit before closure.

L7 — Differential check result (worker, observed against the base commit `13a557e` in a scratch copy). `POST /auth/login` for ADMIN, CLIENT and DRIVER: no difference in body or status. `POST /auth/login` with invalid credentials: no difference, 401 with the same message. `GET /drivers` (ADMIN): the only difference is the removed `user.password`; the rest of the payload is identical. `GET /routes` (ADMIN): the only difference is the removed `driver.user.password`. `POST /auth/register` with `role: 'ADMIN'`: 201 with an ADMIN created became 400 `property role should not exist`. No unrequested difference was found.

L8 — Parent-owned fix (parent, inline). The writer's own e2e file made the E2E inventory 22 suites, and `test/ci-security.spec.ts` pins that count at 21; that file was outside the writer's allowed surfaces, so the parent bumped the count and the test title from 21 to 22. `.github/workflows/ci.yml` and `test/run-e2e-isolated.mjs` compute the manifest dynamically and needed no change. After the fix the unit inventory is 52 suites / 688 tests, all green.

L9 — Independent parent sweep (parent, read-only). Every `include('user')` and `include('driver')` in `src/` now carries an explicit field allowlist: `orders.service.ts` selects `id, name`; `routes.service.ts` and `drivers.service.ts` select `id, name, email, role, createdAt`. No response DTO declares a `password` member any more; the only remaining declarations are the `password` request fields of the login and register DTOs.

L10 — Environment note (parent, verified). The body size limit added to `src/main.ts` for the ADMIN image upload of issue #32 registers exactly ONE `jsonParser` layer. Verified against the installed `@nestjs/platform-express`: `registerParserMiddleware` skips its default parser when `isMiddlewareApplied('jsonParser')` is already true, so the 3mb limit is the one in force and the default 1mb parser does not shadow it.

L11 — Independent verification (parent, `gentle-ai-verify-luna`, read-only, verdict `pass` for S1-S4, no blockers). The verifier re-derived every claim instead of trusting the writer: the DTO has no `role` property and the service persists `Role.CLIENT` unconditionally; the escalation returns 400 and creates no row; the stored bcrypt hashes are absent from the ADMIN driver listing, route listing and route detail, and the generated Swagger schema has no `password` property; the ADMIN, CLIENT and DRIVER login responses match the base after normalizing ids, timestamps and tokens, and the 401 body for bad credentials is identical. It ran the unit inventory (52 suites / 688 tests), the focused integration suite (11/11) and the isolated E2E manifest (22 suites, 364 tests, exit 0, owned PostgreSQL cleanup confirmed), and it reproduced the differential itself from a scratch copy: removing only the `password` keys from the base payload makes it equal to the head payload. Its single advisory was that `docs/issue-31-auth.md` documented the two changed contracts without labelling them as breaking changes; the parent added an explicit breaking-changes section.

L12 — Advisory noted, not changed (parent). The verifier observed that `src/prisma/seed.ts` prints the plaintext seed password `client123` to the console. That is pre-existing CLI output of a development seed, not an API response and not a password-hash serializer, so it is outside the scope of this issue and was left untouched rather than widening the change.

L13 — Verification environment note (parent). The verifier's first scratch unit run used a temporary `node_modules` symlink, which made pnpm report "Already up to date" and run the dependency postinstall scripts. No package download was reported, the repository was not modified, and the verifier switched to a scratch-local dependency copy for every later check. The repository working tree kept its pre-existing state throughout.
