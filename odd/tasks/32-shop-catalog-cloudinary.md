# Issue 32 — Shop REGALIA: categorías, imágenes Cloudinary y CRUD ADMIN de catálogo

Branch: `feat/32-shop-catalog-cloudinary` (base `main` @ `13a557e`). Local commits only; RDD off unchanged; no push, no PR creation, no merge, no automatic approval.
Worktree for this feature: `~/.codex/worktrees/issue32-catalog/backend` (same clone, branch `feat/32-shop-catalog-cloudinary`).

## Specs
S1 — "Ampliar catálogo: categorías, imágenes URL secure_url + public_id, publicación/despublicación, filtros/paginación."
S2 — "CRUD del catálogo únicamente ADMIN (JWT/RBAC), también alta/edición de categorías."
S3 — "Carga Cloudinary firmada/autenticada exclusivamente ADMIN: CLIENT/anónimo sin firma, upload ni asociación; secreto solo backend; validar formato y tamaño y limpiar huérfanos."
S4 — "No romper precios históricos ni rutas existentes."
S5 — "Aceptación: integración real imagen→Cloudinary→URL PostgreSQL; 401/403 CLIENT/anónimo; tests CRUD/filtros/publicación."
S6 — "Coordinar contrato con frontend antes de implementar."
S7 — "Definition of Done: PR con revisión humana, pruebas automatizadas y de integración aplicables, CI, evidencia/documentación, sin merge automático."

S8 — Human decision 1 (verbatim answer): "Sin credenciales por ahora". Cloudinary credentials are NOT available. The signed-upload contract, the authorization rules and the association/cleanup rules are implemented and proven; the real remote upload is an explicit pending item and must never be reported as verified.
S9 — Human decision 2 (verbatim answer): "Backend define y publica". The backend defines the REST contract and publishes it in `docs/shop-api-contract.md` for the frontend issues #19 and #21. Implementation does not wait for the frontend.
S10 — User request (verbatim): "tengo asigando estas issue completalas con los agente los mas repido" with row "2    #32 — Catálogo y Cloudinary    P0    Desbloquear las Issues frontend #19 y #21 de Kerly".

## Frozen contract (do not renegotiate; downstream issues #33, #34 and #35 build on it)

### Data contract (exact PSL, added by T0)

```prisma
model Category {
  id          String   @id @default(uuid())
  name        String   @unique
  slug        String   @unique
  description String?
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())

  products    Product[]
}

model Product {
  // existing fields unchanged: id, name, description, price, stock, createdAt
  categoryId   String?
  category     Category?     @relation(fields: [categoryId], references: [id])
  isPublished  Boolean       @default(true)
  images       ProductImage[]
}

model ProductImage {
  id        String   @id @default(uuid())
  productId String
  product   Product  @relation(fields: [productId], references: [id])
  url       String
  publicId  String
  format    String?
  bytes     Int?
  width     Int?
  height    Int?
  isPrimary Boolean  @default(false)
  createdAt DateTime @default(now())

  @@unique([productId, publicId])
  @@index([productId])
}

enum ShopUploadStatus {
  PENDING
  ASSOCIATED
}

model ShopUpload {
  id        String           @id @default(uuid())
  publicId  String           @unique
  url       String
  status    ShopUploadStatus @default(PENDING)
  expiresAt DateTime
  createdAt DateTime         @default(now())

  @@index([status, expiresAt])
}
```

`Product.isPublished` defaults to `true` so every existing product row stays publicly visible and no existing route changes meaning. `Product.categoryId` is nullable so existing product rows keep working without a category.

### REST surface

Public, no authentication:
- `GET /api/v1/shop/categories` — active categories only.
- `GET /api/v1/shop/products` — published products only. Query: `q` (name or description, case-insensitive), `category` (slug or id), `minPrice`, `maxPrice`, `onlyAvailable` (boolean, default false), `sort` (`newest` | `price_asc` | `price_desc`, default `newest`), `page` (default 1, min 1), `pageSize` (default 20, min 1, max 100). Response: `{ items, page, pageSize, total, totalPages }`. A product whose category exists and is inactive is excluded. `items[]` carries `id, name, description, price, stock, category, images, createdAt`, where `images[]` carries `url, publicId, isPrimary` and `category` is `{ id, name, slug }` or `null`.
- `GET /api/v1/shop/products/:id` — one published product, same shape, 404 when absent or unpublished.

