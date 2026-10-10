## Delivery Strategy & Maintainer Size Exception
- Delivery strategy: `single-pr`; user-approved `exception-ok` (`size:exception` granted by maintainer).
- Justification: The combined changes (Prisma 8 relational contract, cross-entity PL/pgSQL consistency triggers, and route lifecycle services) constitute an atomic relational unit. Splitting into multiple PRs would temporarily violate schema invariants and cross-table constraints in intermediate states.

# Route lifecycle, immutable visits, and depot return (#10)

## Objective and baseline

Implement Issue #10 without absorbing Issues #7, #12, or #13. Preserve the
merged driver-route and geolocation contracts and the Issue #8 order policy.

- Branch: `feat/10-route-lifecycle`.
- Branch point / initial review boundary: `3b43bb7a9fa72a06aaf576073ecf31c38a4d7287`.
- Initial checkout: clean `feat/9-geolocation-persistence` at `82da8c8`.
- Public main fetch and branch creation completed; no other work was overwritten.
- Native runtime: Gentle-AI 4.0.0; RDD on, decided by global preference.
- Current status: T1a implemented and verified on `codex/10-t1a-route-policy`;
  normalized source and existing runtime contracts remain unchanged by integration.
  Native RDD consent/review and commit are pending; no database checks have run.

## Verified problem and constraints

`Route.driverId` is required and route lifecycle timestamps are absent.
`Order.routeId` / `stopOrder` are the only persisted visit association.
`Driver.isAvailable` becomes false on assignment without a depot-return lifecycle.
Existing assignment transactions do not establish race-safe conditional claims.
DRIVER order writes intentionally remain disabled until persisted route execution exists.

Read the complete Issues #10/#7/#12/#13 and the five requested Drive documents,
including their 09/10/2026 addenda. Main includes merged PRs #20 and #21; the
open-PR list was empty at audit time. Issues #6 and #9 remain open despite those merges.

Only explicit ADMIN confirmation persists DRAFT; calculation remains temporary.
Routes have at most four stops, one zone, and compatible scheduling dates.
DRIVER identity comes from validated JWT; resource ownership is mandatory.
Structure freezes at IN_PROGRESS; COMPLETED resolves visits, not depot return.
Failure is a visit outcome, never artificial DELIVERED or CANCELLED.

## Approved model and additional safeguards

- Optional route driver; centralized DRAFT -> ASSIGNED -> IN_PROGRESS -> COMPLETED policy.
- Server-recorded start, completion, and depot-return times with actor audit.
- RouteStop owns stable historical route/order/sequence association and visit outcome.
- Append-only attempt records retain actor, reason, context, time, and retry identity.
- Database-enforced active-order claims prevent simultaneous active dispatches.
- Driver reservation spans assignment through confirmed return; DRAFT reserves no driver.
- Order.routeId remains a compatibility pointer, never the historical source of truth.
- Operational order claims release only when every visit is resolved and the route
  validly becomes COMPLETED. Release is NOT planning eligibility. Failed orders
  remain administratively blocked until #12 records recipient contact and an
  agreed new schedule; never automatically change them to PENDING, DELIVERED,
  or CANCELLED, and never create automatic retries.
- Additive legacy backfill preserves known associations/order values. Unknown route
  execution/return and missing or ambiguous stop sequences stay explicitly unverified.
  Do not invent events or permit incompatible operational reuse until legacy data
  is reconciled. Provide a safe, audited ADMIN reconciliation/regularization path
  that preserves ambiguous associations and prevents indefinite driver blocking.
- Legacy routes are not falsely classified as DRAFT, IN_PROGRESS, or COMPLETED.
  Audit queries retain unverified records; test missing/ambiguous ordering and
  lifecycle explicitly. Reconciliation records administrative evidence, not fake
  historical start/completion/depot-return events.
- New invariants require database constraints and consistent row-lock ordering, not DTOs alone.

The user approved this additive model and these conditions. Native RDD consent
remains independent. Before any irreversible migration on persistent data, present
its impact and obtain specific authorization. Tests use owned isolated PostgreSQL;
no destructive or shared-database operation is authorized.

## Intended HTTP integration — proposal pending implementation

| Contract                                      | Access                | Purpose                                                                                               |
| --------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| GET /api/v1/routes and /routes/:id            | ADMIN                 | Reuse current reads; add lifecycle and historical stops.                                              |
| GET /api/v1/drivers/me/routes?date=...        | DRIVER owner          | Reuse merged #6 endpoint; preserve existing fields.                                                   |
| POST /api/v1/routes                           | ADMIN                 | Persist a confirmed DRAFT, without implementing planning.                                             |
| POST /api/v1/routes/:id/assign                | ADMIN                 | Assign an existing DRAFT to an available driver.                                                      |
| POST /api/v1/routes/assign                    | ADMIN                 | Preserve existing atomic create-and-assign compatibility wrapper.                                     |
| POST /api/v1/routes/:id/start                 | DRIVER owner          | Explicit, idempotent ASSIGNED start.                                                                  |
| PATCH /api/v1/orders/:id/status               | Existing roles/policy | Reuse successful delivery path, gated by owned IN_PROGRESS route.                                     |
| POST /api/v1/routes/:id/stops/:stopId/failure | DRIVER owner          | Resolve a failed visit with validated reason and context.                                             |
| POST /api/v1/routes/:id/complete              | DRIVER owner          | Close only when every visit is resolved.                                                              |
| POST /api/v1/routes/:id/return                | DRIVER owner          | Persist idempotent depot return and release driver reservation.                                       |
| POST /api/v1/routes/:id/reconcile             | ADMIN                 | Safely regularize an unverified legacy route with an audit record, without inventing business events. |
| GET /api/v1/drivers/me/availability           | DRIVER owner          | Report effective availability and blocking route/return condition.                                    |
| GET /api/v1/drivers                           | ADMIN                 | Extend existing driver read with effective availability.                                              |

T1 must finalize typed DTOs, status codes, error semantics, replay identity, ownership,
and transaction boundaries before these contracts are implemented. No client-controlled
driver identifier is accepted by DRIVER operations.

## Authorized scope and boundaries

Implement lifecycle, assignment/start integrity, visit results, closing/return,
history, typed REST/OpenAPI, migrations, and isolated regression evidence.
Do not implement optimization, OSRM, GPS tracking, UI, Socket.IO, push delivery,
complete administrative rescheduling, or payment features.
No Drive edits, force pushes, hard resets, merging, or issue closure.
Publication requires a separate explicit authorization.

## Work units and acceptance

- [ ] **T1 — Model, policy, and additive migration.** Finalize approved model and
      REST contracts; distinguish reservation from planning eligibility; observe
      migration compatibility on empty/populated/ambiguous ephemeral PostgreSQL;
      preserve legacy evidence and define recovery. Route: delegated,
      triggered by multi-file schema/migration logic and preparation reading.
  - [ ] **T1a — Lifecycle and eligibility policy.** Pure shared policy and unit
        tests for the four verified states, legacy fail-closed behavior, structural
        freeze, completion prerequisites, driver reservation through return, and
        reservation-versus-planning eligibility. No persistence or endpoint changes.
        Branch `codex/10-t1a-route-policy`; base `feat/10-route-lifecycle` at `3b43bb7`.
  - [ ] **T1b — Additive route/stop contract and legacy compatibility.** Finalize
        the schema, generated artifacts and compatible migration with real isolated
        PostgreSQL evidence; derive coherent slices from the actual inseparable diff.
  - [ ] **T1c — Database integrity and migration recovery.** Effective constraints,
        reservation/history protection, ambiguous-data and recovery tests. Boundaries
        may be refined without omitting dependencies or exceeding a formal budget.
