# Issue 12 — Verification and acceptance traceability

Scope: backend urgent dispatch and manual ADMIN intervention, branch `feat/12-urgent-dispatch`, baseline `c740ad4503167996020c2ae314c7e0fb03a3bed6`.
Sources: Issue #12/adenda (2026-10-09), integrated #7/#9/#10/#11 contracts, and the user's CP-RUT/CP-SEG criteria from Catalog v2.0/SRS v2.0. Google Drive was explicitly withdrawn as an accessible source. Related identifiers: RF-EXP-05/09, RF-DEC-07/12/14, RF-TEC-04/05; no external definition or approval is inferred.

## Final local verification — PASS; E commit and PR authorized

A bounded read-only incident map and logs confirmed that pnpm automatic installation/lifecycle ran concurrently with Jest. Previously missing modules were present afterward. Temporary isolated PATH tooling now executes the exact locked local Prisma/tsx/nest/Newman/Jest command bodies with unchanged arguments; install and unknown requests fail closed. No application, parent dependency or lockfile change is required. See `reports/issue12-E-recovery/isolated-execution.md`.

Controlled results (all exit 0): TypeScript/lint/build; 46 unit suites/637 tests; four global coverage gates >=80% (91.43% statements, 83.32% branches, 88.85% functions, 92.79% lines); complete 20-suite PostgreSQL E2E/344 tests (285 managed +1+35+23), owned cleanup confirmed; focused suite 20/1 test; Newman/104 requests/434 assertions. Only the pre-existing unused `status` parameter lint warning remains.

Logs: `reports/issue12-E-recovery/{typescript,lint,coverage,suite20,e2e,newman}-controlled.log`; build is included in the successful Newman run, earlier isolated `build.log` also exited 0. Parent dependency/package/lock integrity: 98,680 entries, zero changed, A–D HEAD/branch preserved. Independent narrow execution-boundary check PASS: fresh stub harness, 10 assertions covering six dispatches and four forbidden/unknown forms; arguments/environment/stdout/stderr/exit preserved. Its overall pending note referred only to the full E2E run, which the parent subsequently observed exiting 0 with the exact 20-suite log. Original independent feature S1–S15 PASS remains valid. Final post-gates integrity comparison also reports 98,680 protected entries, zero changed, HEAD `a0531f40d666e165aea4f5bef5831ee0d42979ad`, branch `feat/12-urgent-dispatch`. No E commit or native RDD approval is claimed.

The user explicitly instructed `No hagas commit E, push, PR ni merge.` That restriction was superseded by the later `si continua hasta llegar hacer el PR` and exact target/session/label grants (ledger L17). Functional verification is complete; commit E and one main PR are authorized, not merge or issue closure. Temporary isolated dependencies/shim and probe are retained, not delivery files. No source/package/lock or parent dependency repair was used to force a green result. Pre-existing ADMIN route password DTO advisory remains outside this issue.

## Earlier recovery blocker (historical)

Authorized recovery archived and removed only the two verified owned scratch trees. Fresh frozen-lock dependencies were installed with scripts disabled in `.issue12-e-isolated`, with its own store/copies. `import-local` resolves inside that tree. Parent TypeScript and isolated TypeScript/lint/build exited 0; no test exclusions or suppression were added. Newman exited 0: 104 requests, 434 assertions.

New real blocker: coverage exited 1 before any tests (`Cannot find module 'jest-regex-util'`); suite 20 also exited 1 before its test (`Cannot find module '../constants'` from ts-jest). Installed Jest/ts-jest dependency materialization is incomplete/unreachable despite frozen-lock install exit 0; no application assertion failed because these tests never launched. Full E2E was stopped on the first blocker, not reported PASS. No further install/retry occurred.

Parent integrity verification compared 98,680 dependency/package/lock entries with zero changes. A–D/RDD preserved; E not committed. Recovery evidence and exact logs are in `reports/issue12-E-recovery/`. The next decision is whether to authorize a bounded investigation/correction of the isolated package-manager materialization before rerunning pending gates.

