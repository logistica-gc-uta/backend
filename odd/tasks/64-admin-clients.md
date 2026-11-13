# Search registered CLIENT users from ADMIN (#64)

Objective: Expose `GET /api/v1/admin/clients` for ADMIN to search and paginate registered `CLIENT` accounts (`id`, `name`, `email`) as buyer candidates for `POST /api/v1/orders/admin`.
Branch: `feat/64-admin-clients`. Base: `0c7fc80` (`main`). Risk: item 2 (ADMIN authorization boundary and strict `CLIENT` field projection). No push/PR/merge/shared DB.

## Specs

S1. "GET /api/v1/admin/clients?search=texto&page=1&pageSize=20, solo ADMIN (401 sin JWT, 403 CLIENT/DRIVER)."
S2. "Devuelve únicamente usuarios con rol CLIENT: id, name, email. Nunca hash de contraseña, rol de otros usuarios ni datos de pedidos."
S3. "search opcional: coincidencia parcial sin distinguir mayúsculas en nombre o email (con un mínimo razonable de caracteres, por ejemplo 2). Sin search, lista paginada." Confirmed by user: minimum 2 trimmed characters when `search` is provided; omitted `search` lists paginated `CLIENT` users.
S4. "Paginación con items, total, page, pageSize (máximo acordado, por ejemplo 50) y orden estable (por nombre e id)." Confirmed by user: `page` default `1`, `pageSize` default `20`, max `50`; stable ordering by `name ASC, id ASC`; `User` has no deactivated/soft-delete fields.
S5. "No crea, edita ni vincula cuentas; no busca por teléfono (los usuarios no tienen teléfono persistido y los invitados no se vinculan por teléfono, según logistica-gc-uta/backend#64)."
S6. "ADMIN busca «ana» → aparece Ana Cliente (client1@delivery.com) con su id; ese id sirve como buyer.clientId en POST /orders/admin." "La búsqueda no devuelve ADMIN ni DRIVER aunque coincidan con el texto." "Un CLIENT o DRIVER que llama al endpoint recibe 403; sin token, 401."
S7. "Pruebas unitarias y E2E sobre PostgreSQL real: búsqueda, paginación, exclusión de otros roles y permisos." "Contrato documentado en docs/ y en Swagger antes de integrar con la web."

## Tasks

- [x] T1 [S1-S7] route: delegated (`gentle-ai-worker`, trigger: Context backstop >150k tokens) — Implemented `GET /api/v1/admin/clients` (`AdminClientsController`, `AdminClientsService`, DTOs) in `src/modules/auth/`, Swagger annotations, `docs/admin-clients-contract.md`, unit tests (`30/30` passed), and owned-Postgres E2E tests (`24/24` passed in `test/admin-clients.e2e-spec.ts`) — Risk: item 2 — commit `de09a66` (implementation/unit/docs)
- [x] T2 [S1-S7] route: delegated (`gentle-ai-verify`, trigger: Verification rule Risk item 2) + parent spot check — Independent verification (`mwe0jmps-5-k9ej`: static security & S1-S7 PASS, 2 advisories resolved) + full verification (`job-7`: `pnpm test` 94 suites / 1090 tests, `pnpm run lint` 0 errors / 0 new warnings, `pnpm run build`, owned-Postgres `test/admin-clients.e2e-spec.ts` 24/24) — Risk: item 2 — verified `de09a66`
- [x] T3 [S1-S7] route: inline (parent) — Reviewable work-unit commits on `feat/64-admin-clients` (`de09a66` + closing E2E/ODD slice) and close ODD tracking — done

## Log

L1. User request: "ralizmos una prueba con un acso real de integracion de una issue, recupera lo ulitmo que hizimos en la issue y luego comienza a implementar esta usando las herramientas disponible> feat(clientes): buscar clientes registrados desde administración #64". User confirmed open parameters: "si esta bien la recomendacion de la issue comienza la implementacion" (`search` min 2 chars when provided, `pageSize` max 50 / default 20; confirmed `User` in `src/prisma/contract.prisma:50-57` has no active/soft-delete column).
L2. Route decision: delegated T1 to `gentle-ai-worker` due to Context backstop (154,715 parent tokens) and T2 to `gentle-ai-verify` due to Risk item 2 (security boundary & user data exposure).
L3. T1 implemented by `gentle-ai-worker` (`mwe00par-4-1adm`, `status: partial` because worker MCP bridge `pi-agy-45d5889e` lacked `bash`). Parent verified all 4 T1 commands in foreground/jobs: `pnpm test -- src/modules/auth/admin-clients.service.spec.ts` exit 0 (1 suite, 30 passed, 1.396s); `pnpm run lint` exit 0 (0 errors, 1 warning `unbound-method` at `admin-clients.service.spec.ts:224` plus preexisting warnings); `pnpm run build` exit 0; `env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null pnpm test:e2e -- --runTestsByPath test/admin-clients.e2e-spec.ts` exit 0 (1 suite, 24 passed, 8.004s on owned PostgreSQL 16).
L4. T2 verified: `gentle-ai-verify` (`mwe0jmps-5-k9ej`) returned PASS (static) on S1-S7 with zero blockers and 2 advisories (lint `unbound-method` at `admin-clients.service.spec.ts:224`, and `.addBearerAuth()` in `DocumentBuilder` inside E2E test). Parent fixed hardcoded E2E file count (`34` -> `35`) in `test/ci-security.spec.ts:59,73` and `unbound-method` in `src/modules/auth/admin-clients.service.spec.ts`, then ran `job-7` cleanly: `pnpm test` (94/94 suites, 1090/1090 tests), `pnpm run lint` (0 errors, 0 warnings in `#64` files), `pnpm run build` (exit 0), `test/admin-clients.e2e-spec.ts` (24/24 passed in 7.164s on owned PostgreSQL 16).
L5. T3 closing slice: committed core feature, unit tests, and contract docs in `de09a66`; committing `test/admin-clients.e2e-spec.ts`, `test/ci-security.spec.ts`, and `odd/tasks/64-admin-clients.md` in the second work-unit commit on `feat/64-admin-clients` (no push/PR/merge).