- [ ] **T2 — Assignment, start, and structural freeze.** JWT ownership,
      idempotent explicit start, database-enforced reservations, and concurrent
      start/edit checks. CP-RUT-007/008. Route: delegated, multi-file transactional logic.
- [ ] **T3 — Visit results and close.** Reuse order policy; persist success/failure
      without false commercial status; reject unresolved closure; preserve attempt
      identity under timeout retries. CP-SEG-004 and the closing portion of CP-RUT-012.
      Route: delegated, multi-file transactional logic.
- [ ] **T4 — Depot return and availability.** Auditable owner-only return,
      concurrent replay safety, no second load before return, and safe audited ADMIN
      legacy regularization without indefinite driver blocking. CP-RUT-013 and the
      new-dispatch portion of CP-RUT-012. Route: delegated, multi-file transactional logic.
- [ ] **T5 — Integration and regression.** Typed Swagger, Newman, real PostgreSQL
      E2E/concurrency, migration recovery, coverage, and #6/#8/#9 compatibility.
      CP-SEG-008 foundational history proof is in scope; complete administrative
      rescheduling remains dependent on #12. Route: delegated, broad verification.

## Verification and review record

T1a: `pnpm test --runInBand --runTestsByPath src/modules/routes/route-lifecycle.policy.spec.ts`.
Observed RED: 11 assertion failures/17 passes; GREEN: 28/28, independently rerun 28/28.
`pnpm test --runInBand --coverage`: 266/266 tests, 26 suites; new policy coverage 100%.
Full coverage: 98.5% statements, 90.46% branches, 94.59% functions, 98.54% lines.
Lint/build passed; migration, database/concurrency, acceptance E2E and native RDD pending.

Commands: unit/lint/build executed; PostgreSQL/E2E/Newman remain pending.
`pnpm run build`; `pnpm run lint`; `pnpm test --runInBand`;
`pnpm run test:e2e --runInBand`; `env -u DATABASE_URL pnpm run test:api:report`.
Database suites must use disposable owned PostgreSQL and never an ambient shared URL.
Record exact coverage, failed/skipped checks, and command outputs per unit.

Native RDD uses exact provider-issued STATUS/START/collection/acknowledgement
continuations and candidate-specific consent. No review started and no receipt exists.
Normalize before candidate freeze; never mutate receipt artifacts or bypass a stop.
Only observed checks and terminal acknowledgement can close a review record.

## Delivery and progress

- Delivery strategy: `auto-chain`; user-approved `feature-branch-chain`.
- Integrator `feat/10-route-lifecycle` remains based on main at `3b43bb7`.
  First local child `codex/10-t1a-route-policy` targets the integrator; later child
  bases follow their actual dependencies. No remote branch or PR exists.
- Preliminary authored-line forecast: 1,500–2,500, excluding generated artifacts;
  this is an estimate, not a size acceptance criterion or reason to omit tests.
- Respect 400 changed lines per formal slice; never assume generated artifacts or
  the accumulated integrator diff are exempt. Split only coherent work and obtain
  any required exception explicitly. Before publication, present all branch/PR
  bases, actual diff counts, dependencies and the integral review procedure.
- No push, PR opening, merge (including integration), destructive migration or
  issue closure is authorized. Publication and integration remain separately gated.
- Work-unit commits: none. Running committed authored lines: 0.
- PR and CI: no Issue #10 PR; no published candidate or new CI run.
- Engram mirror: `odd/10-route-lifecycle/tasks`; full document synchronization required.
- Next action: implement and verify T1a with exact bounded edit surfaces, normalize,
  measure the complete candidate, obtain native RDD consent/acknowledgement, then
  commit locally. Continue dependent T1b only after this unit reaches closure.

## Sources

- https://github.com/logistica-gc-uta/backend/issues/10
- https://github.com/logistica-gc-uta/backend/issues/7
- https://github.com/logistica-gc-uta/backend/issues/12
- https://github.com/logistica-gc-uta/backend/issues/13
- https://github.com/Gentleman-Programming/gentle-ai/blob/v4.0.0/docs/review-integration.md
- https://github.com/Gentleman-Programming/gentle-ai/blob/v4.0.0/docs/architecture/organic-rdd.md

## Autonomous continuation — independent worktree

This recovery copy belongs to `codex/10-t1b-model` at the same main baseline.
The original T1a worktree and its staged 400-line candidate remain immutable.
Its candidate is `sha256:a410b6b92b1a404c85126dc378a48aa4eaf7c4ab8c46218c65e6558a7763e7fd`.
No individual RDD consent has been granted and no review, commit, or publication
has occurred. Prior publication limits above record the frozen snapshot; the
latest user authorization permits conditional publication only after all required
review and repository controls, never as a substitute for candidate consent.

Official v4.0.0 consent relay precedes compact authority creation. Independent
pre-review implementation in linked worktrees is allowed; a native deferred
review queue is not established. Preserve candidate sources and real verification
evidence, request consent later, and do not create grants or declines now.

T1b preparation may proceed independently from main because its additive schema
and migration do not import unreviewed T1a policy. Integration remains pending T1a
and each candidate's native review. Do not label the complete feature implemented.
Generated contract/migration changes count in the formal 400-line PR budget;
indivisible over-budget candidates require explicit `size:exception`.

- [ ] T1b: additive contract, legacy-preserving migration and isolated PostgreSQL proof.
- [ ] T1c: database constraints and immutable-history/concurrency proof.
- [ ] T2–T4: REST integration remains dependent on reviewed schema and policy.
- [ ] T5: final integrated regression, Newman and acceptance proof.

Route: delegated. Trigger: multiple non-trivial model/migration/test files and
reading required before implementation. Current model worktree has no source
changes yet; checks and native candidate identity are pending.

## T1b implementation and proof — pending review and commit

Implemented independently on `codex/10-t1b-model`, based on `3b43bb7`.
No T1a source was copied or integrated; its original worktree was not modified.
This unit is implemented and proven, not closed: native consent/review, any
required size exception, and its work-unit commit remain pending.

### Contract and migration

- Added nullable driver/lifecycle/times and actor references to Route. No lifecycle
  default or inferred start/completion/return time is introduced.
- Added RouteStop, DeliveryAttempt, OrderClaim, DriverReservation, and
  LegacyRouteReconciliation. Visit outcomes are separate from commercial status.
- Preserved every known legacy route/order link and raw sequence, including null,
  duplicate and invalid values; legacy outcomes and creation times remain null.
- Backfill sets `isLegacy` explicitly; partial sequence uniqueness applies only to
  verified non-null positions. Structural validity and history immutability are T1c.
- Active claims/reservations have partial unique indexes on unreleased resources.
  Claims are not fabricated from ambiguous legacy data. All original driver links
  remain available for conservative unresolved-route recognition in T2/T4; no
  arbitrary winner or invented reservation/release timestamp is chosen.
- Stored attempt payload supports later replay comparison. Audit references and
  role validation, append-only enforcement, lifecycle transitions and release
  transactions remain inactive and require T1c/T2/T3/T4 integration.
- Existing create-and-assign APIs remain buildable and unmodified. They still
  write compatibility associations only, and create routes with null lifecycle;
  do not activate/deploy the new operational model as complete before integration.

Migration: `migrations/app/20261010T0526_route_lifecycle_foundation`.
Origin: `00d34ab56ae55b663a53148a126d233c0801ea6863ee0e3b22273a20d77d862e`.
Destination: `46fa53371d5e324c936c448652fedcf104429400542c3159e5551c01e9210452`.
Migration hash: `8b41a571c3ea5f0cb6f07b73b64b21fef0057e38a4fcfd04e7ed2abe04555211`.
Generated via `pnpm prisma contract emit`,
`pnpm prisma migration plan --from 00d34ab --name route_lifecycle_foundation`,
then self-emitted with `node migrations/app/20261010T0526_route_lifecycle_foundation/migration.ts`.
Existing migrations, refs, and historical snapshots were not changed.

