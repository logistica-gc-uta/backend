# Driver-owned route queries (#6)

## Objective and base
Implement `GET /api/v1/drivers/me/routes?date=YYYY-MM-DD` for authenticated DRIVER users, without extending route lifecycle or changing ADMIN endpoints. Worktree starts from local `main` at `c0f97a4b2b9abe2da443ea0d6e98f168b8dbead1` (PR #19). Branch: `feat/6-driver-own-routes`. No Issue #9 commits are included; remote main freshness is not yet verified.

## Authorized scope and constraints
- JWT `userId` is the only identity source; reject non-DRIVER roles and never accept caller-supplied identity or route ownership.
- Return only assigned routes and their orders, ordered by `stopOrder` with deterministic handling of NULL/ties; include zone, delivery address, status and relevant dates. Do not expose user credentials or unrelated personal records.
- Optional strict calendar-date filter applies to `Route.date`, using a documented `America/Guayaquil` local day: start inclusive, next midnight exclusive, independent of server timezone. Use existing date/instant utilities; no new dependency installation.
- Stable empty array for no assigned routes; malformed dates/unknown query identity fields fail closed. Existing ADMIN CRUD and DRIVER status-write restrictions remain unchanged.
- No Issue #7 optimization or Issue #10 route lifecycle, schema migration, other repository/Issue, global setup or installation changes.
- Human authorized local implementation/tests/commits and conditional publication/integration. Native candidate-specific consent and repository protections remain mandatory; no self-approval or bypass.

## Tasks
- [ ] D1: Implement one coherent ownership-query endpoint with strict query DTO, Swagger and unit/date regression tests.
- [ ] D2: Add dedicated real PostgreSQL authorization/isolation/date-order E2E and Newman cases, preserving existing security scenarios.
- [ ] D3: Complete handoff and template PR proposal; verify lint/build/coverage, acceptance and local work-unit boundaries; assess native RDD and record required consent/delivery blocks.

## Acceptance and checks
- Observe meaningful runnable RED before behavior changes, then GREEN/refactor; passive docs use structural checks.
- Tests: own routes, no routes/no profile, missing/invalid JWT, ADMIN/CLIENT rejection, cross-driver/forged identity attempts, stop ordering/ties/NULL, strict date validation and both local-day boundaries, existing ADMIN endpoints and DRIVER fail-closed status writes.
- Unit/full coverage with all four global thresholds >=80%; build and type-aware lint; owned PostgreSQL E2E; isolated Newman; OpenAPI endpoint/role/query documentation.
- No shared development database access; only uniquely owned loopback disposable PostgreSQL, cached image/no pull, exact ownership cleanup. No copied `.env`, ambient credentials or uncontrolled pnpm auto-install.
- Verification uses a private copy of existing dependencies and direct entrypoints or proven command-scoped `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false`; builds and server use of the same output directory must be serialized.
- Native RDD approval only from formal acknowledgement; local functional proof is not native or external approval. Remote CI and required independent review remain pending until verified publication.

## Routing and delivery
D1/D2/D3 use one bounded writer sequentially: multi-file behavior/tests/docs require delegation. Keep tests and docs with behavior; ~400 authored lines per task is advisory, never code-golf or artificial splitting. Forecast roughly 650–900 authored lines including security coverage; perform one coherent slicing pass before commits. Delivery strategy: single feature PR proposal with an explicit size-exception requirement if no cohesive <=400-line slices fit; no maintainer exception is assumed. The parent owns commits and native risk assessment after each committed boundary. First reviewed boundary is the branch point above. A pending consent blocks its candidate, not safe independent work elsewhere.

## Progress and evidence
- Read-only map and parent schema spot check verified technical independence from #9: baseline already contains Driver.userId, Route.date/zone/orders and Order.stopOrder/address/status.
- New managed worktree is separate from Issue #9; the original worktree keeps HEAD d869aa5 and uncommitted T4 docs, preserving its pending committed-only review candidate.
- Route-date timezone policy selected under the human's ordinary technical-decision authorization and the project's Ecuador context; calendar validation and boundary tests must verify it.
- D1 behavior implemented with method-level DRIVER role, validated JWT userId lookup, scoped route includes/minimal select, deterministic stop-order NULL/tie handling and native Temporal day conversion. Meaningful RED: focused Jest exit 1 (missing utility/methods; 2 failing assertions). GREEN: focused driver suites exit 0, 19 tests before later expanded service cases.
- D2 real PostgreSQL proof: uniquely owned cached-image/no-pull loopback container, baseline Prisma 8 db init + db verify exit 0. Three E2E suites / 54 tests pass (driver-owned routes + existing orders/app), with exact owner-label cleanup and confirmed container absence. No fixture extension or schema/migration required.
- Newman isolated proof: 67 requests / 270 assertions, zero failures, exit 0; original 59 scenario bodies preserved, 8 additions. Command-scoped PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false was verified by readonly config get. No installation or shared DB access.
- Nest build and type-aware Oxlint src/test both exit 0; git diff --check and bash syntax check exit 0.
- Full coverage exit 1: 21 suites pass / 1 fails; 172 tests pass / 4 existing runner-safety tests fail because mocks lack new owner-inspection handling. Reported totals: statements 98.21%, branches 87.54%, functions 93.54%, lines 98.23% (thresholds all80); coverage percentage does not imply suite PASS. Parent derived and authorized the paired exact test/run-newman-isolated.spec.ts surface to correct task-caused mocks without product expansion; existing failures were the RED evidence.
- Runner GREEN: owner-label inspection mocks model returned-ID existence and removal, verify no-pull, and add wrong-owner/unknown-ID fail-closed cleanup cases. Focused 9 tests exit 0. Final full coverage: 22 suites / 178 tests pass, exit 0; statements 98.21%, branches 87.54%, functions 93.54%, lines 98.23%, all four explicit thresholds80. Final lint/build exit 0. Initial failure log retained; no checks silently omitted.
- Shellcheck not installed: unavailable, no installation attempted. bash -n succeeds; installed CI shellcheck remains pending remote proof.
- Private proof source/dependency copy: no .env, no original dependency symlink/hardlink, direct Nest/Jest/Oxlint/Prisma entrypoints; serialized build/API runs. Sanitized evidence logs outside Git.
- Authored footprint approximately 1086 additions+deletions including recovery/PR docs. Keep this one cohesive endpoint+security+docs work unit; no artificial file-type split. Parent must explicitly handle size exception/slicing before delivery.
- D1/D2 implementation and local required proof are complete, but task closure awaits parent work-unit commit/evidence. D3 remains pending parent spot-check, native assessment/consent and publication prerequisites.
- No local Issue #6 commit, native RDD approval, publication, remote CI or independent review yet. Parent owns those actions.

## Next step
Parent spot-checks the final verified candidate and commits one coherent behavior/tests/docs work unit, assesses native RDD, and handles required consent/delivery conditions. Unpublished template proposal uses Refs #6 until acceptance criteria and delivery checks close.

