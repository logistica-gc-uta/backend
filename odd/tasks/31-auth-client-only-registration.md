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


S8 — Updated GitHub issue #31 (verbatim; supersedes the earlier limited acceptance scope):

## Objetivo
Corregir el registro público inseguro de usuarios, permitiendo **exclusivamente CLIENT**, y garantizar autenticación interoperable entre Shop, panel ADMIN y Flutter DRIVER, sin elevación de privilegios ni fuga de secretos.

**Responsable:** @Saimol-Uta.

**Proyecto:** REGALÍA — Shop de regalos · **Entrega académica:** 26/11/2026 · **Prioridad:** P0.
**Documentación:** [CI-SHOP-001 v1.1 — decisiones y contratos](https://docs.google.com/document/d/1vQzxxMJvDiC7VCawbubCILNupz_HBhrsC0CTxJQ1lfA/edit) · [ESP-SHOP-001 v1.2 — alcance](https://docs.google.com/document/d/1hPLYkA885tqwjhNWZ08IW7KjSqUPZV1TIAge4_OQ5SQ/edit) · [Figma — referencia visual opcional](https://www.figma.com/design/Gt0COrpEq6AXBSWrZ21ejX).

> **Jerarquía:** CI-SHOP-001 v1.1 prevalece para envío gratuito, IVA ficticio configurable, límites, horario Ecuador, dinero en centavos y contratos nuevos. ESP-SHOP-001 v1.2 conserva el resto del alcance. Figma NO define permisos, DTO ni importes. **Los endpoints Shop v1.1 aquí descritos son contratos objetivo, NO se afirma que existan en `main`.** Actualizar Swagger/OpenAPI y acordar contrato tipado con Kerly antes de integrar. No reemplazar ni romper las rutas logísticas existentes, ni cerrar sin pruebas.


## Estado actual a corregir
- `src/modules/auth/dto/register.dto.ts` actualmente admite `role?: ADMIN|CLIENT|DRIVER`.
- `src/modules/auth/auth.service.ts` actualmente utiliza `dto.role ?? CLIENT`: un anónimo puede intentar registrarse con rol privilegiado. **Corregir de forma prioritaria.**
- La ruta real tiene prefijo global `/api/v1`. `POST /api/v1/auth/register` y `POST /api/v1/auth/login` ya existen; no romper el shape de login usado por ADMIN/DRIVER.
- Frontend actual bloquea CLIENT en `AuthProvider`; corresponde a [frontend #20](https://github.com/logistica-gc-uta/frontend-web-logistica/issues/20), no se resuelve debilitando el JWT.

## Contratos y tareas
### A. Registro público — `POST /api/v1/auth/register`
- [ ] DTO estrictamente `{name,email,password}`, con longitud/formatos explícitos y compatibles con CI-SHOP v1.1: `name` string recortado 2..120, `email` válido normalizado, `password` 8..128; documentar el cambio respecto al mínimo legado y la compatibilidad para login de cuentas existentes.
- [ ] **Nunca** aceptar `role`, `isAdmin`, `permissions`, `userId`, `createdAt` u otros atributos no permitidos, ni siquiera `role:"CLIENT"`. La `ValidationPipe` global ya usa `forbidNonWhitelisted`; verificar DTO y tests de asignación masiva.
- [ ] Asignar `role:CLIENT` **desde el servicio/servidor**, no del request. ADMIN y DRIVER solo pueden provisionarse mediante procesos autenticados/preexistentes, no por esta ruta.
- [ ] Crear usuario con email único y password con hash bcrypt, nunca password/hash/salt en respuesta; resolver carrera de emails únicos contra índice de DB, no solo consulta previa.
- [ ] Respuesta `201` allowlist: `{id,name,email,role:"CLIENT",createdAt}`. `409 EMAIL_ALREADY_EXISTS`, `400 VALIDATION_ERROR` con estructura de error acordada; no retornar secretos por serialización accidental.

### B. Login — `POST /api/v1/auth/login`
- [ ] Mantener entrada `{email,password}`; respuesta actual compatible: `{access_token,user:{id,name,email,role}}`; `401 INVALID_CREDENTIALS` para contraseña/cuenta errónea.
- [ ] Emitir JWT firmado que identifique userId/rol verificado en backend; no aceptar rol del navegador y validar autorización en cada endpoint.
- [ ] Conservar acceso legítimo ADMIN, CLIENT y DRIVER y guards de rutas ADMIN, DRIVER y órdenes propias; evitar devolver `password`, hashes o credenciales en usuarios, conductores y errores.
- [ ] Revisar normalización de email, expiración de token, sanitización de respuestas y ausencia de secretos en logs.

### C. Pruebas de seguridad y regresión
- [ ] Registro normal devuelve CLIENT; `role:ADMIN`, `role:DRIVER`, `role:CLIENT` explícito y campos imprevistos fallan `400`; no existe ningún nuevo usuario privilegiado.
- [ ] Correo duplicado devuelve `409` incluso con dos registros concurrentes, sin `500` por unique violation.
- [ ] JWT de CLIENT no permite operaciones `/api/v1/admin/*`, catálogo ADMIN ni upload Cloudinary (401 anónimo / 403 rol incorrecto).
- [ ] Login de ADMIN/DRIVER/CLIENT se mantiene funcional; credenciales erróneas 401; ninguna respuesta contiene password/hash.
- [ ] Pruebas unitarias, integración NestJS y E2E de permisos reales; Swagger y documentos de contrato actualizados.

## Plan sugerido de PR
1. `#31-A`: corregir DTO/servicio y tests de registro/roles, compatibilidad login.
2. `#31-B`: proyecciones seguras de user/driver, pruebas de permisos, regresiones, Swagger.

## Definition of Done
- [ ] PR(s) referencian **#31**, evidencia de ataques por asignación masiva y pruebas 201/400/401/403/409.
- [ ] Lint, typecheck, unit/integration/E2E aplicables y CI verdes; revisión humana, sin merge automático.
- [ ] Coordinar con [frontend #20](https://github.com/logistica-gc-uta/frontend-web-logistica/issues/20) para admitir CLIENT en Shop **sin abrir el panel ADMIN**.

**Fuera del alcance obligatorio:** recuperación de contraseña, envío de correos o provisión pública de ADMIN/DRIVER.


S9 — Current execution constraint (verbatim): "primero implementa la funcionalidad y luego me pides autorizacion para la pruebas". No test execution until explicit human authorization.

S10 — Security implementation decision for S8: preserve the full 8..128 character password contract using a versioned SHA-256 prehash followed by bcrypt for new accounts; retain raw bcrypt verification for existing stored hashes. No schema/data migration or legacy password rewrite. This resolves the independently identified 72-byte truncation defect rather than lowering the accepted limit.

## Tasks
T0 | S1,S4 | inline baseline + RED observation for role escalation | done | Baseline 51 suites / 684 tests, exit 0, `pnpm test --roots src test`; plain `pnpm test` fails pre-existing on the leftover `.issue13-*` haste collision.
T1 | S1,S4 | delegated writer: registration role lock (DTO whitelist + service hardcode) | done | `role` removed from `RegisterDto`; `AuthService.register` persists `Role.CLIENT` unconditionally. Observed escalation: 400 `property role should not exist`. RED seen first (E2E `expected 400, got 201`).
T2 | S2 | delegated writer: redact password hashes and secrets from user/driver responses | done | Explicit allowlist projections in `drivers.service.ts` and `routes.service.ts`; `password` removed from `AdminRouteHistoryUserDto`. Independent parent sweep of `src/` found no remaining unprojected user serialization.
T3 | S3,S4,S5,S6 | inline: regression, CI inventory, evidence doc, closure | done | 52 suites / 688 tests green, build 0, lint 0 (one pre-existing warning in an untouched file); isolated E2E manifest 22 suites exit 0 with owned PostgreSQL cleanup confirmed; differential check against `13a557e` found only the intended differences.

T4 | S8,S9 | delegated (context backstop): implement updated auth requirements, then run authorized checks | done | Branch remains feat/31-auth-client-only-registration
T5 | S8,S9 | parent: request test authorization, execute minimal checks after approval, prepare PR | pending | No publishing/merge yet

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

L14 — User changed scope to issue #31 only, implementation first and authorization before tests. Existing #32–#35 work is preserved but inactive. Earlier test results apply only to the prior commits, not updated acceptance. The local CI-SHOP-001 v1.1 file is an adenda without detailed auth error formats; preserve existing NestJS error fields and login success shape, add issue-required machine codes without changing global exceptions. Do not build missing Shop endpoints in this auth issue. PR preparation is authorized; remote publishing is deferred until verification and explicit delivery decision.

L15 — User authorization (verbatim): "tienes la autorizacion para las pruebas necesarias para garantizar el cumplimiento de la issue, si todo sale correcto has el PR". Tests and conditional PR publishing authorized; never merge.
L16 — Parent executed focused auth units25/25, owned PostgreSQL E2E32/32, build0/lint0. Two new lint warnings fixed. Independent verifier mvklst4b-2-i60e returned PARTIAL structural-only: bcrypt truncation is a blocker, deterministic real unique-insert race and anonymous401/DB-role JWT revalidation need proof. One correction batch delegated to mvklv2ry-3-zqfd; preserve128 chars with versioned bcrypt-SHA256, legacy raw bcrypt unchanged. Do not claim updated acceptance complete before correction and recheck.

L17 — Final corrected candidate: writer33/33unit35/35E2E/lint0; parent build0 and unit regression53suites709tests. Same independent verifier recheck mvkm13jc-4-ikrg PASS33unit35E2E on isolated copy, all original blockers resolved. User authorized bypassing GGA only for #31 commits and confirmed issue status:approved; verified live. Hook normal commit failure is missing AGENTS.md; no permanent hook change. main refreshed remains13a557e. PR delivery in progress, no merge.
