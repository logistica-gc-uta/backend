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

## Evidence
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
- Next: human review of local commits and PR proposal; await authorization before any remote publication. Final tracking-only changes require structural readback, not functional reruns.