### Observed checks

Dependencies: `pnpm install --offline --frozen-lockfile --ignore-scripts` passed;
no tracked package/lock/config changes. Exact version remains Prisma rc.11.

- `env -u DATABASE_URL pnpm run test:e2e --runInBand --runTestsByPath test/route-lifecycle-migration.e2e-spec.ts`:
  observed RED, 8 failures. The lifecycle-column assertion read the real baseline
  columns and failed against expected additions; remaining tests exposed absent
  foundation tables/columns. Initial GREEN 8/8; expanded/refactored suite 10/10; final normalized suite 11/11.
- Fresh and populated legacy PostgreSQL paths, exact associations, ambiguous
  sequences, preserved commercial statuses, driver collision preservation,
  driverless DRAFT, cross-route historical/future stops, active-claim collisions,
  release history, replay payload, and administrative evidence were exercised.
- A conflicting baseline table caused the migration transaction to fail; earlier
  DDL was rolled back, the baseline marker survived, and the conflicting table
  remained untouched. A failed claim transaction likewise left no partial claim.
- PostgreSQL used only new owned `postgres:16-alpine` containers with ownership
  labels and loopback random ports. Suite teardown asserted container removal
  and scratch-directory cleanup. No ambient/shared database was used.
- `pnpm test --runInBand`: 238/238 tests, 25/25 suites passed (main baseline,
  intentionally excluding unreviewed T1a source).
- `pnpm run lint`, `pnpm run build`, `git diff --check`: passed.
- Scoped `pnpm exec prettier --check` for authored migration/test TS and this
  document: passed after final normalization.
- Integrated HTTP/Newman/acceptance tests and native RDD: not run for this
  inactive schema foundation. No business acceptance PASS or receipt exists.

### Cohesive slicing assessment and next unit

Generated contract/snapshot/migration artifacts exceed the formal 400-line budget
inseparably. Separating the typed artifacts, DDL, backfill and isolated proof would
leave incomplete or inconsistent migration units. Preserve this cohesive candidate;
obtain explicit maintainer `size:exception` before candidate freeze/review/commit.
No size exemption is inferred from generated content.
Final candidate: 10,338 changed lines (9,682 additions, 656 deletions), including
1,242 conservative authored lines (entire edited migration source counted) and
9,096 generated artifact lines. Tracking document is included in these counts.

Next blocking work: parent reviews the implementation evidence and actual full
candidate count, resolves size handling and native consent, then closes T1b only
with acknowledged review and a work-unit commit. T1c must add database structural
and append-only enforcement, safe legacy hold reconciliation, actor constraints,
and concurrency proof before lifecycle endpoints can rely on the model.

### T1b pre-freeze reason-contract correction

Removed the unapproved generic failure reason. The canonical VisitFailureReason
now contains only `RECIPIENT_ABSENT` and `RECIPIENT_REFUSED`, matching the DTO
contract. The isolated attempt test accepts both canonical values and rejects
`ABSENCE`, `REFUSAL` and `OTHER` at the database check boundary.

Re-emitted the contract and regenerated the native foundation from unchanged
`00d34ab`; retained the same foundation directory and exact backfill semantics.
Removed only this unreviewed unit's obsolete destination snapshot. Historical
migrations, refs and snapshots remain untouched. No T1a changes were made.

Fresh correction checks: isolated PostgreSQL 11/11, full unit 238/238 (25 suites),
lint and build passed. Scoped formatting passed after final normalization. Owned-container and scratch cleanup assertions passed again.
No review, consent, commit or publication occurred.

## T2a isolated explicit-start scope

Branch `codex/10-t2a-explicit-start` implements only owned DRIVER start, based on
unreviewed dependency tree `16b91b91f3ef13281ab284b8065653606773b9fd`.
Copied T1a policy and T1b schema/migration are read-only. No consent, commit,
review, publication or integration closure is authorized. Route: delegated;
transactional endpoint and multiple non-trivial tests require a bounded writer.
Driver then owned route are locked by supported Prisma 8 transactional no-op
updates; no availability projection changes or SQL API guesses are authorized.
Validate active reservation, verified pending stops and matching order claims.
Date compatibility and assignment contracts remain unresolved dependencies;
T1c out-of-band constraints are not present in this worktree.

### T2a observed implementation and proof (not closed)

Production `POST /api/v1/routes/:id/start` added with existing real JWT/DRIVER
role guards, UUID validation, body rejection, typed Swagger and JWT actor audit.
Prisma rc.11 callback transaction locks driver then owned route via no-op updates;
conditional ASSIGNED transition writes server Temporal.Instant and startedById.
Matching verified active driver reservation, 1–4 contiguous nonlegacy PENDING
stops, same-zone assigned orders and active claims are required before start.
Concurrent IN_PROGRESS replay preserves original audit time/actor; no order
status or driver availability write occurs. Errors roll back lock-only writes.

RED: compilable stub produced 11 assertion failures. Initial GREEN focused15/15;
expanded unit suite19/19. Intermediate three failures were inaccurate new order
mocks, corrected to use mutable fixture evidence. Initial PG harness failed for
missing PassportModule options; registering the real Passport module fixed it.
Owned PostgreSQL16 HTTP suite8/8 proves simultaneous starts/replay, competing
routes, actual JWT/database-role/ownership, malformed UUID/body, invalid states,
unverified stop rejection, injected post-write rollback and real Swagger metadata.
Suite teardown verifies owned container removal and scratch-directory cleanup.
Offline frozen dependencies installed with ignored scripts, no lock/package edits.
Final normalized focused20/20, full282/282 (27 suites), owned PG8/8, lint,
build and scoped Prettier check passed. No Newman or integrated business acceptance PASS is claimed.

The honest cohesive incremental endpoint plus proof exceeds formal400. Splitting
required concurrency/security/rollback proof away would leave an incomplete unit;
preserve it and require explicit size exception before any candidate freeze.
Copied policy/schema/migration dependencies match tree16b91b... unchanged.
Native consent/review/receipts, commit, publication and integration remain pending.
Calendar-compatible dates and assignment integration are unresolved; pending T1c
out-of-band structural guards are not active in this worktree.

Final incremental budget versus dependency tree16b91b...: 728 additions plus
12 deletions = 740 changed lines across ten files; size exception required.
Copied dependencies remain unchanged; parent authorized restaging corrected source.

### T2a pre-review ownership-lock correction

Parent readback found that the driver lock UPDATE result was ignored. Concurrent
profile reassignment/deletion after the initial read could yield null and reuse
stale identity. Start now requires the returned owned locked row or rejects403
before attempting any route update. Fresh route read already verifies route
ownership after its lock attempt. Deterministic regression observed RED1/20,
then GREEN20/20. The mock now returns the real rc.11 row-or-null shape.
Existing PG concurrency/security suite is rerun; no new actual PostgreSQL
profile-reassignment race proof is claimed because T2a has no such barrier harness.
No native review, consent, commit or publication; size exception remains required.

## T3 progress implementation scope (unreviewed)

- Isolated baseline tree: `0607539ee3be103c0413f96e345bcc72b29850f4` includes T1a/T1b/T1c/T2a/T5a. None is reviewed or integrated authority.
- Implement authenticated DRIVER visit failure, existing commercial IN_TRANSIT/DELIVERED transitions, and route completion with callback transactions and Driver-before-Route locks.
- Persist stable attempt evidence and equal-payload replay; completion releases order claims only, not the driver reservation or availability.
- Preserve commercial statuses after failed visits and block administrative interference with operational visits.
- No schema/migration changes, rescheduling, review, staging, commits or publishing. Database result/claim coherence and scheduling-day normalization remain pending dedicated work.
- Verification: observed unit RED/GREEN; full unit/lint/build; owned PostgreSQL HTTP progress/start/integrity suites; scoped formatting and whitespace checks.

