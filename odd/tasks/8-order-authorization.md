# Order ownership and lifecycle security (#8)

## Objective and scope
Fix order IDOR/BOLA using authenticated JWT identity and centralize order transitions. Base: clean origin/main 1982a3d. Branch: fix/8-order-authorization. No push, PR creation or merge. No unrelated issue changes or destructive database resets.

## Accepted security contract
- CLIENT reads only owned orders; DRIVER resolves User -> Driver -> Route -> Order; ADMIN reads globally.
- ADMIN can cancel nonterminal orders; assignment remains exclusively in the administrative route-assignment endpoint.
- DRIVER writes fail closed until #10 supplies verifiable Route.IN_PROGRESS. User explicitly confirmed this restriction.
- Central lifecycle: PENDING -> ASSIGNED/CANCELLED; ASSIGNED -> IN_TRANSIT/CANCELLED; IN_TRANSIT -> DELIVERED/CANCELLED; terminal states have no outgoing edges.
- No simulated route-start checks, schema changes or Issue #10 implementation. No successful events or PostgreSQL changes for denials.
- Preserve contracts except insecure permissions. Handle stale/concurrent mutations where applicable.

## Tasks
- [x] T1 (complete, commit 650e261): Fix authenticated ownership and central lifecycle enforcement, test-first unit tests and API contract documentation. Verify focused tests, lint/build; review this work-unit candidate and commit locally.
- [ ] T2 (in progress): Add isolated PostgreSQL/JWT negative integration tests and final documentation/PR proposal from the repository template. Verify pnpm lint/build/test/test:e2e; review candidate and commit locally. Do not reset existing data.

## Acceptance and checks
Cross-driver read/write rejection; own-client reads and foreign-client denial; ADMIN permission restrictions; invalid/missing JWT; terminal and invalid transitions; database unchanged after rejected requests. PostgreSQL integration and required scripts must have observed results, not inferred passes. Full #8 acceptance remains partial: route IN_PROGRESS depends on #10; CI, published/reviewed/integrated PR are not available locally.

## Progress and evidence
Exploration found unauthenticated ownership in findOne and unrestricted updateStatus mutations. RDD on (global). Explorer reports healthy local PostgreSQL and initial tests/lint; independent execution evidence still required.

## Next step
T1 commit 650e261 implemented with observed behavioral RED (12 service failures and controller identity forwarding failure) and GREEN (138 tests/19 suites, lint/build). Parent spot check: 27 service tests passed. Four native lenses approved review-8b211f52797540ff; exact acknowledgement completed, authority consumed. Subsequent ASSESS was unassessable due to untracked declaration and mandates independent verification; independent verifier passed lint/build and all 138 tests (19 suites), with no severe candidate defects. T1 closed. T2 added PostgreSQL integration (28 E2E cases passed) and docs; parent found transition validation before authorization leaks foreign order status and inaccurate PR acceptance checkbox. T2 includes a bounded correction: authorize before graph validation, negative cross-driver terminal tests, honest partial acceptance documentation. T1 commit remains valid foundation; final security outcome waits for this correction. Native review of the progress-only document also approved and acknowledged.
