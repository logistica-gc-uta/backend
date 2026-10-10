## Descripción

Persist optional confirmed geographic pairs for orders and zone depots, retaining historical rows and exposing explicit geographic readiness for future Issue #7. This is an unpublished proposal for one final `feat/9-geolocation-persistence` → `main` PR, not proof of publication or merge readiness.

## Issue relacionado

Refs #9. Closure remains pending required checks, candidate-specific review consent and external reviews.

## Cambios realizados

- Nullable geographic contract, additive Prisma 8 migration, matching snapshots and paired/ranged PostgreSQL CHECKs; no fabricated backfill.
- CLIENT order creation and ADMIN zone create/update validate finite complete pairs; authorized reads expose `{ lat, lng }` and readiness reasons without hiding historical NULL rows.
- DEMO/TEST fresh-insert depot seed, isolated Newman assertions and frontend/migration recovery documentation.
- Separate pre-migration clean/populated backup rollback proofs, cached-only PostgreSQL fixture startup and narrowly scoped ShellCheck trap-callback directives.

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | Local PASS | T3 direct Oxlint type-aware src/test exit 0; Bash syntax and diff-check exit 0 |
| Pruebas unitarias | Local PASS | T3 202 tests / 23 suites; coverage statements 98.32%, branches 90.11%, functions 93.33%, lines 98.36% (80% thresholds) |
| Pruebas de integración | Local PASS, separate executions | T2 owned PostgreSQL: 10 migration/recovery + 1 application + 35 security tests; direct Prisma 8 migrate/verify exit 0 and raw marker at `00d34ab56ae55b663a53148a126d233c0801ea6863ee0e3b22273a20d77d862e` |
| Compilación | Local PASS | T3 direct Nest build exit 0 |
| Pruebas funcionales | Local PASS | T3 isolated Newman: 64 requests / 268 assertions, zero failures; runner migrate/verify exit 0, stable seed identity/coordinates across two runs |

Fresh T5 checks (separate from historical T2/T3 evidence): direct Nest build and type-aware Oxlint passed; full coverage passed 202 tests / 23 suites with the percentages above; focused owned PostgreSQL migration suite passed 12/12, including clean and populated pre-migration rollback. Raw historical marker, absent geographic columns, retained business rows/joins and FK enforcement were asserted; historical-contract Prisma verification is not claimed. ShellCheck 0.11.0 exact CI command, Bash syntax and diff-check passed. Owned exact container IDs were absent after cleanup. No new Newman or unrelated API/application E2E run is included in these counts.

Documentation-only T4 uses structural checks; runtime RED is N/A because prose changes no executable behavior. The T3 runner did not capture a separate raw marker query. Remote CI and required external reviews are PENDING, not inferred from local results. Newman RED (59 requests / 243 assertions, one NULL-depot failure) and failed intermediate attempts are retained and excluded from PASS counts.

## Evidencias

Local evidence ledger: [`odd/tasks/9-geolocation-persistence.md`](../../odd/tasks/9-geolocation-persistence.md). Implementation references: [`docs/geolocation-contract.md`](../geolocation-contract.md), [`docs/geolocation-migration.md`](../geolocation-migration.md), [`test/orders-security.e2e-spec.ts`](../../test/orders-security.e2e-spec.ts), and [`delivery-api.postman_collection.json`](../../delivery-api.postman_collection.json).

No GitHub Actions URL or external approval is available for this proposal. Before publication, attach sanitized reports and subsequent CI/review links; do not attach private host paths, credentials or environment values.

## Impacto técnico

**API / Contratos:** Optional complete numeric pairs; explicit NULL requests rejected. Order POST returns persisted scalar coordinates, while GET adds mapped points and geographic readiness. Zone omission on PATCH preserves coordinates. Marker confirmation belongs to the frontend.

**Base de datos / Migraciones:** Real Prisma 8 graph `∅ → d6f44c1 → ade716a → 00d34ab`; four nullable columns and two CHECKs, no default/backfill. Matching target snapshot is required. Additive DDL still locks tables. Clean/populated fixture rollback restores pre-migration backups to newly registered owned databases and asserts historical marker/schema/row/FK state; historical-contract Prisma verification is not claimed. No reverse migration or shared/production deployment is claimed; an environment owner must approve any deployment/recovery.