### T3 observed proof and recovery

- Unit RED: focused `route-progress.service.spec.ts` failed all 3 real authorization/completion assertions against minimal stubs. Focused GREEN initially 40 tests across progress/orders/controller; expanded progress guard suite later passed 20 tests.
- First PostgreSQL progress run: 2 passed / 7 failed. Root cause was installed Prisma JSON-string return decoding; structured context storage corrected it while preserving the HTTP string.
- Copied start suite first failed 8 tests for the added controller provider, then failed 8 tests because protected history cannot be truncated. Parent authorized only the two isolated start-test surfaces. Each test now uses a fresh owned database; historical NULL lifecycle is seeded before the integrity migration, not invented by rewriting a verified route. Frozen original T2a bytes remain untouched.
- Next combined progress/start run: 15 passed / 2 failed (wrong absent-stop expectation and forbidden verified-to-NULL setup); both corrected. Subsequently the exact required progress/start/integrity command passed 28 tests in 3 suites, with owned container and scratch cleanup assertions.
- Full unit runner passed 333 tests in 31 suites before expanded guards; lint and build passed. Terminal expanded proof is recorded below.
- Transactions protect new failures, successful delivery and completion; injected failure tests verify rollback. Existing commercial transitions remain centralized, failed status is never invented, and driver reservations/availability are not released by completion.
- All source changes are isolated and unreviewed. No schema or migration modifications, native consent/review, staging, commits, publishing or catalog-wide acceptance PASS.
- Cohesive slicing assessment: shared progress transactions, existing-order endpoint integration, both new HTTP handlers, regression fixtures and their proof form one behavior boundary. Retain the complete unit; an over-400-line formal candidate needs a future maintainer `size:exception`, not omitted tests or code compression.
- Remaining: dedicated DB attempt/result/claim coherence, scheduling-day normalization, assignment integration, legacy reconciliation, depot return and administrative retry/rescheduling. Dependency tasks remain unreviewed.
- Expanded final proof observed: `pnpm test --runInBand` passed 353 tests / 31 suites; lint/build passed; exact three-suite owned PostgreSQL command passed 28 tests / 3 suites in 62.98 seconds; scoped Prettier and whitespace checks passed.
- Parent authorized `src/modules/orders/orders.controller.ts` metadata-only correction to remove stale DRIVER-blocked Swagger wording. Path, roles and typed existing response remain unchanged.
- Final readback added an explicit route-lock acquisition guard: ownership becoming valid only after a missed conditional lock must not authorize replay. A real assertion RED observed the previously returned completion replay instead of rejecting; correction requires a non-null locked row after fresh ownership read. Final normalized verification repeats below; no native review or staging occurs.

### T3 terminal handoff (implemented/proven, not closed)

- `pnpm test --runInBand`: 354 tests / 31 suites passed on normalized terminal source.
- `pnpm run lint` and `pnpm run build`: both passed with exit 0.
- `env -u DATABASE_URL pnpm run test:e2e --runInBand --runTestsByPath test/route-progress.e2e-spec.ts test/route-start.e2e-spec.ts test/route-lifecycle-integrity.e2e-spec.ts`: 28 tests / 3 suites passed in 63.215 seconds (progress 9, start 8, integrity 11).
- Scoped Prettier check and `git diff --check` passed. PostgreSQL suites assert owner-checked container removal and scratch cleanup; no shared database was contacted. Two simultaneous identical failure HTTP requests persist exactly one event. Integrity tests retain actual two-session lock-barrier races.
- Index remains exactly the parent-staged baseline tree. Incremental implementation remains unstaged, including six new untracked files. No native review, consent, commits, publishing or receipts.
- Final incremental budget: 1733 additions + 187 deletions = 1920 authored changed lines; 0 generated. One cohesive slicing pass retains transactions, endpoint integration, history proof and docs together; future formal review requires a maintainer size exception.

Changed file manifest (repository-relative):

- `docs/route-lifecycle-api.md`
- `docs/route-progress.md`
- `odd/tasks/10-route-lifecycle.md`
- `src/modules/orders/orders.controller.ts`
- `src/modules/orders/orders.module.ts`
- `src/modules/orders/orders.service.spec.ts`
- `src/modules/orders/orders.service.ts`
- `src/modules/routes/dto/route-progress-response.dto.ts`
- `src/modules/routes/route-progress.service.spec.ts`
- `src/modules/routes/route-progress.service.ts`
- `src/modules/routes/routes.controller.spec.ts`
- `src/modules/routes/routes.controller.ts`
- `src/modules/routes/routes.module.ts`
- `test/route-progress.e2e-spec.ts`
- `test/route-progress.fixtures.ts`
- `test/route-start.e2e-spec.ts`
- `test/route-start.fixtures.ts`

## T4 isolated implementation scope (not reviewed or closed)

Baseline tree `5504317f61aff96931c89f31b12528033534b69a` combines unreviewed
T3 and T1d dependencies. T1d controller/provider assembly must preserve T3
handlers and precedes behavioral RED; assembly itself is not a behavior test.
Route: delegated direct for return, centralized availability, audited legacy
reconciliation and deterministic/owned PostgreSQL proof. Driver-before-Route
locks and checked fresh identity are required; only COMPLETED genuine audit
may return. Reconciliation preserves all legacy associations and events.
All candidate consents remain deferred; no review, commit, publication or
integration closure. Legacy wrapper activation and scheduling-day policy remain
unresolved; exact instant equality remains a temporary strict constraint.
Required full unit, lint, build, five-suite owned PostgreSQL, formatting and
whitespace checks are pending. One cohesive slicing assessment will retain
required proof and report any formal400 overage before a candidate freeze.

### T4a bounded slicing decision

Parent narrows this unit to physical depot return, shared effective availability,
and T1d/T3 provider/handler assembly. ADMIN reconciliation mutations and their
endpoint/DTO/proof are deferred to T4b. T4a reads persisted legacy release audits
but cannot clear legacy holds. Return and its atomic availability recomputation
remain inseparable; concurrent return/assignment, replay, rollback and JWT proof
remain required. This is the one honest slicing pass, not a budget-driven test cut.

### T4a observed proof and bounded recovery

- Dependency assembly preserves start/progress handlers and adds confirmed-DRAFT
  and assignment handlers/providers; this assembly was not labeled behavioral RED.
- Availability stub RED: six assertion failures / seven tests. Return stub RED:
  twelve assertion failures / twelve tests. Core GREEN: nineteen / nineteen.
- First full unit run: 376 tests / 34 suites passed; expanded controller/identity
  checks: 380 / 34 passed. Lint and build passed before terminal normalization.
- First owned PostgreSQL return run: five passed / three failed. Actual timestamp
  precision mismatch broke original/replay equality; response now uses the stored
  UPDATE row timestamp. Legacy fixtures now seed before integrity guards, rather
  than inserting protected historical stops after migration.
- First exact five-suite PostgreSQL run: 52 passed / one failed / 53 total, five
  suites, 132.566 seconds. Copied assignment rollback constructor omitted the new
  real availability provider; it is now injected. This was test-host dependency
  assembly failure, not proof of business rollback. Required final rerun pending.