ADMIN only (`JwtAuthGuard` + `RolesGuard` with `Role.ADMIN`; anonymous 401, CLIENT 403):
- `GET /api/v1/shop/admin/products` — every product including unpublished and out-of-stock. Same filters plus `publication` (`all` | `published` | `unpublished`, default `all`).
- `POST /api/v1/shop/admin/products` — create. Body: `name` (required, non-empty), `description` (optional), `price` (required, > 0), `stock` (required, integer >= 0), `categoryId` (optional, must exist), `isPublished` (optional, default true).
- `PATCH /api/v1/shop/admin/products/:id` — partial update of the same fields.
- `POST /api/v1/shop/admin/products/:id/publish` — publish.
- `POST /api/v1/shop/admin/products/:id/unpublish` — unpublish.
- `DELETE /api/v1/shop/admin/products/:id` — delete. 409 when the product is referenced by a historical `OrderItem`; the ADMIN must unpublish instead, so historical prices and historical items are never broken.
- `GET /api/v1/shop/admin/categories` — every category with its product count.
- `POST /api/v1/shop/admin/categories` — create. Body: `name` (required, unique), `slug` (optional, derived from the name when absent, unique), `description` (optional).
- `PATCH /api/v1/shop/admin/categories/:id` — update `name`, `slug`, `description`.
- `POST /api/v1/shop/admin/categories/:id/deactivate` and `POST /api/v1/shop/admin/categories/:id/activate` — deactivate hides the category AND its products from the public catalog; it never deletes products and never touches history.
- `POST /api/v1/shop/admin/uploads/sign` — ADMIN only. Body: `filename` (required), `contentType` (required, one of `image/jpeg`, `image/png`, `image/webp`), `bytes` (required, integer, 1..2097152). Answer: `{ cloudName, apiKey, timestamp, signature, publicId, folder, expiresAt }`. The backend generates the `publicId` (`shop/<uuid>`) so an unassociated upload stays trackable as an orphan. Without Cloudinary configuration the endpoint answers 503 with an explicit message.
- `POST /api/v1/shop/admin/uploads` — ADMIN only, server-side upload. Body: `fileBase64` (required), `filename` (required), `contentType` (required), `bytes` (required). Same format and size rules. The decoded payload is validated against the declared content type and size, then uploaded through the Cloudinary transport.
- `POST /api/v1/shop/admin/uploads/complete` — ADMIN only. Body: `publicId` (required, must be one the backend signed), `url` (required, must be an https URL), `width`, `height`, `bytes`, `format`. Records the reported result and marks the upload associated-ready.
- `POST /api/v1/shop/admin/products/:id/images` — ADMIN only, association. Body: `publicId` (required, must be a publicId the backend signed and that is not already attached to another product), `url` (required, https), `width`, `height`, `bytes`, `format`. Creates the `ProductImage` and marks the `ShopUpload` as `ASSOCIATED`. At most one image is primary; the first image of a product becomes primary automatically.
- `PATCH /api/v1/shop/admin/products/:id/images/:imageId/primary` — ADMIN only. Makes that image the primary one and clears the previous primary.
- `DELETE /api/v1/shop/admin/products/:id/images/:imageId` — ADMIN only. Removes the association and asks the Cloudinary transport to destroy the remote resource.
- `POST /api/v1/shop/admin/uploads/cleanup` — ADMIN only, orphan cleanup. Removes `PENDING` uploads whose `expiresAt` is in the past and asks the transport to destroy the remote resource. Answers with the count of cleaned uploads.

### Ownership boundary between the two parallel units

Unit U1 (catalog) owns `src/modules/shop/catalog/**`: categories, public catalog, ADMIN product CRUD, publication. It reads and writes `Category` and `Product`, and READS `ProductImage` only to project the image list of a product inside a response. It never creates, updates or deletes an image row, and never touches `ShopUpload`.
Unit U2 (uploads) owns `src/modules/shop/uploads/**`: signing, server-side upload, completion, image association, primary image, disassociation, orphan cleanup. It reads and writes `ProductImage` and `ShopUpload`, and reads `Product` only to validate that the target product exists. It never creates, updates or deletes a `Product` or a `Category`.

Neither unit edits `src/prisma/contract.prisma`, `src/prisma/contract.json`, `src/prisma/contract.d.ts`, `migrations/**`, `src/database/prisma.service.ts`, `src/app.module.ts`, `src/main.ts`, `package.json` or `jest.config.ts`.

## Tasks
T0 | S1,S4 | delegated writer: frozen data contract + migration + module skeleton (the shared seam) | pending
T1 | S1,S2 | delegated writer: catalog unit U1 (public catalog, filters, pagination, ADMIN CRUD, categories, publication) | pending
T2 | S3,S5 | delegated writer: uploads unit U2 (signed upload, validation, association, orphan cleanup) | pending
T3 | S5,S6,S7 | inline: contract publication for the frontend, evidence, regression, closure | pending

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