**Seguridad y permisos:** Preserve PR #19 authorization, ownership checks and status policy. DRIVER status mutations stay 403 until Issue #10. No permission expansion.

**Compatibilidad con otros componentes:** Historical rows stay visible and geographically ineligible until destination AND depot are valid. Issue #7 can consume explicit GeoPoint mappings; no optimization algorithm or Issue #10 lifecycle implementation is included.

**Limitaciones conocidas:** Geography is not business/lifecycle readiness. Valid-range swapped values are not detectable. Demo coordinates are not verified addresses. Cleanup cannot guarantee success after SIGKILL or Docker failure. The public [Issue #9](https://github.com/logistica-gc-uta/backend/issues/9) was freshly read on 2026-10-09: acceptance requires executed documented rollback on clean and existing test databases, green CI and integrated PR evidence. Local checks do not satisfy the remote delivery requirements.

## Checklist de entrega

- [ ] Cumplí los criterios de aceptación del Issue.
- [x] Implementé únicamente los cambios necesarios.
- [x] Ejecuté las pruebas correspondientes.
- [x] Verifiqué que el código compile correctamente.
- [x] Comprobé los posibles errores y excepciones.
- [x] Actualicé la documentación cuando fue necesario.
- [x] No incluí credenciales ni información sensible.
- [ ] Adjunté evidencia de los resultados.
- [ ] Solicité revisión a otro integrante.

Local functional proof is recorded above; final delivery checkboxes remain open for published sanitized evidence, required external review, CI, and pending candidate review/commit closure.

## Observaciones para el revisor

Review the contract/migration and historical NULL behavior first, then paired DTO/service tests, read projections and retained security assertions. Swagger request properties describe optional paired finite/ranged coordinates; response decorators currently provide prose descriptions, not typed geographic response schemas. The guide describes actual runtime responses rather than claiming richer generated OpenAPI schemas.

Local review units are harness/migration, utility `2375116`, zone `951bb8e`, order `8d644c6`, and seed/API `d869aa5`; they are dependent commits, not child PRs. Previously acknowledged review units remain closed. T3 is assessed high risk and awaits its separate human consent; general completion authorization is not that consent. T4 documentation is uncommitted to preserve the exact committed-only T3 candidate.

The aggregate feature exceeds 400 authored changed lines. One final feature-to-main PR is requested; no child branches/PRs were created. Coherent historical local slicing supports review but does not reduce the final PR diff. The owner explicitly accepted the oversized final single-PR exception; its rationale and scope are recorded below.


**Current T3 native intake blocker:** The latest preflight retains committed-only target `sha256:56e4034db7a2d6bbc0645e429332c6139036d9387d40df7ef5cf47e5407ba2a0`. Its next collect is `intended_untracked_selection_required`, schema `gentle-ai.review-intended-untracked-selection/v1`, requiring `external.select_intended_untracked` for untracked `docs/geolocation-contract.md` and `docs/pr/issue-9.md`. Read-only official-interface investigation and a schema-help spot check found no documented provider-bound JSON shape or exposed capture tool. No payload was fabricated, selectors added, staging used to evade intake, or authority mutated. This is unavailable transport, not a confirmed root-cause allegation; no upstream reporting was requested.

Native intake and candidate-specific consent remain pending. Retain earlier offered consent `review-7d2a85d7bd3febf9`; no T3 grant, capture, approval or acknowledgement occurred. T4 documentation remains uncommitted, and all original prior approvals and acknowledgements remain preserved. Issue #6 was subsequently published independently as PR #20 with CI running and no merge; its two native reviews are acknowledged and closed. It does not close Issue #9 review or publication prerequisites.

T5 test/harness/ShellCheck/runbook unit is functionally verified but uncommitted; parent work-unit commit and native assessment remain pending. It does not alter or close the committed-only T3 intake block.


**Independent T5 verification and current intake:** A separate private-copy focused verification passed fixture unit tests 21/21, migration E2E 12/12, Bash syntax and verified ShellCheck 0.11.0; the parent ShellCheck spot check also passed. This was scoped partial independent verification: it did not repeat full coverage, build or Newman. The writer's full 202-test/23-suite coverage, build and lint PASS remain separately observed evidence. Successful Docker health and listing queries confirmed the exact container, owner and harness labels absent after cleanup; failed inspect alone is not absence proof. Sanitized logs remain in private cache outside Git. Historical baseline marker/schema/rows/FK assertions are verified; historical-contract Prisma db verify is not claimed.

Exact post-T5 native preflight confirmed unchanged committed T3 target `sha256:56e4034db7a2d6bbc0645e429332c6139036d9387d40df7ef5cf47e5407ba2a0`, tree `9b511cda00807b1cc10e6bf00e0263e283c82bd4`. Collect still requires `external.select_intended_untracked`, schema `gentle-ai.review-intended-untracked-selection/v1`; transport is unavailable for the installed Codex 4.0 integration with capabilities v2.6. No guessed JSON, added selectors, staging evasion or authority changes occurred. Offered `review-7d2a85d7bd3febf9` consent remains pending. T4/T5 documentation and source remain unstaged/uncommitted because committing would alter the HEAD-based offered T3 candidate; neither task is complete. Fresh public Issue #9 acceptance was subsequently read, including rollback and CI requirements; earlier unavailable retrieval remains historical. Size acceptance and selected-session publication authorization are now resolved below; native intake, remote CI and outside review remain pending.

**Resolved publication scope and size acceptance:** The owner explicitly accepted the oversized final single-PR exception for Issues #9 and #6 only and authorized push/PR creation through the selected `Saimol-Uta` session, without authorizing merge. The parent verified that API identity and admin/push permissions. Delivery strategy is `exception-ok`: one final `feat/9-geolocation-persistence` → `main` PR; no child PRs or artificial file-type slicing. Nullable Order/Zone geography, strict complete-pair/range validation, visible historical NULL readiness, the real Prisma 8 migration graph/CHECKs, isolated clean/legacy PostgreSQL rollback proof, seeds/Newman/security regressions and handoff documentation form a cohesive delivery unit. Generated contract snapshots are accounted for separately. The committed tracked range through `d869aa5` contains 4,946 additions and 67 deletions across 27 paths (5,013 total; 3,283 excluding generated contract snapshots), before uncommitted T4/T5 changes. Final PR size is not yet known. The 400-line reviewability convention is not a GitHub gate; no `size:exception` label exists and none will be created or applied.

**Verified integration policy:** `main` requires one approving review, has no configured required status checks, and does not enforce administrators; applicable repository/parent rulesets were empty. Regardless, green feature CI and outside approval remain explicit human integration requirements, without bypass or self-approval. Publication authorization does not resolve native intake or grant T3 candidate consent, and no PR #9 publication, remote CI success, integration or Issue closure is claimed.

**Current official intake evidence:** Installed Gentle AI 4.0.0 stable with capabilities v2.6 exposes the selection schema but no documented compatible capture for `external.select_intended_untracked`. Canonical tracker #5129 remains open with 4.0 stable occurrences. PR #5332 merged a schema-identifier/conformance-test fix on main; it is not an installed published runtime capture fix. Latest stable remains 4.0.0. A documented compatible official capture/recovery is required before T3 review and T4/T5 commits. Preserve the exact frozen committed candidate; do not fabricate bindings/JSON/selectors, evade intake by staging, switch providers, disable RDD, start a replacement lineage, install unpublished source or infer recovery. T3 offered `review-7d2a85d7bd3febf9` and target `sha256:56e4034db7a2d6bbc0645e429332c6139036d9387d40df7ef5cf47e5407ba2a0` remain unreviewed with consent pending; T4/T5 remain uncommitted. Earlier T1/T2 acknowledged reviews remain closed.

**Independent Issue #6 status:** [PR #20](https://github.com/logistica-gc-uta/backend/pull/20) was published at head `fe0bd09`, with CI running at the parent's latest observation and no merge. Its two separate native reviews were approved, acknowledged and burned. This does not resolve Issue #9 intake, consent or delivery requirements.
