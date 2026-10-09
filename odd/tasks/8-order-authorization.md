# Order ownership and lifecycle security (#8)

## Objective
Prevent order IDOR/BOLA using authenticated JWT identity and centralize lifecycle transitions. Base: clean, updated origin/main 1982a3d. Branch: fix/8-order-authorization. No push, published PR or merge. No schema changes, unrelated issues or database resets.

## Accepted security contract
- CLIENT reads only owned orders; DRIVER resolves User -> Driver -> Route -> Order; ADMIN reads globally.
- ADMIN may cancel nonterminal orders. Assignment remains exclusively in the administrative route endpoint.
- DRIVER state writes fail closed until #10 supplies verifiable Route.IN_PROGRESS; explicitly confirmed by the user.
- Graph: PENDING -> ASSIGNED/CANCELLED; ASSIGNED -> IN_TRANSIT/CANCELLED; IN_TRANSIT -> DELIVERED/CANCELLED. DELIVERED and CANCELLED are terminal.
- Authorize before validating transitions to avoid exposing foreign order state through error messages.
- Conditional status writes detect stale updates. Rejected requests do not mutate PostgreSQL.

## Tasks and commits
- [x] T1: Authenticated ownership, centralized lifecycle, unit regression tests and Swagger contracts. Commit 650e261: fix(orders): enforce ownership and order lifecycle permissions.
- [x] T2: Isolated PostgreSQL/JWT integration tests, authorization-before-graph correction, security documentation and unpublished PR proposal. Commit b74670d: fix(orders): authorize before state validation and verify PostgreSQL isolation.

- [ ] T3 (in progress): Align Newman with fail-closed DRIVER, DTO 400, crossed ownership and persisted-state negative checks; provide owned ephemeral PostgreSQL/backend runner with safe cleanup and no shared resets. Observe RED/GREEN, verify isolation and API results, review work-unit and commit locally.
- [ ] T4 (pending): Add PostgreSQL security E2E to CI while retaining lint/build/coverage/Newman, update security and Refs #8 PR documentation, verify local CI-equivalent commands and review/commit.

## Evidence
- T3 preliminary RED: old collection 46 requests/185 assertions produced 5 expected failures; GREEN: expanded collection 59 requests/242 assertions passed in owned ephemeral PostgreSQL, lint/build and 145 unit tests passed. Parent requested further runner hardening before task closure: remove bypass flags, reject target/environment overrides, test actual process cleanup and failure/signals. Development-container uptime alone is not database-integrity proof. Final T3 review/checks pending.
- T1 behavioral RED: 12 service assertions failed on insecure ownership/mutations; controller identity forwarding assertion failed. GREEN: 138 unit tests across 19 suites, lint and build passed. Independent execution confirmed those results.
- T2 correction RED: 3 authorization-precedence assertions failed with BadRequestException instead of ForbiddenException. GREEN: all 30 order-service assertions passed (also repeated as a focused spot check).
- Final independent checks: pnpm lint (exit 0, zero errors/warnings); pnpm build (exit 0); pnpm test --runInBand (exit 0, 141 tests/19 suites); pnpm test:e2e --runInBand (exit 0, 31 tests/2 suites, including 30 order-security tests against real PostgreSQL).
- JWT/production guards exercised for two drivers, clients, ADMIN, missing/invalid JWT and nonexistent JWT subject. Denied mutations compare unchanged database snapshots; cleanup targets only fixture-created IDs.
- Both executable work units passed native four-lens review and exact acknowledgement. Subsequent native risk assessments were unavailable due to untracked declarations; independent verification was run and passed for both units. No remaining failing required local check.

## Acceptance status and limitations
Completed locally: cross-owner access restrictions, restricted ADMIN operations, central transition graph, terminal-state rejection, PostgreSQL invariance for denials, unit/integration negative tests and API documentation.
Pending: #10 Route.IN_PROGRESS verification and operational DRIVER writes, remote CI, human PR review and integration. The full issue remains partially accepted and must not be automatically closed.
Remaining risks: DRIVER delivery workflow intentionally unavailable until #10; assignment concurrency outside the changed order-status endpoint is not comprehensively stress-tested; existence remains distinguishable through 403/404; large test/documentation diff increases human review load. No successful-event emitter exists in the affected order-status path.

## Delivery artifacts and next step
- docs/order-security.md: role matrix, transitions and HTTP contract.
- docs/pr/issue-8.md: repository-template PR proposal using Refs #8, with incomplete acceptance checkbox retained.
- Continuation authorized: fix Newman/CI integration blockers on the current branch. Keep all authorization checks, execute DRIVER progression requests as negative 403 tests (do not skip), document positive delivery scenarios pending #10. Invalid enum DTO remains 400. Never modify development PostgreSQL; seed/initialize only a demonstrably owned ephemeral instance, cleanup only owned resources. No push, PR publication, merge or issue closure.
- Next: T3 bounded Newman isolation and security-contract implementation, then T4 CI and documentation. Use this same task document and mirror; no parallel plan.