L2 — Human decisions (verbatim answers to the parent's two questions).
Q1 "La issue #32 exige 'integración real imagen→Cloudinary→URL PostgreSQL' y #35 pide 'URLs legítimas Cloudinary'. No hay credenciales de Cloudinary en .env ni en el repo. ¿Cómo procedo?" → "Sin credenciales por ahora".
Q2 "La issue #32 dice 'Coordinar contrato con frontend antes de implementar' y desbloquea las issues #19 y #21 de Kerly. No puedo hablar con Kerly desde acá. ¿Cómo lo manejamos?" → "Backend define y publica".
Consequence: the real Cloudinary upload is NOT proven and must be reported as pending, never as verified (S8). The backend publishes the contract itself (S9).

L3 — Baseline (parent, read-only). `main` @ `13a557e`. Branch `feat/32-shop-catalog-cloudinary` created from it. Worktree `~/.codex/worktrees/issue32-catalog/backend` registered in the same clone. Stack: NestJS 12, Prisma 8 (`src/prisma/contract.prisma`; `pnpm prisma contract emit`; formal migration path `pnpm prisma migration plan --name <slug>` then `pnpm prisma db migrate`; `pnpm prisma db verify` to confirm the marker), Jest. Unit tests are `src/**/*.spec.ts`; the integration suite is `test/*.e2e-spec.ts` run with `pnpm run test:e2e` and the `test/jest-e2e.json` config. CI at `.github/workflows/ci.yml` runs oxlint, build, `test:cov` with global 80% gates, the isolated E2E manifest and Newman.

L4 — Environment repair (parent, executed). The project container `logistica_postgres` (compose project `backend`, volume `backend_postgres_data`) was running detached from any network with no published port, so the host could not reach it. Host port 5432 is published by a DIFFERENT project's container (`practicas-preprofesionales-backend-a3-postgres-1`), so the repository's `.env` pointed at the wrong database. The project container was recreated through the repository's own `docker-compose.yml` with `POSTGRES_PORT=5433`; the same named volume was reused, so all data and the contract marker survived unchanged (marker core hash `eb8ebd14b89f17eea5458cd12220be7bd572fa8f0e3771b68d2089c880e18f83`, 5 users, 13 tables). The repository's local `.env` now points at port 5433. `pnpm prisma db verify` reports "Database marker and schema match contract". No other project's container, volume, worktree or database was modified. This `.env` is local, untracked configuration; `.env.example` is untouched.

L5 — Known environmental failure (parent, observed). `pnpm test` without `--roots src test` fails before any change with a jest-haste-map parse error caused by leftover `.issue13-*` scratch directories inside the repository root from an earlier session. Use `pnpm test --roots src test` for the unit inventory. The integration inventory is `pnpm run test:e2e`. Base unit inventory before this feature: 51 suites, 684 tests, exit 0.

L6 — Route collision note for the writers (parent). The existing `GET /api/v1/products` route belongs to the logistics product list and keeps its exact current meaning. The new Shop catalog lives under `/api/v1/shop/**` and does not replace it. The frontend team consumes `/api/v1/shop/**` for the Shop REGALIA experience.

L7 — T0 scope (parent). T0 owns every shared file, so U1 and U2 can run in parallel with disjoint surfaces: `src/prisma/contract.prisma`, the emitted `src/prisma/contract.json` and `src/prisma/contract.d.ts`, the new migration package under `migrations/app/`, `migrations/snapshots/`, `src/database/prisma.service.ts` (accessors for `Category`, `ProductImage`, `ShopUpload`), `src/app.module.ts` (register `ShopModule`), `src/main.ts` (JSON body limit raised so the server-side upload can carry a base64 payload, with a comment), and the skeleton module files `src/modules/shop/shop.module.ts`, `src/modules/shop/catalog/catalog.module.ts`, `src/modules/shop/uploads/uploads.module.ts`. The skeletons must compile with empty controllers/providers so the build stays green before U1 and U2 land; each writer replaces its own skeleton with the real implementation and keeps the module class name and the exported service name exactly as frozen above.

L8 — Frontend contract published (parent, inline). `docs/shop-api-contract.md` now carries the frozen REST contract for the frontend team: the public catalog, the ADMIN catalog, the ADMIN Cloudinary image flow, the CLIENT checkout, the receipts, the stable error codes and the exact notice string `COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA`. The section "What is not implemented yet" states plainly that the Cloudinary credentials are absent, that the signed-upload and upload endpoints answer 503 until the backend is configured, and that the seeded image URLs do not resolve to a remote asset yet. The document was verified character by character against the issue text. It unblocks the frontend issues #19 and #21 immediately, before the backend implementation lands, and it does not claim any endpoint works before it is implemented.