## Earlier blocked attempt (historical)

Earlier functional gates below passed. Independent verifier reported functional PASS S1–S15 and one public PostgreSQL probe PASS. Its process blocker remains unresolved: pnpm ran install/up-to-date reconciliation and lifecycle scripts against symlinked parent dependencies; no tracked dependency/source/migration update was observed, but ignored-file side effects cannot be ruled out.

One bounded correction copied dependencies without symlinks; direct Jest exited 1 before tests: `Cannot find module 'import-local'`. No DB/migration/probe ran; no retry was made. Parent adopted the original probe as `test/dispatch-agreement-prestart.e2e-spec.ts` and updated CI inventory to 20. That parent regression has not run. The subsequent root TypeScript check exited 2 with Supertest errors across retained in-project scratch copies and original tests; current clean compilation is unproven. The 19-suite/343-test run below is historical, not a claimed final 20-suite result.

**Needs your decision:** safe cleanup/isolation of owned scratch copies and verification-tooling recovery without resetting parent dependencies or discarding work. No further verification, E commit, dependency install/reset or remote operation was performed after exhausted proof. A–D commits and all evidence remain preserved.

Unchanged baseline privacy advisory: `routes.service.ts:39-41` includes driver user data and `route-history-response.dto.ts:120-139` exposes `password` in the ADMIN route DTO. Outside the new dispatch response; not changed in this issue.

## Acceptance matrix

| Criterion | Behavior and public proof | Own functional result |
| --- | --- | --- |
| CP-RUT-003 | Fourth stop inserted into ASSIGNED before start; recalculated sequence, unchanged existing stop identity and driver reservation. PostgreSQL/JWT urgent-dispatch suite. | PASS |
| CP-RUT-004 | Full/frozen routes excluded; NEW_ROUTE uses effectively available driver and locked revalidation, never started-route edits. Proposal units and PostgreSQL/JWT suite. | PASS |
| CP-RUT-005 | Exact pre-start REORDER, compatible MOVE and ASSIGNED driver switch; invalid date/zone/claim/capacity and started routes rejected with rollback. | PASS |
| CP-RUT-006 | Concurrent confirmations for last slot and shared order/driver; one winner, no duplicate active claims/reservations or fifth stop. | PASS |
| CP-RUT-008 | IN_PROGRESS/COMPLETED structure frozen through HTTP and direct SQL; start/reorder serialized. | PASS |
| CP-RUT-009 | BLOCKED cause with unchanged PENDING and no route/claim/reservation/audit from GET; no available driver is explicit. | PASS |
| CP-RUT-010 | Persistent ADMIN actor from JWT/current DB role, instant, reason, action, outcome and resource/result identifiers; exact replay and conflicting body/actor tests. | PASS |
| CP-SEG-004 | Absence and refusal retain failed attempt and review hold; CONTACT without agreement cannot schedule. No automatic commercial-status conversion. HTTP and installed SQL guards. | PASS |
| CP-SEG-008 | Persisted agreement consumed once; completed R1 claim release required; same commercial order on R2, exact original R1 stops/attempts/events; driver reuse waits for depot return. | PASS |

Implementation contract and limitations: [urgent-dispatch.md](urgent-dispatch.md). Principal tests: `test/urgent-dispatch.e2e-spec.ts`, `test/route-history.e2e-spec.ts`, `src/modules/routes/route-urgency.service.spec.ts`, `src/modules/routes/dispatch-intervention.service.spec.ts`.

## Observed checks