- Owned containers/scratch were removed with suite assertions. No suite remains
  active at recovery. First pnpm12 test automatically installed dependencies and
  ran scripts (including Prisma skill synchronization and scarf). No explicit
  ignore-scripts installer was run; package/lock and tracked skill bytes remain
  identical to prepared tree. No side effects were hidden or restored.
- One cohesive slicing pass retains physical return, centralized operational
  availability, handler/provider assembly and required security/race/rollback
  proof. Formal400 overage requires future maintainer size:exception. T4b ADMIN
  reconciliation remains deferred, not implemented or proven by T4a.
- Native consent, reviews, receipts, commits, publication and integration closure
  remain absent. Scheduling-day policy, legacy wrapper activation, and interunit
  cancellation-versus-DRAFT claim coordination remain unresolved.

### T4a pre-freeze availability consistency correction

Parent readback identified a real mismatch: a hold-free driver with a false
compatibility flag was reported available but assignment necessarily refused.
Observed deterministic RED: one failed / seven passed / eight total. The central
query now exposes persisted holds and compatibility veto separately and combines
both in effective isAvailable; assignment has no copied boolean rule. Genuine
return first recomputes the compatibility projection from persisted holds in its
transaction, then returns the effective projection, so its old false flag cannot
veto its own return. Original return audit remains immutable; replay availability
is current. One extra owned HTTP case checks false-flag reporting/assignment.
Before this correction the exact five-suite run passed 53/53 in126.227 seconds,
and normalized unit380/34, lint/build passed. Corrected terminal rerun is pending.

### T4a terminal self-verification (not reviewed or integrated)

- Corrected normalized focused suite: 34 tests / three suites passed. Full
  `pnpm test --runInBand`: 381 tests / 34 suites passed, 23.758 seconds.
- `pnpm run lint` and `pnpm run build` passed with exit0.
- Exact required five-suite owned PostgreSQL command passed54/54, five suites,
  127.87 seconds: return9, assignment17, progress9, start8, integrity11.
  Real JWT/ownership/role/UUID/body guards, concurrent double return, actual
  return-versus-assignment lock wait, rollback after reservation/projection
  writes, immutable original timestamp, false-flag veto and preserved legacy
  ambiguous links were exercised. Suite owner-checked container/scratch cleanup
  assertions passed; no test process or owned fixture container remains.
- Terminal source was normalized before this corrected proof. This final ODD
  evidence-only appendix is normalized and checked afterward; production bytes
  remain unchanged. Scoped24-file Prettier and whitespace checks passed.
- Index remains exactly prepared tree5504317f61aff96931c89f31b12528033534b69a;
  all authored changes remain unstaged/untracked. Schema, migrations, policies
  and other dependency bytes match that tree. No candidate tree was staged.
- General scheduling-day policy, legacy wrapper activation, cancellation versus
  DRAFT claim coordination and T4b reconciliation remain pending. Other #6 E2E
  host assemblies were not executed by this required five-suite command; existing
  owned-route unit regressions passed. No broad acceptance or authority claimed.
- Final authored budget: 1349 additions + 77 deletions = 1426 changed lines, 24 files. A maintainer size:exception is
  required before formal freeze; no required tests were omitted or compressed.

T4a changed-file manifest (repository-relative, all allowed surfaces):

- `docs/route-depot-return.md`
- `docs/route-lifecycle-api.md`
- `odd/tasks/10-route-lifecycle.md`
- `src/modules/drivers/drivers.controller.spec.ts`
- `src/modules/drivers/drivers.controller.ts`
- `src/modules/drivers/drivers.module.ts`
- `src/modules/drivers/drivers.service.spec.ts`
- `src/modules/drivers/drivers.service.ts`
- `src/modules/routes/dto/driver-availability-response.dto.ts`
- `src/modules/routes/dto/route-return-response.dto.ts`
- `src/modules/routes/route-assignment.service.spec.ts`
- `src/modules/routes/route-assignment.service.ts`
- `src/modules/routes/route-availability.service.spec.ts`
- `src/modules/routes/route-availability.service.ts`
- `src/modules/routes/route-return.service.spec.ts`
- `src/modules/routes/route-return.service.ts`
- `src/modules/routes/routes.controller.spec.ts`
- `src/modules/routes/routes.controller.ts`
- `src/modules/routes/routes.module.ts`
- `test/route-assignment.e2e-spec.ts`
- `test/route-progress.e2e-spec.ts`
- `test/route-return.e2e-spec.ts`
- `test/route-return.fixtures.ts`
- `test/route-start.e2e-spec.ts`

## T5b isolated history and cancellation coordination scope

Dependency tree `b308e49cda0b9e00b7e8e98bb4172c3e7d333f11` is unreviewed.
Route: delegated direct; shared history projection, endpoint integration and
actual PostgreSQL claim/cancellation concurrency proof require multiple files.
Preserve existing ADMIN reads and JWT-owned DRIVER history; derive historical
orders from stable RouteStop association, not the mutable commercial pointer.
Add typed shared Swagger history, nullable legacy projection and deterministic
batched stops/attempts; commercial address/status/schedule remain current.
Cancellation locks fresh Order identity before validating claims/history, after
any Driver/Route locks. No schema, migration, scheduling or reprogramming changes.

- [x] T5b history projection and existing endpoint integration, unit RED/GREEN.
- [x] T5b actual PostgreSQL DRAFT/cancellation race RED/GREEN, both lock orders.
- [x] T5b full unit/lint/build and owned HTTP proven; terminal structural readback passed.

All consent, native review, commits and publication remain deferred. Forecast:
shared DTO/service and required JWT/legacy/concurrency proof likely exceed formal
400 lines; one cohesive slicing assessment must report exact overage, not cut tests.

### T5b observed proof and recovery (not closed)

- History unit RED: one assertion failed (legacy NULL lacked UNVERIFIED projection),
  one passed. Focused history/driver/routes GREEN:13 tests/three suites.
- Actual PostgreSQL DRAFT-first endpoint held its Order lock; pg_blocking_pids
  observed cancellation waiting. Before correction cancellation returned200 rather
  than409. The initial cancellation-first proxy failed receiver/getter forwarding,
  not production behavior; one initial hung invocation was terminated with owned
  cleanup. Corrected real two-lock-order proof passed2/2 after the identity lock.
- First combined history/race proof:five passed/two failed. Fixture expectations
  were wrong: nonexistent JWT users are401, and starting a route retains ASSIGNED
  commercial status. The corrected orphan fixture has a real user without driver.
- A subsequent fixture edit missed importing awaitHeld; launched HTTP promises
  outlived teardown and produced asynchronous ECONNREFUSED. No production change
  was made for this. Shared heldEndpointRace now drains all launched requests on
  failed barriers before cleanup; combined proof then passed7/7 without open handles.
- Terminal normalized production full unit command passed386 tests/35 suites,
  24.061seconds; lint and build passed with exit0. Exact required owned PostgreSQL
  history/race command passed8 tests/two suites,35.234seconds (history6/races2).
  The extra case proves DRIVER writes cannot spoof identity or mutate another
  driver's order, and actual owner progress still succeeds.
- Real AppModule provider assembly, JWT, Swagger components, immutable first failed
  attempt after future fixture association/pointer move, legacy NULL/tied sequence,
  date queries, empty/orphan results, ownership/roles/404, current commercial fields,
  private attempt-field exclusion and post-write rollback are proven. Future
  association SQL is fixture-only, not administrative rescheduling implementation.
- Both race orders use actual held transaction locks and pg_blocking_pids, not
  sleep-only timing. No CANCELLED order retains a live claim/assignment in GREEN.
- Terminal suites assert owner-label-checked container/scratch removal. No shared
  database was contacted. Dependencies were installed once with offline/frozen/
  ignore-scripts; package/lock, skills, schema and migrations match dependency tree.
