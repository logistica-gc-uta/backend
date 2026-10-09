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
- [ ] T1 (in progress): Fix authenticated ownership and central lifecycle enforcement, test-first unit tests and API contract documentation. Verify focused tests, lint/build; review this work-unit candidate and commit locally.
- [ ] T2 (pending): Add isolated PostgreSQL/JWT negative integration tests and final documentation/PR proposal from the repository template. Verify pnpm lint/build/test/test:e2e; review candidate and commit locally. Do not reset existing data.

## Acceptance and checks
Cross-driver read/write rejection; own-client reads and foreign-client denial; ADMIN permission restrictions; invalid/missing JWT; terminal and invalid transitions; database unchanged after rejected requests. PostgreSQL integration and required scripts must have observed results, not inferred passes. Full #8 acceptance remains partial: route IN_PROGRESS depends on #10; CI, published/reviewed/integrated PR are not available locally.

## Progress and evidence
Exploration found unauthenticated ownership in findOne and unrestricted updateStatus mutations. RDD on (global). Explorer reports healthy local PostgreSQL and initial tests/lint; independent execution evidence still required.

## Next step
T1 bounded implementation with observed RED/GREEN. Commits and review outcomes pending.