| Command / proof | Observed outcome | Complete local log |
| --- | --- | --- |
| `pnpm lint` | Exit 0; pre-existing unused `status` parameter warning in `route-start.e2e-spec.ts`. | `/tmp/issue12-E-lint.log` |
| `pnpm build` | Exit 0. No frontend/UI changes; browser verification N/A. | `/tmp/issue12-E-build.log` |
| `pnpm exec tsc --noEmit --pretty false` | Earlier exit 0; latest direct root check exit 2 after scratch copies. Current clean PASS unproven. | `/tmp/issue12-E-tsc.log` |
| `pnpm test:cov --runInBand --coverageThreshold='{"global":{"statements":80,"branches":80,"functions":80,"lines":80}}'` | Exit 0, 46 suites / 637 tests. Statements 91.43%, branches 83.32%, functions 88.85%, lines 92.79%. | `/tmp/issue12-E-final-unit-coverage.log` |
| Focused urgent dispatch PostgreSQL/JWT | Exit 0, 21/21. Real contention, rollback, SQL guards and historical retry. | `/tmp/issue12-D-postgres3.log` |
| Corrected historical retry fixture | Exit 0, 6/6. Real completion, CONTACT, RESCHEDULE and R2 assignment. | `/tmp/issue12-E-history-correction.log` |
| `env -u DATABASE_URL pnpm test:api:isolated` | Exit 0, 104 requests / 434 assertions, no failures; owned container cleanup verified. | `/tmp/issue12-E-newman.log` |
| `env -u DATABASE_URL pnpm test:e2e:isolated` final entire 19-suite manifest | Exit 0; 343/343 tests across all 19 suites (284 managed +1+35+23), owned PostgreSQL cleanup confirmed. | `/tmp/issue12-E-final-e2e.log` |
| Independent feature verifier, all S1–S15 | Functional PASS, public probe 1/1 exit 0; process blocker unresolved, isolated corrective launch exit 1 before Jest. | Retained scratch probes; no native approval. |

### Failures retained in the evidence

- Same-storage-hash SQL-only C migration was skipped by default target resolution: 20/21 D tests passed, direct SQL unaudited reset unexpectedly succeeded. A genuine forward CHECK/schema edge installs the guards; final D 21/21 passed. Committed old migrations/hashes were not rewritten.
- Initial E unit run: 576/577 passed; old CI suite count expected 18, actual 19. Coverage was below required 80%. Updated inventory and added 60 public-service dispatch cases; final 637/637 and all four coverage gates passed without exclusions or weaker thresholds.
- Initial full E managed run: 283/284 passed. Old history fixture directly moved a failed order without agreement. It now uses public completion/contact/rescheduling/assignment rather than disabling guards; focused history 6/6 passed. Final full 19-suite manifest then exited 0, with owned PostgreSQL cleanup confirmed.
- Unit adapter initially had a syntax error, then 59/60 passed: mutable backing rows incorrectly changed an earlier query snapshot during reassignment. Separate query-result snapshots corrected the adapter; focused 78/78 dispatch/runner/CI cases passed. No production rule was relaxed.

## Migration, risk and delivery

Forward contract: `eb8ebd14b89f17eea5458cd12220be7bd572fa8f0e3771b68d2089c880e18f83`. Apply official migrations to the latest target and verify the actual DB contract. The earlier same-hash migration remains recorded, but is not sufficient deployment proof. Forward prechecks fail closed on inconsistent historical failure holds without matching audited resolution; assess such data before deployment, never manufacture agreement evidence.

Risk items: **1** (persistent state/guards), **2** (authorization/audit), **4** (transactions/concurrency), **5** (isolated runner schema target). New constraints and shared assignment helpers require existing endpoint regressions as well as new-case tests. No ambient/production DB, other registered worktree, old migration or pre-existing `docs/pr/issue-11.md` was intentionally altered. Earlier ignored dependency/lifecycle effects are unproven as detailed above.

RDD switch is pre-existing `off` from `clone_local`; this work did not disable it. Technical independent verification is not native review or delivery authority. No push, PR, merge, issue closure, protected label or remote write was authorized/performed. Hosted CI, human review and delivery gates remain unverified until a separately authorized PR.

One final PR toward `main` is intended. User-selected size exception rationale: cohesive A→E implementation with inseparable official migration/snapshot/contract artifacts and actual security/history/contention regressions; generated snapshots must not be omitted to fit a line heuristic. Reviewer focus: authored services/policies first, custom SQL/prechecks second, generated mirrors for consistency last. No label or RDD approval is inferred from this rationale.