- Existing #6 standalone E2E suites were not run and are not claimed PASS. Their
  fixture writes live Order.routeId after migration without stable RouteStop;
  that old fixture assumption needs a separately authorized history-aware update.
  New tests use actual production modules, not a weakened fake provider host.
- An optional test-only tsc command could not run because test/tsconfig.json does
  not exist; required production build and type-aware lint passed. This does not
  fabricate a test-typecheck result.
- All dependency trees remain unreviewed. No START, review, grant/decline, staging,
  commit, push, PR or integration closure occurred. Index remains exactly the
  parent-prepared dependency tree; this delta is unstaged/untracked.

### T5b one honest slicing assessment

Cancellation coordination is independently extractable as a behavior boundary:
Order lock, its unit proof, both HTTP lock races and the minimal shared host.
History must keep its projector, typed metadata, both existing read surfaces,
legacy/current-field security and owned persistence proof together. That history
boundary still exceeds400 authored lines, so no truthful cut makes every boundary
fit. Retain the complete evidence; formal freeze requires future size:exception.
No tests were omitted, compressed or separated merely to hit the line budget.

T5b terminal authored delta: 1253 additions + 112 deletions = 1365 changed lines, 19 files (including tests/docs, zero generated).
Independent verification, formal size acceptance, native consent/reviews and
work-unit commit remain pending; none is implied by these checked outcomes.

### T5b verifier-requested Swagger correction scope

Parent staged prior tree5231c39cbe88ab1e78598d2852aec84631f3b737 without native
freeze. Independent verification found a false RETURNED status enum and ADMIN
metadata that omitted retained route/driver/Order fields. RouteStatus has only
DRAFT/ASSIGNED/IN_PROGRESS/COMPLETED; depot return records an event while remaining
COMPLETED. Correct DTO metadata only, retain DRIVER restrictions and runtime
behavior, observe deterministic Swagger RED/GREEN, then repeat required checks.
No native review, staging or commit is authorized for this correction.

### T5b corrected Swagger terminal proof

- Initial metadata-host assembly lacked AuthModuleOptions; PassportModule setup
  corrected that test host without weakening production guards. This was not RED.
- Actual deterministic RED:two Swagger assertions failed, nine existing assertions
  passed. Published enum falsely included RETURNED and ADMIN list referenced the
  restricted schema. Corrected focused GREEN:11/11 controller tests.
- RouteStatus was verified against the current contract, and physical return only
  writes returnedAt/returnedById while remaining COMPLETED. RETURNED remains a
  valid event kind, not a lifecycle state.
- ADMIN metadata now extends shared history with all existing Route/Order scalar
  fields, nullable Driver including its full User, and full Zone fields. DRIVER
  remains restricted and declares its already-selected nullable audit fields.
  No service, response payload, guard, authorization or database bytes changed.
- Owned HTTP Swagger proof compares exact actual property sets for ADMIN route,
  Order, Driver, User and Zone, and DRIVER route/Order/Zone; it checks separate
  endpoint references and the exact lifecycle enum. Existing ADMIN User.password
  is documented as pre-existing, not newly exposed or granted to DRIVER.
- Corrected normalized terminal pnpm test --runInBand:388 tests/35 suites passed,
  23.517seconds. Lint/build passed. Exact required owned history/cancellation E2E:
  eight tests/two suites passed,34.142seconds. Both actual Order-lock races and
  owned container/scratch cleanup assertions still pass.
- Scoped formatting and whitespace checks passed evidence-only readback;
  parent-staged5231c39cbe88ab1e78598d2852aec84631f3b737 remains historical only.
  No native freeze, grant/decline, review, staging, commit or publication occurred.
- Correction delta against that staged tree:285 additions + 19 deletions = 304 changed lines, 6 files.
- Complete T5b delta against b308e49:1519 additions + 112 deletions = 1631 changed lines, 20 files. Existing history size
  exception requirement remains; this correction does not replace parent review.

### T4b isolated administrative legacy reconciliation (implemented/self-verified, UNREVIEWED)

- Worktree branch: `codex/10-t4b-legacy-reconciliation`; dependency tree
  `b308e49cda0b9e00b7e8e98bb4172c3e7d333f11` (all parent units UNREVIEWED).
- Route: delegated direct, triggered by transactional multi-file service/HTTP/tests.
- Scope: ADMIN reason/evidence-only reconciliation of status NULL routes; immutable
  audit, driver-then-route locks, matching legacy reservation release, persisted
  availability, equal replay without projection rewrite, no invented lifecycle.
- Acceptance: real JWT and fresh ADMIN check, unchanged associations/times,
  concurrency/replay/conflict, current role-independent historical audit authority,
  last legacy hold release, other reservations protected, driverless audit, rollback.
- Checks: deterministic RED/GREEN; unit/lint/build; owned PostgreSQL reconciliation
  and return E2E; scoped formatting/whitespace. No individual RDD consent/review,
  staging, commits, publication or integration. Role-at-insert DB guard stays a
  separate coherence dependency; append-only guards remain enabled.
- Forecast exceeds 400 authored lines with complete security/concurrency proof;
  keep audit and availability atomic, assess one cohesive slice before freeze.
- Dependency setup: offline frozen-lock install with ignore-scripts succeeded;
  no package/lock/skill writes or postinstall effects were authorized.

### T4b terminal self-verification (not reviewed, committed or integrated)

- Central historical-audit regression observed RED: 1 failed / 7 passed / 8 total
  when the audit actor changed to CLIENT; correction removed current-role
  revalidation, retaining valid metadata and actor FK. Focused GREEN: 31 tests / 3 suites.
- Normalized required terminal commands: `pnpm test --runInBand`: 395 tests / 35
  suites passed (23.683 seconds); `pnpm run lint` and `pnpm run build` exit 0.
- Exact owned PostgreSQL legacy+return command passed 20/20, two suites
  (legacy 11, return 9) in 62.47 seconds. Real JWT role/body/UUID checks, fresh
  service authorization, original audit replay/conflict, actual driver-lock
  waiting during simultaneous reconciliation, all historical timestamp and
  association snapshots, last legacy hold, verified reservation protection,
  driverless audit, and full post-write rollback were exercised. Append-only
  UPDATE/DELETE guards and typed Swagger were checked. Suite owner-checked
  container removal and scratch cleanup assertions passed.
- Initial PostgreSQL runs failed for a fixture incorrectly setting required
  route.date NULL (11/20), unordered result comparison (2/20), then omitted
  PrismaService.route in the existing-read host (1/20). These were test setup
  defects, not behavioral RED or production failures. Stable sorted JSON
  snapshots now explicitly compare Temporal timestamps, not empty object shape.
- Scoped 17-file Prettier and whitespace checks passed after normalization.
  This evidence-only appendix and documentation signposting are checked again
  afterward; terminal production/test bytes remain unchanged.
- Prepared dependency index is unchanged at tree b308e49...; package/lock,
  schema/migrations, skills and policies match dependency bytes. All authored
  changes remain unstaged/untracked. No candidate hash was invented; no native
  START/review/consent, receipt, commit, push, PR or integration was performed.
- Formal 400 cohesive slicing pass retains audit safety, central availability
  and the complete HTTP/security/race/rollback proof together. An explicit
  maintainer size:exception is required before formal freeze. Final delta is
  recorded after evidence append. No proof was compressed or omitted.
- Separate pending dependencies: role-at-insert database authority/coherence
  guard, general scheduling-day policy, legacy wrapper activation, cancellation
  versus DRAFT claims, integrated Newman/catalog acceptance and every parent
  unit's deferred native review. No catalog-wide business PASS is claimed.
