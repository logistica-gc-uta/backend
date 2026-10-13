# Issue 13 verification

Backend acceptance covers Socket.IO transport and the existing REST/transaction rules, not an executed React/Flutter application or Cloudflare deployment. Specification: `odd/tasks/13-realtime-sync.md`; baseline `232126c3588f8b2606d0e0d70088c6ea5a37157d`.

## Acceptance matrix

| Criterion | Public proof | Current status |
|---|---|---|
| CP-SEG-002: successful persisted delivery | Real owned PostgreSQL + Socket.IO CLIENT/DRIVER/ADMIN; HTTP transition then authorized GET and exactly one versioned hint | PASS: focused and complete PostgreSQL regression |
| CP-SEG-006: disconnect/reconnect | Disconnect, persist transitions, new authenticated connection/subscription, GET reads latest state without replay | Focused scenario passed |
| CP-SEG-007: isolation | Missing/invalid JWT, forged role claim, foreign order/route/driver, malformed UUID, disallowed WebSocket Origin; no private packets | Focused scenario passed |
| Commit/rollback invariant | Actual PostgreSQL transaction rejects after callback, HTTP500, unchanged authorized GET/audit and no packets; invalid transition400 likewise | Corrected focused scenario passed |
| Failure/CONTACT/RESCHEDULE | ADMIN inbox proves persisted failed attempt; ADMIN-only incident hints; owner sees no private management details; same order is rescheduled | Real PostgreSQL/Socket.IO7/7 final PASS |
| Return-only driver availability | Route completion publishes no availability; confirmed return publishes actual availability to ADMIN/self, replay none | Focused scenario passed |
| Revoked/stale membership | Reassign driver or change current DB role; old socket receives no restricted hint | Focused scenario passed |
| Version/rooms/payload | v1 envelope, UUID/time, authorized resource subscriptions, allow-listed wire keys, no fixture credentials/contact/conversation | Real PostgreSQL/Socket.IO7/7 final PASS |

## Observed checks

- Unit regression: **49 suites, 662/662 tests PASS**, exit 0. Global coverage thresholds >=80% enforced: statements 91.46%, branches 84.07%, functions 89.75%, lines 93.13%.
- Newman: **104 requests, 434 assertions PASS**, exit0 with owned cleanup; includes build.
- TypeScript/lint/build: exit0 in the controlled candidate; one pre-existing unused `status` parameter warning.
- Gateway/publisher parent spot check: 13/13 PASS. Postcommit spot check: 12/12 PASS. Existing assignment/progress canaries: 48/48 reported PASS by writer, included in the full passing unit regression.
- Complete PostgreSQL regression: **351/351 tests, 21 suites PASS**, exit 0; owned cleanup confirmed.
- Final affected Socket.IO suite after adopting the two independent probes: **9/9 PASS**, exit 0, real owned PostgreSQL + HTTP/socket client. The original seven cases remain; canonical inventory remains 21 suites. This later focused run is separate from the earlier complete regression, not a claimed 353-test complete rerun.
- Independent high-risk verification: **functional PASS** after one dependency-copy correction, with **7/7 real PostgreSQL/Socket.IO, 25/25 focused units, 2/2 independent public probes and TypeScript exit 0**. No source blocker or timeout was found. The initial PARTIAL and failed startup logs are retained. Route configured as GPT-6 Luna/max; runtime effort was not exposed. Local work-unit commits are separate from functional proof and confer no delivery approval. Native assessment was unavailable due the local untracked store inventory limit, so the high-risk verifier plan applies. RDD remained off, unchanged; no native approval is asserted.

## Evidence and recovery history

Current logs and source/config checksum manifest: `reports/issue13-recovery/`. Independent runtime logs: `.issue13-independent-v7q7eeuz/reports/issue13-independent/*-recheck.{stdout,stderr,exit}`; original startup failures are archived in `reports/issue13-recovery/independent-first-attempt/`. The independently approved checksum manifest is retained separately from the final manifest whose only source change is the adopted E2E test. The source snapshot `.issue13-verification` contains all current project tests, not prior temporary copies. Independent frozen-lock dependencies/local store, scripts disabled. The pnpm reconciliation/lifecycle race observed during Issue 12 is avoided by a fail-closed temporary PATH shim executing the exact locked local commands; no test filters, thresholds or genuine migration/verification checks were removed.

Earlier logs retain the root copied-test OOM exit134, owned PostgreSQL readiness timeout, fixture JWT without expiration, unstable invalid-signature mutation, wrong 409-vs400 expectation, incorrect CLIENT admin-review projection and CONTACT missing attemptId/privacy-regex false positive. Corrections only changed test fixtures/assertions to the existing public contract; runtime guards were not relaxed. Fresh authorized owned PostgreSQL readiness later passed with the unchanged 30-second limit and cleanup; the original transient timeout cause is not claimed proven.

## Git and review state

- One branch: `feat/13-realtime-sync`, directly based on updated main `232126c3588f8b2606d0e0d70088c6ea5a37157d`; coherent local work units are recorded in `odd/tasks/13-realtime-sync.md`.
- No push, PR, merge or Issue 13 closure was performed. Remote CI was not run because no publication is authorized.
- RDD remained **off**, unchanged. Native assessment was unassessable due the bounded local untracked inventory; the high-equivalent independent-verifier plan was followed. No native receipt/approval is invented, and functional PASS is not human review.
- Source and approved/final checksum manifests bind the verification; the final production code is byte-identical to the independently verified code. Only the two durable E2E probes were added afterward and their affected suite passed.

## Limitations and risks

- React/Flutter examples are contracts, not executed frontend integration; the issue's React-without-refresh acceptance is not falsely checked as a UI result.
- Cloudflare Tunnel is documented, not deployed/smoke-tested. GPS, ETA and guaranteed mobile/offline delivery are out of scope.
- Socket hints are nondurable/at-most-once, with no ordering/replay guarantee. Authenticated REST GET after every reconnect is authoritative.
- Current implementation is single-process; horizontal multi-instance distribution requires a separately authorized adapter/delivery design.
- JWT_SECRET must be explicitly set for socket authentication. Existing REST fallback behavior was not refactored. Browser origins are explicitly allow-listed; native originless connections still require JWT.
- Security/current role/resource ownership and concurrency/shared transaction helpers are high-risk surfaces; independent functional proof passed, but it is not human review, native approval or remote delivery permission.
- Pre-existing ADMIN route DTO password-projection advisory remains outside the new socket projection; no such data is emitted by the gateway.
- No shared database, other worktree, remote publication or RDD setting was modified. Prior human `.gitignore`, Issue12 local ledger and Issue11 draft remain outside Issue13 commits.
