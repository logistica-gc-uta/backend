# Issue 35 — Shop REGALIA: seed idempotente de catálogo, tarjetas ficticias y QA transversal (CLIENT→ADMIN→DRIVER)

Branch: `feat/35-shop-seed-qa` (stacked on `feat/34-shop-receipts` → `feat/33-shop-checkout-concurrency` → `feat/32-shop-catalog-cloudinary` → `main` @ `13a557e`). Local commits only; RDD off unchanged; no push, no PR creation, no merge, no automatic approval.
Stacked on: #32 (catálogo, categorías, imágenes Cloudinary, CRUD ADMIN), #33 (checkout, tarjetas simuladas, monto del servidor, transacción atómica, clave de idempotencia) and #34 (comprobante inmutable con referencia secuencial única). Those three issues are already specified and are being implemented. This issue **consumes** their published contracts and **does not** modify the surfaces they own.

## Specs
S1 — "Crear seed idempotente de al menos 200 regalos tematizados, categorías, URLs legítimas Cloudinary, precios, stock y tarjetas ficticias; evitar sobrescribir registros históricos."
S2 — "Pruebas PostgreSQL reales: 2 CLIENT compran simultáneamente última unidad (stock=1), uno gana y otro agotado, no doble order ni saldo consumido para perdedor."
S3 — "Validar monto recalculado backend, cero saldo, idempotencia doble clic/reintentos, rollback forzado, no acceso CLIENT a Cloudinary/admin, lectura ajena de comprobantes."
S4 — "E2E CLIENT Shop→ADMIN planificación→DRIVER Flutter; pruebas de análisis estático, carga/volumen/estrés adicionales sin reemplazar backend #15."
S5 — "Evidencia por commit, datos de prueba, salidas, PASS/FAIL y CI; coordinar con integrantes, NO marcar aprobado antes de ejecutar."
S6 — "Definition of Done: PR con revisión humana, pruebas automatizadas y de integración aplicables, CI, evidencia/documentación, sin merge automático."
S7 — "Dependencias: backend checkout+catálogo, frontend Shop, Flutter #3/#4."
S8 — Scope and deadline (verbatim): "Fuente de alcance aprobada: https://docs.google.com/document/d/1hPLYkA885tqwjhNWZ08IW7KjSqUPZV1TIAge4_OQ5SQ/edit?usp=drivesdk" · "Fecha final del proyecto: 26/11/2026." · "Propuesta de trabajo: P0 · CP-SHOP-001..034 · QA transversal."
S9 — Human decision (verbatim answer): "Sin credenciales por ahora". Consequence: the real Cloudinary upload is **not** verified. The image URL **liveness** check is reported as `NOT EXECUTED` with that exact reason and must never be reported as passed. The image URL **format (shape)** check IS executed and is reported as `PASS`.
S10 — Cross-repository evidence boundary (parent). The **backend** part of "E2E CLIENT Shop→ADMIN planificación→DRIVER Flutter" is executed and proven in this repository. The Flutter application (issues #3/#4) and the React frontend (Shop) are **separate repositories that this issue does not own**: their parts are executed by their owners with their own evidence. The backend evidence must **not** claim the mobile or web integration as verified.
S11 — Issue #15 boundary (parent). The extra "pruebas de análisis estático, carga/volumen/estrés" run **in addition to** backend issue #15. #15 stays open, keeps its own scope, and is neither replaced, closed nor narrowed by this issue.
S12 — User request (verbatim): "tengo asigando estas issue completalas con los agente los mas repido :" with the assignment row "Paralelo    #35 — Catálogo de prueba y QA    P0    Mateo prepara los datos y las pruebas progresivamente".

## Frozen contract (do not renegotiate; issues #32, #33 and #34 are already specified and are being implemented)

### 1. Additive migration: `Product.sku`

`Product` after #32 (frozen) plus the single additive field of this issue. The block below is the exact PSL the writer must produce; the #32 part is reproduced unchanged:

```prisma
model Product {
  id          String   @id @default(uuid())
  name        String
  description String?
  price       Float
  stock       Int      @default(0)
  createdAt   DateTime @default(now())

  // #32 (frozen, already specified): categories, publication and images.
  categoryId   String?
  category     Category?     @relation(fields: [categoryId], references: [id])
  isPublished  Boolean       @default(true)
  images       ProductImage[]

  // #35 (this issue): stable identity of a seeded gift.
  // NULL for every row created outside the shop seed, so no existing row and
  // no existing route changes meaning.
  sku          String?      @unique

  orderItems   OrderItem[]
}
```

Rules of the migration:
- It is **additive only**: one nullable `sku` column on `public.product` plus the unique index over it. No column is dropped, renamed, retyped or made `NOT NULL`; no default is added; no other model, index, constraint or route changes.
- `sku` is nullable **on purpose**. PostgreSQL treats `NULL` values as distinct inside a unique index, so every pre-existing `Product` row (and every product created later by the #32 ADMIN CRUD, which leaves `sku` as `NULL`) is unaffected.
- The unique index is the idempotency anchor of the seed. It is created by the migration, not by the seed script, so the constraint exists even when the seed has never run.
- The migration package is produced by the formal path and lands in `migrations/app/<timestamp>_add_product_sku/` with its snapshot under `migrations/snapshots/`: `pnpm prisma contract emit` → `pnpm prisma migration plan --name add_product_sku` → `pnpm prisma db migrate` → `pnpm prisma db verify` (expected: "Database marker and schema match contract"). Generated snapshot artefacts are never hand-edited.
- `src/prisma/contract.json` and `src/prisma/contract.d.ts` are re-emitted so `sku` is present in the runtime types.

### 2. Seed catalogue contract

| Item | Frozen value |
| --- | --- |
| Script path | `src/prisma/seed-shop.ts` (new file; `src/prisma/seed.ts` is **not** modified) |
| Package script | `"seed:shop": "tsx src/prisma/seed-shop.ts"` (new entry; no existing `package.json` script changes) |
| Command | `pnpm run seed:shop` |
| Data access | `import { db } from './db.js'` from `src/prisma/db.ts`, exactly like `src/prisma/seed.ts` and `src/prisma/seed-planning-demo.ts`; the script ends with `await db.close()` in `finally` and `process.exit(1)` on error |
| Gifts | Exactly **200** themed gifts, indexed `i = 1..200`, `sku = "SHOP-GIFT-" + i` zero-padded to 4 digits (`SHOP-GIFT-0001` … `SHOP-GIFT-0200`) |
| Gift name | Distinct, non-empty, 10..60 characters, Spanish, and explicitly themed to its category. The writer authors the 200 literal entries in the seed module; the seed never invents a name at runtime |
| Gift description | One short Spanish sentence, non-empty |
| Categories | Exactly **10**, in this fixed order: `tecnologia` (Tecnología), `hogar` (Hogar y Cocina), `deportes` (Deportes), `moda` (Moda y Accesorios), `regalos-corporativos` (Regalos Corporativos), `dulces-y-snacks` (Dulces y Snacks), `viajes` (Viajes y Escapadas), `bienestar` (Bienestar y Autocuidado), `infantil` (Infantil y Familiar), `tematicos` (Temáticos de Temporada). Gift `i` belongs to the category at index `(i - 1) % 10`, so each category holds exactly 20 gifts. The category `name` and `slug` are the pairs above; the `description` is one short Spanish sentence |
| Price | Fixed ladder of 12 points: `9.99, 14.99, 19.99, 24.99, 29.99, 39.99, 49.99, 69.99, 99.99, 149.99, 199.99, 249.99`. Gift `i` takes the point at index `(i - 1) % 12`. Price range of the catalogue: **9.99 – 249.99** |
| Stock | `stock(i) = 0` when `i % 20 == 0`; `1` when `i % 20 == 1`; `2` when `i % 20 == 2`; `3` when `i % 20 == 3`; otherwise `5 + ((i * 7) % 26)` (range 5..30). The mix is therefore **10 gifts with stock 0**, **10 with stock 1** (the race candidates), **10 with stock 2**, **10 with stock 3** and **160 in 5..30** |
| Publication | Every seeded gift is created with `isPublished = true` (the #32 default), so the whole catalogue is publicly visible right after the seed |
| Image URL | `https://res.cloudinary.com/<cloudName>/image/upload/<publicId>.<format>` with `cloudName` = `process.env['CLOUDINARY_CLOUD_NAME']` or the documented fallback `demo` when the variable is absent or empty; `publicId` = `shop/gift-0001` … `shop/gift-0200` (zero-padded to 4 digits, deterministic per gift); `format` = `jpg` for every gift. Example: `https://res.cloudinary.com/demo/image/upload/shop/gift-0001.jpg` |
| Image row | One `ProductImage` row per seeded gift: `publicId` = the `publicId` above, `url` = the delivery URL above, `format` = `jpg`, `isPrimary = true`, and `bytes` / `width` / `height` left `NULL` (the real asset is unknown without credentials). The row is guarded by the #32 `@@unique([productId, publicId])` constraint |
| Cards | Exactly **3** simulated cards, all fictional by construction (ISO/IEC 7812 reserved prefix `9900`, never a real banking range). Holder names are clearly fictional. Balances are the seeded starting balances; the QA harness restores each balance to the seeded value through the same #33 model before every run (documented in the report's *Test data* section, §5 item 3) |
| Card 1 (sufficient balance) | `9900000000000001` — balance **500.00** (covers the maximum catalogue price 249.99) |
| Card 2 (limited balance) | `9900000000000002` — balance **10.00** (funds the 9.99 gift and nothing above it) |
| Card 3 (zero balance) | `9900000000000003` — balance **0.00** (can never fund an order) |
| Environment variables | `CLOUDINARY_CLOUD_NAME` (optional, fallback `demo`) and the already-standard `DATABASE_URL` read by `src/prisma/db.ts`. The seed requires **no** new environment variable to exist. `.env.example` is **not** modified by this issue: `CLOUDINARY_CLOUD_NAME` is documented in the seed header comment and in `docs/shop-qa-report.md` |
| Catalogue size flag | The catalogue size is **fixed** at 200. The seed exposes no flag that changes the catalogue, because the `sku` set must stay stable for the idempotency contract to hold |
| Card persistence | The three cards are written through the simulated-card model introduced by #33, looked up by the card number, created only when absent. This issue must **not** create a second, parallel card model. If the #33 model is not present when the seed runs, the seed must fail loudly with an explicit message instead of creating an alternative table. The card numbers and balances are **defined once**, in the shared card-seed module that issue #33 introduces (`src/prisma/seed-shop-cards.ts`); this seed calls that module and must not restate the card numbers or balances in its own source. The canonical stored form of a card number is digit-only, exactly as #33 freezes it; a dashed grouping is accepted on input and normalized to digits. |

### 3. Exact idempotency rule (keyed on the sku)

- The stable identity of a seeded gift is `Product.sku`. The seed computes the whole desired catalogue **deterministically** on every run: same 200 gifts, same names, same descriptions, same categories, same prices, same stock, same image URLs, same cards.
- For each gift: look up the `Product` by `sku`.
  - **Absent** → create the row with the full frozen payload (name, description, price, stock, `sku`, category, `isPublished = true`) and create its `ProductImage`.
  - **Present** → touch **nothing**. The seed never updates `name`, `description`, `price`, `stock`, `isPublished`, `categoryId` or the image row of an existing `sku`. A product an ADMIN has since edited (re-priced, re-stocked, unpublished, re-categorised) keeps the edited values.
- For each category: look up by `slug` (already unique in the #32 contract). Absent → create. Present → do not rename, re-describe or deactivate it.
- For each card: the shared card-seed module of issue #33 (`src/prisma/seed-shop-cards.ts`) looks up by the card number. Absent → create. Present → do not change the stored balance.
- The seed **never deletes** a row, **never** truncates a table and **never** touches historical `OrderItem` rows or their historical `price`.
- Running `pnpm run seed:shop` twice must produce, on the second run, `created: 0` gifts, `created: 0` categories and `created: 0` cards, with `skipped: 200` gifts, and **zero** modified rows. The seed prints that summary (created / skipped per entity) so the result is observable in the raw output.
- The seed prints the resolved `cloudName` it used (`CLOUDINARY_CLOUD_NAME` or `demo`) so the report can state which value was in force.

### 4. QA matrix

Identifier note. The local check identifiers below are `CP-SHOP-001`..`CP-SHOP-015`, indexes **inside** the range `CP-SHOP-001..034` approved by the issue. The SRS assigns the authoritative meaning of each `CP-SHOP-nn`; this document maps the locally executable subset onto that range and does **not** restate, guess or override the SRS numbering. A local identifier is a traceability handle, not a claim about the SRS.

Endpoint paths for checkout (#33) and receipts (#34) are **not** restated here: they are owned by those issues' frozen contracts. The QA harness reads them from the implemented controllers. If a path is still undefined at implementation time, the harness must fail loudly instead of guessing.

| Check | What it proves | How it is executed | Expected observable result | PASS/FAIL evidence file |
| --- | --- | --- | --- | --- |
| `CP-SHOP-001` | The seed is idempotent: a second run creates no duplicate gift, category or card | `test/shop-qa/shop-qa-seed.e2e-spec.ts`: spawn `pnpm run seed:shop` twice against the owned database and census the rows by `sku` / `slug` / card number before and after | Second run reports `created: 0`; the census is byte-identical; 0 duplicate `sku` values; the first run reports `created: 200` gifts, `created: 10` categories, `created: 3` cards | `reports/shop-qa/seed-idempotency.log` |
| `CP-SHOP-002` | Historical and ADMIN-edited data is never overwritten ("evitar sobrescribir registros históricos") | Same spec: seed once → an ADMIN edits a seeded gift (price `999.99`, unpublished) and a historical `OrderItem` row is recorded → seed again → re-read both rows | The edited price is still `999.99`, the gift is still unpublished, the stock is unchanged, the historical `OrderItem.price` is unchanged, and the row count did not change | `reports/shop-qa/seed-no-overwrite.log` |
| `CP-SHOP-003` | The catalogue is complete: ≥200 themed gifts, 10 categories, price range, stock mix including zero-stock items | Same spec: census over `Product` where `sku IS NOT NULL` and over `Category` | Exactly 200 seeded gifts spread over exactly 10 categories (20 each); every price within `[9.99, 249.99]`; exactly 10 gifts with stock 0, 10 with stock 1, 10 with stock 2, 10 with stock 3 and 160 within `[5, 30]`; 0 gifts outside the mix | `reports/shop-qa/catalogue-inventory.log` |
| `CP-SHOP-004` | Every seeded image URL is a well-formed Cloudinary **delivery** URL (shape only) | Same spec: offline regex assertion over the 200 image URLs, no network call | 200/200 URLs match `^https://res\.cloudinary\.com/[a-z0-9-]+/image/upload/shop/gift-\d{4}\.jpg$` with `cloudName` equal to the resolved `CLOUDINARY_CLOUD_NAME` or `demo`; 0 mismatches — reported as **PASS** | `reports/shop-qa/image-url-format.log` |
| `CP-SHOP-005` | *(NOT EXECUTED)* the seeded URLs resolve to a real remote asset | **NOT EXECUTED.** Reason (exact): "Sin credenciales por ahora". No Cloudinary credentials exist in this environment, so no upload was performed and no liveness request is claimed | The report row reads `NOT EXECUTED` with that exact reason. It must **never** read `PASS`, and no liveness request may be reported as executed | `reports/shop-qa/image-url-liveness.NOT-EXECUTED.md` |
| `CP-SHOP-006` | Two CLIENTs buying the last unit simultaneously produce exactly one order | `test/shop-qa/shop-qa-checkout.e2e-spec.ts`, real PostgreSQL: pick a seeded gift with `stock = 1`, then fire the two #33 checkout requests **in parallel** (`Promise.all`) with two distinct CLIENT tokens and two distinct cards | Exactly 1 order exists for that product; the winner gets the success status defined by #33; the loser gets the sold-out status defined by #33; never two orders | `reports/shop-qa/concurrency-last-unit.log` |
| `CP-SHOP-007` | The loser of the race has no order and no consumed balance | Same spec: after the race, read the loser's orders, order items and card balance | The loser owns 0 orders for that product; the loser's card balance is byte-identical to its pre-race value; the loser's total order count did not increase | `reports/shop-qa/concurrency-loser-no-charge.log` |
| `CP-SHOP-008` | The amount charged is recomputed by the backend, never taken from the request body | Same spec: submit a checkout body whose amount/price field is tampered (e.g. `0.01`) for a known gift and quantity | The persisted order total equals the server-computed `catalogue price × quantity`; the tampered value is ignored; the order item price equals the catalogue price | `reports/shop-qa/server-total.log` |
| `CP-SHOP-009` | The zero-balance card can never fund an order | Same spec: check out with `9900-0000-0000-0003` (balance `0.00`) | The checkout is rejected with the insufficient-funds status defined by #33; 0 orders are created for that attempt; the card balance stays `0.00` | `reports/shop-qa/zero-balance.log` |
| `CP-SHOP-010` | Idempotency on double click and on retry: one key, one order, one balance consumption | Same spec: two concurrent requests with the same idempotency key, then a third sequential retry with the same key | Exactly 1 order exists; the balance was consumed exactly once; the 2nd and 3rd responses return the same order identity as the 1st (the behaviour defined by #33), never a new order | `reports/shop-qa/idempotency-double-click.log` |
| `CP-SHOP-011` | A forced failure inside the checkout transaction leaves nothing behind | Same spec, **forced rollback mechanism (frozen)**: inside the owned test database the harness installs a temporary `BEFORE INSERT` trigger on the order table that raises an exception when the order's delivery address equals a sentinel value; the trigger and the sentinel are dropped in `afterAll`. This mechanism needs **no** change to #33's code; if #33 exposes an explicit failure-injection hook it may be used **in addition**, never instead | The request fails; 0 orders, 0 order items, 0 receipt rows and 0 balance movements exist for that attempt; the gift's stock is unchanged | `reports/shop-qa/rollback.log` |
| `CP-SHOP-012` | A CLIENT can reach neither Cloudinary nor any ADMIN surface | `test/shop-qa/shop-qa-security.e2e-spec.ts`: with a CLIENT token, call every ADMIN route of #32 (upload sign, server-side upload, upload complete, product CRUD, category CRUD, publish/unpublish, image association/primary/deletion, orphan cleanup) and the Cloudinary admin routes | Every call answers `403` (`401` when anonymous); no product, category, image or upload row is created, modified or deleted; the catalogue census from `CP-SHOP-003` is unchanged | `reports/shop-qa/rbac-client-denied.log` |
| `CP-SHOP-013` | A CLIENT cannot read another CLIENT's comprobante | Same spec: CLIENT A checks out, CLIENT B requests A's receipt | B never receives the receipt body (the `403`/`404` defined by #34); the receipt reference, amount and items appear nowhere in B's response | `reports/shop-qa/receipt-isolation.log` |
| `CP-SHOP-014` | The backend supports the full CLIENT → ADMIN → DRIVER flow | `test/shop-qa/shop-qa-e2e-flow.e2e-spec.ts`, real PostgreSQL: a CLIENT reads the public catalog (`GET /api/v1/shop/products`), checks out a seeded gift, an ADMIN plans the route for that order, a DRIVER is assigned and completes the delivery | Each step answers the status defined by its owning issue; the order reaches the delivered state; the receipt exists. **Backend part only** — the Flutter (#3/#4) and React parts are owned elsewhere and are **not** claimed here (S10) | `reports/shop-qa/e2e-client-admin-driver.log` |
| `CP-SHOP-015` | The extra static-analysis, load, volume and stress checks run **in addition to** #15 | `test/shop-qa/shop-qa-nonfunctional.e2e-spec.ts` plus the repository commands: `pnpm run lint` (oxlint, type-aware over `src/ test/ benchmarks/`), `pnpm run build`; volume = a full read of the 200-gift catalogue through `GET /api/v1/shop/products` with the #32 pagination; load = 50 concurrent catalog reads recording p95 latency and error count; stress = 20 concurrent checkouts against a single seeded gift with `stock = 1` recording successes, sold-out responses, 5xx count and unhandled rejections | `lint` and `build` exit 0; the volume pass covers all 200 gifts; the load pass records its p95 and 0 unexpected errors; the stress pass yields exactly 1 success, 19 sold-out answers, 0 5xx and 0 unhandled rejections. #15 stays open with its own scope untouched (S11) | `reports/shop-qa/non-functional-extra.log` |

### 5. Evidence report layout

The single committed evidence document is `docs/shop-qa-report.md`, with this exact section order:

1. **Header** — issue, branch `feat/35-shop-seed-qa`, base `main` @ `13a557e`, author, date, and the statement that nothing in the report is approved until a human signs it.
2. **Commits covered** — a table `commit hash | what the commit introduced | checks executed on that commit`. Every row must be a commit that actually exists; the hash is taken from the branch, never from memory.
3. **Test data** — the frozen catalogue parameters (200 gifts, 10 categories, price ladder, stock mix, image URL shape, resolved `cloudName`), the three simulated cards with their balances, the users used (2 CLIENT + 1 ADMIN + 1 DRIVER, per-run nonce, e.g. `issue35-<label>-<run>@delivery.test`), the database isolation method (owned database per suite via `createOwnedDatabase` / `runPrismaMigrate` / `cleanupOwnedResources` from `test/geolocation-migration.fixtures.ts`), and the sentinel values (rollback trigger sentinel, idempotency keys, race gift).
4. **Commands** — the exact command line of every check, in execution order, copy-pasteable.
5. **Raw output references** — a table `check | raw artefact under reports/shop-qa/ | decisive output embedded in this report`. `.gitignore` ignores `reports/` and `*.log`, so the raw artefacts stay local while the **decisive output of every check is embedded verbatim** in this document; the committed evidence is therefore self-contained. The report is written so a reviewer never has to open a local file to judge a verdict.
6. **PASS/FAIL table** — one row per check: `check | verdict (PASS | FAIL | NOT EXECUTED) | evidence reference | commit executed on`. `CP-SHOP-005` is the only row allowed to read `NOT EXECUTED`, with the reason "Sin credenciales por ahora". A row may only read `PASS` when the check was actually executed on the stated commit.
7. **CI** — the CI run link and its status. Until a real run exists, the link is written as `PENDING` with the reason; it is never written as passing without an actual run URL.
8. **Scope boundaries** — the explicit statement that the Flutter and React parts are owned elsewhere and are not verified here (S10), that #15 remains open with its own scope (S11), and that the Cloudinary liveness check was not executed (S9).
9. **Approval** — `Aprobado por revisor humano: PENDIENTE` with a name/date line. The "NO marcar aprobado antes de ejecutar" rule (S5) is binding: nothing may be marked approved or passed that was not actually executed, and this block stays unsigned until a human reviews it.

## Tasks
T0 | S1,S8 | `src/prisma/contract.prisma`, `src/prisma/contract.json`, `src/prisma/contract.d.ts`, `migrations/app/<timestamp>_add_product_sku/`, `migrations/snapshots/` | pending | additive `Product.sku` migration: `pnpm prisma contract emit`, `pnpm prisma migration plan --name add_product_sku`, `pnpm prisma db migrate`, `pnpm prisma db verify` ("Database marker and schema match contract"); raw output under `reports/shop-qa/`
T1 | S1 | `src/prisma/seed-shop.ts`, `package.json` (new `seed:shop` entry only) | pending | `pnpm run seed:shop` summary: 200 gifts, 10 categories, 3 cards, resolved `cloudName`; second run reports `created: 0`; `pnpm run seed` (existing `src/prisma/seed.ts`) still passes unchanged
T2 | S1,S9 | `test/shop-qa/shop-qa-seed.e2e-spec.ts` | pending | `CP-SHOP-001`, `CP-SHOP-002`, `CP-SHOP-003`, `CP-SHOP-004` executed (PASS) and `CP-SHOP-005` recorded as NOT EXECUTED with the reason "Sin credenciales por ahora"
T3 | S2,S3 | `test/shop-qa/shop-qa-checkout.e2e-spec.ts` | pending | `CP-SHOP-006`, `CP-SHOP-007`, `CP-SHOP-008`, `CP-SHOP-009`, `CP-SHOP-010`, `CP-SHOP-011` executed against real PostgreSQL, one raw artefact per check
T4 | S3 | `test/shop-qa/shop-qa-security.e2e-spec.ts` | pending | `CP-SHOP-012` and `CP-SHOP-013` executed; every denied call logged with its status code
T5 | S4,S7,S10 | `test/shop-qa/shop-qa-e2e-flow.e2e-spec.ts` | pending | `CP-SHOP-014` executed for the backend part only against the #32 catalog and the #33 checkout, with an explicit note in the output that the frontend Shop and the Flutter #3/#4 parts are owned elsewhere and are not verified here
T6 | S4,S11 | `test/shop-qa/shop-qa-nonfunctional.e2e-spec.ts` | pending | `CP-SHOP-015`: `pnpm run lint` and `pnpm run build` exit 0; volume, load and stress numbers recorded; #15 confirmed still open
T7 | S1,S5,S6 | `docs/shop-qa-report.md` | pending | report with commits covered, test data, commands, raw output references, PASS/FAIL table, CI link, scope boundaries and an unsigned approval block
T8 | S5,S6,S7,S12 | inline: parent closure — regression, CI inventory, evidence readback, coordination with the other integrators (frontend Shop, Flutter #3/#4) | pending | unit inventory `pnpm test --roots src test`, integration inventory `pnpm run test:e2e`, `pnpm run lint`, `pnpm run build`, CI result, the report read back against the executed artefacts, and the coordination note confirming that the frontend and Flutter evidence is owned by its own repository

## Log
L1 — Original user request (verbatim)
`tengo asigando estas issue completalas con los agente los mas repido :`
```
Orden    Issue    Prioridad    Motivo
1    #31 — Seguridad y autenticación CLIENT    P0    Corregir la creación de usuarios y asegurar los roles
2    #32 — Catálogo y Cloudinary    P0    Desbloquear las Issues frontend #19 y #21 de Kerly
3    #33 — Checkout y pagos simulados    P0    Implementar la compra segura con control de concurrencia
4    #34 — Comprobantes simulados    P0    Completar el proceso posterior a la compra
Paralelo    #35 — Catálogo de prueba y QA    P0    Mateo prepara los datos y las pruebas progresivamente
```

L2 — Assignment (parent). This issue #35 is assigned to Mateo: "Mateo prepara los datos y las pruebas progresivamente". The work is therefore progressive: the seed and its catalogue land first (T0, T1), then the QA harness grows check by check (T2 → T6), then the evidence and the closure (T7, T8). The seed is prepared so the harness always has data to run against; the harness never depends on data the seed did not create.

L3 — Branch plan (parent). `feat/35-shop-seed-qa` is stacked on `feat/34-shop-receipts`, which is stacked on `feat/33-shop-checkout-concurrency`, which is stacked on `feat/32-shop-catalog-cloudinary`, which is stacked on `main` @ `13a557e`. The branch is local only: no push, no PR creation, no merge, no automatic approval, exactly as in #31, #32, #33 and #34.

L4 — Environment facts (parent, observed). The local `.env` points at PostgreSQL on port **5433** after the container repair described in #32 L4; the project container is `logistica_postgres` (compose project `backend`, volume `backend_postgres_data`). The unit inventory command is `pnpm test --roots src test`. The integration inventory command is `pnpm run test:e2e`. Plain `pnpm test` fails before any change with a jest-haste-map parse error caused by leftover `.issue13-*` scratch directories in the repository root; that failure is pre-existing and is not caused by this issue.

L5 — Existing seed path and package scripts that must not break (parent). `src/prisma/seed.ts` is the existing seed, invoked by the package script `"seed": "tsx src/prisma/seed.ts"`; it provisions the zones, the 5 logistics products, the ADMIN, the 2 DRIVERs and the 2 CLIENTs. The other existing seed scripts are `"seed:reset-drivers": "tsx src/prisma/reset-drivers.ts"` and `"seed:planning-demo": "tsx src/prisma/seed-planning-demo.ts"`. This issue **adds** `"seed:shop": "tsx src/prisma/seed-shop.ts"` and **modifies no existing script**; `src/prisma/seed.ts` keeps working unchanged and its regression is part of T1.

L6 — Frozen decisions (parent). Recorded here so the writer does not renegotiate them:
D1 — The seed is a **new** script `src/prisma/seed-shop.ts` with its **own** package script, not a modification of the existing `src/prisma/seed.ts`, which must keep working unchanged.
D2 — The seed is idempotent and never overwrites historical records. The stable identity of a seeded gift is the new nullable unique field `Product.sku`, added by an additive migration in this issue. The seed creates a row only when its `sku` is absent; running it twice must not duplicate, re-price, re-stock or unpublish anything; a product an ADMIN has since edited keeps its edited values.
D3 — The catalogue seed creates at least 200 themed gifts spread over a set of categories, with realistic prices, a mix of stock levels including zero-stock items, and image URLs in the real Cloudinary delivery format `https://res.cloudinary.com/<cloudName>/image/upload/<publicId>.<format>`, with `cloudName` from `CLOUDINARY_CLOUD_NAME` and the documented fallback `demo`, and a deterministic `publicId` per gift, for example `shop/gift-0001`.
D4 — The real Cloudinary upload is **not** verified: no Cloudinary credentials exist in this environment (the human answered "Sin credenciales por ahora"). The seed therefore produces well-formed Cloudinary delivery URLs, and the QA report must record the image URL liveness check as **NOT EXECUTED** with that exact reason. It must never report a liveness check as passed. A format check of the URL shape **is** executed and reported as **PASS**.
D5 — The simulated cards seeded are clearly fictional: the ISO/IEC 7812 reserved prefix `9900`, for example `9900000000000001`, so no real banking card range is ever implied. Three cards are required: one with a sufficient balance, one with a limited balance and one with zero balance. The canonical stored and returned form is digit-only, matching the checkout contract of issue #33.
D6 — The QA harness lives in **new** test files and **new** documentation, not inside the existing suites, so the existing suites stay untouched. It covers the matrix the issue lists: two CLIENTs racing for the last unit against real PostgreSQL; the server-recomputed total; a zero-balance card; idempotency on double click and on retry; a forced rollback; a CLIENT denied Cloudinary and ADMIN access; a CLIENT denied another CLIENT's receipt.
D7 — The end-to-end flow CLIENT Shop → ADMIN planning → DRIVER delivery is executed against this backend. The Flutter application and the React frontend are separate repositories that this issue does not own: the backend part of that flow is executed and proven here, and the Flutter and React parts are executed by their owners with their own evidence. The backend evidence must not claim the mobile or web integration as verified.
D8 — The additional static-analysis, load, volume and stress checks **add to** the existing backend issue #15, which stays open and is not replaced by this issue. The extra checks run in addition and #15 keeps its own scope.
D9 — The evidence is per commit: a written report with the test data, the commands, their raw outputs, an explicit **PASS** or **FAIL** per check, and the CI result. The human rule "NO marcar aprobado antes de ejecutar" is binding: nothing is reported as approved or passed that was not actually executed.

L7 — Repository facts a writer needs (parent, read-only). The unit test config is `jest.config.ts` with `testRegex: '.*\\.spec\\.ts$'`, so files named `*.e2e-spec.ts` are **not** collected by the unit run; the integration config is `test/jest-e2e.json` with `testRegex: '.e2e-spec.ts$'` and `rootDir: '.'`, so a new `test/shop-qa/*.e2e-spec.ts` file is collected automatically by `pnpm run test:e2e` and by the isolated E2E manifest. The e2e isolation pattern to reuse is the one in `test/issue31-auth.e2e-spec.ts`: `createOwnedDatabase` / `runPrismaMigrate` / `cleanupOwnedResources` from `test/geolocation-migration.fixtures.ts`, `jest.setTimeout(180_000)`, and `process.env.DATABASE_URL` pointed at the owned database before the Nest application is imported. `pnpm run lint` is `oxlint --type-aware src/ test/ benchmarks/`, so the new test files must be lint-clean. `src/database/prisma.service.ts` exposes the `product` accessor today, and #32 adds the accessors for `Category`, `ProductImage` and `ShopUpload` (exact accessor names are owned by the #32 frozen contract).

L8 — Evidence durability (parent). `.gitignore` ignores `reports/` and `*.log`. The raw artefacts therefore live locally under `reports/shop-qa/` and are **referenced** by `docs/shop-qa-report.md`, which is the committed evidence. Because a reference alone is not reviewable, the report embeds the decisive output of every check verbatim, so a reviewer can judge each verdict from the document alone. The report also carries the commit hashes it covers, so the evidence is per commit as S5 requires.

L9 — Naming and parameter decisions taken by the writer of this document (for the parent's review, not renegotiable without a human answer). The 10 category slugs and names, the 12-point price ladder, the `stock(i)` formula, the `SHOP-GIFT-NNNN` sku format (deliberately different from the `shop/gift-NNNN` Cloudinary `publicId`, because a SKU is not an asset path), the card balances `500.00 / 10.00 / 0.00`, the `CP-SHOP-001..015` local check identifiers, the raw-artefact file names, the rollback trigger mechanism and the `seed:shop` script name are writer decisions: the issue fixes the quantities, the ranges and the rule, but not these literal values.