- Existing assignment/start/progress hosts register the real new provider;
  additional owned PostgreSQL HTTP regression passed 34/34, three suites
  (assignment 17/start 8/progress 9), 88.011 seconds, with cleanup assertions.
- Final incremental budget: 1023 additions + 5 deletions = 1028 authored changed lines; 17 files, zero generated artifacts.

## T5 controlled isolated source preparation (UNREVIEWED)

- Branch `codex/10-t5-controlled-integration`, HEAD remains main 3b43bb7.
- Exact corrected T5b tree `4f6e539f13eef50dd491392844fde02cf5d3534e` plus
  T4b tree `8c6fcc137c4dde5c774e4065f5625684186f1a84` delta from common
  dependency `b308e49cda0b9e00b7e8e98bb4172c3e7d333f11`.
- Route: delegated direct; exact git-tree blob three-way merging, no live sibling
  source read or write. Additive conflicts retained both doc appendices and both
  DTO/provider imports. Corrected historical reads/Swagger/cancellation stay intact.
- Existing isolated HTTP hosts register real RouteHistoryService and reconciliation
  providers; the legacy read expectation follows the public UNVERIFIED projection.
- Original RED proofs above are preserved. This is source preparation without new
  behavior: no artificial integration RED, native review/consent, staging, commits,
  rebases, publication, or integration into the feature branch.
- Acceptance: combined normalized unit/lint/build; nine owned PostgreSQL suites
  covering legacy, history, cancellation, return, assignment, progress, start,
  integrity and migration; scoped formatting, whitespace and exact out-of-scope
  dependency preservation. Forecast: PostgreSQL proof may take 3–5 minutes and
  uses only new owner-labeled PostgreSQL16/random-loopback fixtures with cleanup.
- Formal 400 exceptions remain pending; preserve complete tests and audit/projection
  safety rather than compressing source to fit.

### T5 controlled combined self-verification (not reviewed or integrated)

- Offline/frozen/ignore-scripts dependency setup succeeded without package, lock
  or skill changes; no lifecycle scripts ran. All scoped source was normalized
  before terminal proof; no production/test changes occurred afterward.
- `pnpm test --runInBand`: 402 tests / 36 suites passed, 24.905 seconds.
  `pnpm run lint` and `pnpm run build` passed with exit 0.
- Exact requested nine-suite owned PostgreSQL command: 84/84, nine suites,
  214.453 seconds (legacy 11, history 6, cancellation 2, return 9, assignment 17,
  progress 9, start 8, integrity 11, migration 11). Real JWT/ownership and Swagger,
  legacy audit replay/actual lock waits, immutable history, both actual Order-lock
  cancellation races, rollback and migration/history guards passed together.
  Every suite's owner-checked container/scratch cleanup assertions passed.
- Scoped 17-file Prettier and whitespace checks passed; evidence-only doc append
  is normalized/read back again afterward. Only allowed delta paths changed;
  prepared T5b index remains byte-identical to tree 4f6e539... and HEAD 3b43bb7.
- Seven exclusive T4b implementation/proof/docs blobs match exact tree 8c6fcc...;
  corrected history/Swagger/cancellation source outside the manifest matches
  tree 4f6e539... exactly. Both original ODD/API proof appendices are preserved.
- Existing isolated HTTP hosts use real RouteHistoryService; the metadata-only
  controller host registers reconciliation as an inert mock, never weakening
  runtime HTTP guards. Legacy storage remains NULL while its public history
  projection is UNVERIFIED. No integration RED was invented.
- Source preparation remains UNREVIEWED and separate from feature-branch
  integration. No staging, native review/consent, receipt, commit, rebase, push
  or PR occurred. Size exceptions and all original parent reviews remain pending.
- Remaining proof outside this request: legacy #6 standalone host fixtures,
  Newman/catalog acceptance, and separate role-at-insert/DB coherence, scheduling
  and compatibility-wrapper dependencies. No omitted acceptance PASS is claimed.
- Increment versus corrected T5b tree 4f6e539: 1090 additions + 5 deletions = 1095 authored changed lines, 17 files.
- Combined versus common tree b308e49: 2609 additions + 117 deletions = 2726 authored changed lines, 32 files. Zero generated; formal size exceptions remain pending.

## T5c isolated legacy assignment compatibility scope

Prepared dependency tree f2a0c4219bc7c19973e718b91e2c37a19a285a3d is unreviewed.
Restore the existing ADMIN POST /api/v1/routes/assign through shared confirmation
and assignment primitives in one callback transaction, never separate nested
transactions. Derive date only from all selected orders' exact common non-null
scheduledDeliveryDate; mismatch/null remains409, not invented calendar semantics.
Driver-before-Route-before-sorted-Order locks protect eligibility and claims;
JWT ADMIN actor is forwarded server-side. No algorithm, rescheduling or migrations.
Route: delegated direct for shared transactional refactor and proof. Offline
frozen dependencies with ignored scripts succeeded; no package/lock changes.
Test-first wrapper RED/GREEN, full unit/lint/build, owned assignment PostgreSQL,
and isolated Newman on these bytes are required. All consent/review/commit and
publication remain deferred. Formal400 overage requires a cohesive slicing pass
and pending size:exception, never dropped tests.

### T5c observed self-verification (PARTIAL, unreviewed)

- Offline/frozen/ignore-scripts installation succeeded; no lifecycle scripts or
  tracked package/lock/skill changes. Own CodeGraph used before structural reads.
- Genuine owned HTTP wrapper RED: expected201, actual409; one failed /16 skipped.
- Shared transactional helpers GREEN: full403 tests /36 suites passed. Initial
  lint reported two numeric-sort warnings; explicit comparators removed both.
  Normalized terminal full403/36, clean lint and build passed.
- Initial assignment PostgreSQL24/24 passed in46.196 seconds. Terminal normalized
  assignment PostgreSQL24/24 passed in45.282 seconds, including actual two-waiter
  Driver and Order lock barriers, common/null/mismatched timestamps, real JWT/role/
  spoof guards, active return hold and rollback of confirmation+assignment together.
  Container/scratch owner-checked cleanup assertions passed.
- Required isolated Newman report ran once on feature bytes:72 requests,296
  assertions,14 failures (282 passed), exit1. Four-order legacy assignment succeeded.
  Collection/seed/fixtures were not weakened or mutated. This required failure
  keeps T5c partial; no catalog or integrated acceptance PASS is claimed.
- Exact affected collection is delivery-api.postman_collection.json. JSON pointer
  bases below append /event/0/script/exec/N (N is script-line index):
  1. /item/3/item/17 N3: HTTP403 correct; no-route message expected old Spanish
     text, actual "Order has no assigned route".
     2–3. /item/4/item/4 N0,N4: wrong-zone wrapper expected400/old zone message;
     actual409/shared eligibility message. Legacy request-validation400 is a
     legitimate compatibility-restoration candidate, not broad conflict weakening.
     4–5. /item/4/item/14 N0,N4: named unavailable-driver case expects400/disponible;
     actual409/"Order already reserved by another proposal". It also resends
     claimed orders; blanket409-to400 mapping would obscure a real claim conflict.
  2. /item/4/item/19 N3: crossed-driver HTTP403 correct; only old Spanish
     message differs from "Route belongs to another driver".
     7–8. /item/4/item/20 N0,N3: premature IN_TRANSIT expects403/old disabled text;
     actual409/"Verified route in progress required". Approved guard must remain.
     9–10. /item/4/item/21 N0,N3: premature DELIVERED has the same approved409
     versus obsolete403/message assertions.
     11–12. /item/4/item/28 N0,N3: active-claimed cancellation expects200/CANCELLED;
     actual409/error body. Approved claim protection must remain.
  3. /item/4/item/29 N3: HTTP400 correct; terminal-message assumption fails
     because previous cancellation was rejected and the order is still ASSIGNED.
  4. /item/4/item/30 N4: GET200 correct; expectedCANCELLED, actualASSIGNED,
     consistent with protected active claim. Parent owns precise catalog alignment.
- Newman ownership-checked cleanup reported no failure. A pre-existing foreign
  geolocation container created12:28 remained untouched; this writer's own
  command resources were cleaned. No pending writer command remains.
- One honest slicing pass retains shared primitives, wrapper guards and their
  real concurrency/rollback proof as the current cohesive unit. A future separate
  refactor intermediary would require its own exact proven tree, not cosmetic
  splitting or test omission. Formal400 overage requires pending size:exception.
- All dependencies remain UNREVIEWED. No staging, native consent/review/receipt,
  commit, publication or formal freeze. Date/day policy remains undetermined;
  exact persisted common-instant derivation does not establish calendar semantics.

- Final T5c budget: 501 additions + 170 deletions = 671 changed lines, 10 files.

### T5c approved regression alignment

- Parent authorizes narrow legacy wrong-zone400 and exact Newman assertion updates; active claims and premature execution remain409. Baseline72/296/14failed is the observed RED. No collection status alternatives or weakened security assertions.

- Alignment first terminal proof: full404/36, lint/build clean, ownedPG25/25; Newman72/296 had1 failure: missing zone expected404, actual400 because wrong-zone prevalidation preceded zone existence. Corrected explicit existence precedence, added PG regression; no assertion changed for missing-zone404.

- Final normalized alignment proof: `pnpm test --runInBand`404 tests/36 suites
  passed (24.179s); `pnpm run lint` and `pnpm run build` exit0.
- `env -u DATABASE_URL pnpm run test:e2e --runInBand --runTestsByPath test/route-assignment.e2e-spec.ts`
  passed26/26 (49.497s), including fresh owned PostgreSQL wrong-zone400,
  missing-zone404, actual Driver/Order contention, rollback and JWT ownership.
- `env -u DATABASE_URL pnpm run test:api:report` passed72 requests/296 assertions,
  zero failures. Alignment iterations: baseline14 failures; first alignment1
  missing-zone precedence regression; final0. No assertion removed, security
  status widened, fixture/seed weakened, or active-claim cancellation permitted.
- Exact changed collection item pointers: /item/3/item/17 (403 structured error),
  /item/4/item/4 (400 explicit zone mismatch), /item/4/item/14 (409 active claim),
  /item/4/item/19 (403 structured ownership error), /item/4/item/20 and21 (409
  verified in-progress required), /item/4/item/28 (409 protected cancellation),
  /item/4/item/29 (400 ADMIN non-cancellation restriction), /item/4/item/30
  (GET200 original ASSIGNED and stable commercial fields). Missing-zone404 stays.
- Both owned harness cleanup paths completed without errors; no writer command
  remains running. Dependencies remain UNREVIEWED; formal size:exception pending.
  No staging, review authority, receipts, commits or publication were created.

- Final T5c including alignment budget:734 additions +632 deletions =1366 lines,11 files; collection normalization is counted, not exempted.

## T1e additive PostgreSQL lifecycle-coherence guards (UNREVIEWED)

Isolated implementation branch: `codex/10-t1e-lifecycle-coherence`, based on
prepared dependency tree `3b43bb7a9fa72a06aaf576073ecf31c38a4d7287` with the
T1a/b/c/d, T2, T3, T4a/b, and T5a/b/c source present. The inherited candidate
index is `071e6cd15ec54aea4169bc34175743da7a2fd543`; prior T1a/T5a sibling
candidates and their bytes remain untouched. Route: delegated direct because the
new SQL migration, contract emission, migration recovery, and PostgreSQL proofs
span multiple non-trivial artifacts and require reading before writing.

Scope: additive PostgreSQL guards only; no application-service changes. The
deferred database checks must preserve these approved invariants:

- Verified ASSIGNED/IN_PROGRESS route visits have exactly matching stable active
  order claims; DRAFT has none and does not write the Order.routeId pointer;
  COMPLETED has no active claims. Claim history and times remain immutable except
  release on a valid completion or legitimate pre-start DRAFT stop removal.
- Verified assigned/in-progress routes, and COMPLETED routes not yet returned,
  retain one matching active driver reservation by both route and driver. DRAFT
  reserves no driver; valid return releases the matching hold. A NULL legacy route
  without a reservation remains unverified rather than receiving an invented hold.
- Delivery attempts match an immutable stable stop outcome, current route owner,
  and valid audit time; failure-reason pairing and failed-visit administrative
  review are database-enforced. A failed visit never invents DELIVERED/CANCELLED.
  Later commercial order updates for a future #12 visit are not frozen to an old
  attempt's status.
- At most one legacy reconciliation audit exists per route. Only a transactionally
  row-locked current ADMIN may insert; later role demotion never invalidates the
  historical audit. A legacy driver hold may be released only with that route's
  audit, without disturbing other reservations.
- Existing dirty/NULL legacy history is preserved. Duplicate audit/route-hold
  conflicts fail closed before migration DDL; no automated repair or deletion is
  permitted. Historical migration/snapshot directories and sibling worktrees stay
  unchanged.

Stable task IDs and acceptance:

- [ ] T1E-1: add only an additive native Prisma planner/self-emitted migration,
      current contract artifacts, and one new snapshot pair; prove complete hashes.
- [ ] T1E-2: observe real PostgreSQL RED for bad claim, reservation, attempt,
      audit-role and direct history rewrites; then GREEN for rejected cases and
      valid deferred full-transaction assignment/completion/return.
- [ ] T1E-3: retain populated and ambiguous legacy bytes, duplicate-audit and
      duplicate-route-reservation rollback, legacy audit authority after demotion,
      and real lock-barrier evidence for concurrent new authority.
- [ ] T1E-4: run required full unit/lint/build, the exact nine owned PostgreSQL
      suites, and Newman; normalize before final functional proof, report exact
      authored/generated line counts and honest slicing result.

All PostgreSQL testing must use newly owned PostgreSQL 16 containers on random
loopback ports, with ownership-checked cleanup. `DATABASE_URL` is unset for test
commands. No shared database, persistent migration, native review/START/consent,
receipt, commit, push, PR, or destructive operation is authorized. Every
individual native consent remains deferred; terminal candidate is UNREVIEWED.

Parent has authorized exact extra compatibility surfaces:
`test/route-lifecycle-migration.e2e-spec.ts`, `test/route-start.e2e-spec.ts`,
`test/route-lifecycle-integrity.e2e-spec.ts`, and `test/route-history.e2e-spec.ts`.
Retain migration schema, ambiguous-history, idempotency, race, and history proofs.
The migration suite's old T1b intentionally writes an incoherent FAILED attempt to
a DRAFT route after all migrations; retain that proof at the pre-coherence boundary
or adapt its setup to a coherent row, then separately assert T1e rejects the bad
case. The same-driver/two-ASSIGNED route fixture is impossible with one active
reservation per route and driver; explicitly prove T1e rejects the second hold or
assignment rather than weakening the original start-race assertion. Lifecycle
integrity seeds must construct coherent routes transactionally; retain the old
no-reservation uniqueness race at the pre-coherence boundary if needed. In route
history, preserve the old failed attempt and historical projection while creating
a DRAFT stable future stop without moving the order pointer; move the pointer only
with a valid ASSIGNED new-driver hold. No application-service change is in scope.

Current status: parent approved the four exact compatibility spec extensions above.
Planning and source/fixture inspection are complete; source and test proof are not
yet changed. Native consent/review, delivery, and size acceptance remain pending.
