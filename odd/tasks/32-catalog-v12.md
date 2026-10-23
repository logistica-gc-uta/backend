# Issue 32 — Catalog and backend Cloudinary proxy, consolidated v1.2
Branch: `feat/32-catalog-v12`; base `62608a993d0b5f7507d909ff2b5aca6beb37c751` (merged #31). New worktree; obsolete #32 proposals remain untouched.
Scope: #32 only; implementation first, ask before focused tests as in #31; conditional PR authorized, no merge; one-time hook bypass authorized, no permanent hook changes.

## Specs
S1 — Current issue #32, verbatim:

## Objetivo
Ampliar el catálogo NestJS/PostgreSQL para el Shop público de **≥200 regalos**, ofrecer CRUD seguro ADMIN, categorías, publicación, galería y carga real de imágenes vía **Cloudinary proxy en backend**, sin romper el catálogo ni los pedidos legados.

**Responsable:** @Saimol-Uta.

**Proyecto:** REGALÍA — Shop de regalos · **Entrega académica:** 26/11/2026 · **Prioridad:** P0.
**Documentación:** [CI-SHOP-001 v1.2 CONSOLIDADO — decisiones y contratos](https://docs.google.com/document/d/1gvznNw6edcH5AD7vx2Suc2vzEz1GrcBx7D48BOZZuK8/edit) · [ESP-SHOP-001 v1.2 — alcance](https://docs.google.com/document/d/1hPLYkA885tqwjhNWZ08IW7KjSqUPZV1TIAge4_OQ5SQ/edit) · [Figma — referencia visual opcional](https://www.figma.com/design/Gt0COrpEq6AXBSWrZ21ejX).

> **Jerarquía:** CI-SHOP-001 v1.2 CONSOLIDADO prevalece para envío gratuito, IVA ficticio configurable, límites, horario Ecuador, dinero en centavos y contratos nuevos. ESP-SHOP-001 v1.2 conserva el resto del alcance. Figma NO define permisos, DTO ni importes. **Los endpoints Shop v1.1 aquí descritos son contratos objetivo, NO se afirma que existan en `main`.** Actualizar Swagger/OpenAPI y acordar contrato tipado con Kerly antes de integrar. No reemplazar ni romper las rutas logísticas existentes, ni cerrar sin pruebas.


## Estado actual y compatibilidad OBLIGATORIA
- `Product` actual solo tiene `id,name,description,price Float,stock,createdAt`. Actualmente `GET /api/v1/products` devuelve arreglo de productos con **stock > 0**, sin categorías ni imágenes; `POST /api/v1/products` y `PATCH /api/v1/products/:id/stock` ya funcionan para ADMIN.
- **No sobrescribir** ni cambiar de golpe el shape/semántica de `GET /products`; crear endpoints Shop públicos paginados y ADMIN completos separados. Seguir permitiendo pedidos administrativos y precios históricos.
- El precio de cada producto **YA INCLUYE EL ENVÍO**: enviar gratis, `shipping.amountCents=0`; no crear recargos ni tarifas de reparto.

## A. Modelo de datos y migración segura
- [ ] Crear/adaptar modelos y migración versionada para `Category`, `ProductImage`, producto con `sku` único, `categoryId`, `isPublished`, `isFeatured`, `updatedAt`, precio exacto `priceCents` y demás relaciones/índices. `Category`: `id,name,slug,description?,isActive,sortOrder,createdAt,updatedAt`; `ProductImage`: `id,productId,publicId,secureUrl,altText,position,isPrimary`.
- [ ] Regla nueva: `ProductShop` entrega `id,sku,name,description,categoryId,category,priceCents,currency:"USD",stock,isPublished,isFeatured,images,primaryImageUrl,isAvailable,createdAt,updatedAt`, como contrato tipado para frontend. Solo **una** imagen primaria/producto; máximo de galería conforme al contrato (propuesta 6).
- [ ] **Migración aditiva**, no sustitución destructiva: respaldar tablas; añadir columnas enteras de centavos, inspeccionar `Product.price`, `Order.total`, `OrderItem.price` `Float` existentes; detectar valores con más de dos decimales y documentar corrección manual/criterios, sin redondear silenciosamente historial.
- [ ] Reconciliar importes nuevos con históricos, migraciones reproducibles con verificación y rollback; no aplicar IVA simulado a ventas antiguas ni cambiar semántica legada de `Order.total` (subtotal histórico), mantener compatibilidad con proyección/frontend vigente.
- [ ] Claves/índices para `sku`, `slug`, publicación/categoría y posición de imágenes; impedir stock negativo y precios monetarios no representables; contratos de error claros.

## B. Catálogo PÚBLICO (nuevos contratos)
- [ ] `GET /api/v1/shop/categories`: categorías activas visibles, respuesta `{items:[{id,name,slug,description,productCount,sortOrder}]}`; nunca exponer desactivadas como opciones nuevas.
- [ ] `GET /api/v1/shop/products`: paginación servidor `page` (default 1), `pageSize` (default 12, rango 1..48), filtros `search`, `categoryId`, `minPriceCents/maxPriceCents`, `inStock`, `sort` (`featured|recent|price_asc|price_desc|best_selling` condicionado a ventas verdaderas); respuesta `{items,total,page,pageSize,totalPages,sortApplied}`.
- [ ] Búsqueda por nombre/descripción, filtros combinados, orden estable con desempate (ID), precios exactos sin filtros `Float`, conteo/páginas coherentes; productos agotados publicados pueden aparecer si `inStock=false`, con `isAvailable=false`.
- [ ] `GET /api/v1/shop/products/:id`: producto publicado + categoría activa, galería y stock incluso si es 0; 404 no existe/despublicado/categoría inactiva, sin filtrar datos ADMIN o secretos.
- [ ] Contar ≥200 registros reales persistidos proporcionados por [#35](https://github.com/logistica-gc-uta/backend/issues/35), no generar tarjetas simuladas frontend; «Más vendidos» solo si existe métrica real.

## C. Catálogo ADMIN (JWT + Role=ADMIN, sin CRUD público)
- [ ] `GET /api/v1/admin/catalog/products`: paginado, incluye **stock 0** y despublicados; filtros `status:all|published|unpublished|out_of_stock`, búsqueda/categoría si acordados.
- [ ] `POST /api/v1/admin/catalog/products`: DTO `sku,name,description,categoryId,priceCents,stock,isFeatured?,isPublished?`; creación **despublicada por defecto**; validar campos, precio >=1 centavo, stock entero >=0, SKU/categoría válidos.
- [ ] `GET/PATCH /api/v1/admin/catalog/products/:id`: consulta detallada y cambios seguros de campos permitidos; no permitir editar IDs, históricos, SKU inmutable ni claves internas.
- [ ] `PATCH /api/v1/admin/catalog/products/:id/publication` con `{isPublished:boolean}`: publicar solo si hay categoría activa, precio/nombre válidos e imagen primaria confirmada. Despublicar no borra compras previas.
- [ ] `GET/POST /api/v1/admin/catalog/categories` y `PATCH /api/v1/admin/catalog/categories/:id`: nombre/slug únicos, editar/activar/desactivar, sin borrado destructivo de datos históricos; validar efectos sobre productos publicados.
- [ ] Gestionar errores: 400 validación, 401 anónimo, 403 CLIENT/DRIVER, 404 inexistente, 409 SKU/category slug duplicado o publicación inválida según catálogo de errores estable del contrato.

## D. Cloudinary — decisión aprobada: **proxy desde backend**
- [ ] `POST /api/v1/admin/catalog/uploads`, ADMIN autenticado, `multipart/form-data` campo `file`; NestJS valida tamaño (máximo propuesto 5 MiB), tipo real JPEG/PNG/WebP, dimensiones límite, evita payloads falsificados y uso abusivo.
- [ ] Backend sube archivo al proveedor con secretos **solo del servidor**, obtiene `secureUrl/publicId` válidos, guarda upload temporal asociado a actor/estado y devuelve `{uploadId,secureUrl,publicId,format,bytes,width,height,status:"UPLOADED"}`. Nunca dar firma larga/API secret al navegador.
- [ ] `POST /api/v1/admin/catalog/products/:id/images` usa **`uploadId` verificado**, `altText`, `isPrimary`, `position`; backend valida propiedad/procedencia, caducidad y uso único; nunca confiar en `publicId` o URL arbitraria enviada por React.
- [ ] `PATCH/DELETE /api/v1/admin/catalog/products/:id/images/:imageId` para metadata/orden/principal/remoción, respetando único principal, contratos de imagen y limpieza segura de huérfanos. No borrar imágenes que deban conservarse en snapshots/recibos.
- [ ] Falla Cloudinary o asociación no declara éxito, no publica producto incoherente, expone error estable y plan de limpieza/reintento; ningún endpoint de upload/edición accesible a CLIENT o visitante.

## E. Tests / compatibilidad / entregables
- [ ] Tests filtros/paginación orden, 200 productos, categoría inactiva, agotados, publicación/retirada, SKU duplicado, imagen primaria, múltiples imágenes y validación.
- [ ] Tests 401/403 de cada mutación, intento de asociación de `publicId` arbitrario, MIME/bytes erróneos, error/proveedor y recuperación sin huérfanos.
- [ ] Prueba integrada ADMIN→Cloudinary→PostgreSQL→GET Shop, con cuenta/entorno autorizado y evidencia (sin secretos en logs).
- [ ] Pruebas migración centavos, precios antiguos/historial, rollback/consistencia y compatibilidad `/products`, `/orders/admin` y Flutter.
- [ ] Swagger/OpenAPI 3.1 tipado y DTO compartidos con [frontend #19](https://github.com/logistica-gc-uta/frontend-web-logistica/issues/19) y [#21](https://github.com/logistica-gc-uta/frontend-web-logistica/issues/21); contratos definitivos acordados antes de integrar.

## Plan sugerido de PRs
1. `#32-A`: migraciones, Category/Product/Image, índices, centavos/backfill auditado.
2. `#32-B`: API pública catálogo/categorías + filtros/paginación + tests.
3. `#32-C`: endpoints CRUD/publicación ADMIN + tests RBAC.
4. `#32-D`: uploads Cloudinary proxy, galería, limpieza y pruebas de integración.

## Definition of Done
- [ ] Cada PR referencia **#32**, migraciones reproducibles, documentación y evidencia, CI aprobado; revisión humana, sin merge automático.
- [ ] No afectar API ADMIN original ni cuentas/órdenes históricas; no inventar Cloudinary URLs ni credenciales para seeder.

**Dependencias:** auth [#31](https://github.com/logistica-gc-uta/backend/issues/31) para seguridad; pruebas/200 productos [#35](https://github.com/logistica-gc-uta/backend/issues/35); frontend #19 y #21.


S2 — Authoritative source paths (verbatim): `docs/CI-SHOP-001-v1.2-CONSOLIDADO.md`; `docs/REGALIA-SHOP-OPENAPI-v1.2.yaml`. Read the relevant definitions and references; do not implement prior adendas/drafts.
S3 — "trabaja únicamente en el alcance de la Issue #32. No implementes anticipadamente el checkout, los pagos simulados ni los comprobantes de las Issues #33 y #34, salvo las dependencias estructurales estrictamente necesarias."
S4 — "sigamos con la misma dinamica que hicimos con la issue 31, ignoramos el hook porque es la primera vez que lo veo."
S5 — "cuando todo este correctamente implementado realiza el PR de la issue y ahorra cuota(pero si es necesario realizar e importante para la implementacion si puedes usar mas couta)"

S6 — Approved contract reconciliation (user selection): "Aprobar la conciliación propuesta". Define an explicit AdminProduct representation permitting incomplete legacy fields only; public ProductShop remains strict. Adopt YAML ADMIN pagination default10/max50 and Markdown nullable category description. Document/adjust specific OpenAPI definitions, never silently coerce legacy data.

## Tasks
T0 | S1-S5 | delegated read-only exploration: current code + v1.2 contract map/discrepancies | done | mvkneem7-5-56x3
T1 | S1-S3 | delegated (context backstop): safe versioned schema/cents seam and legacy compatibility | in_progress | no shared DB mutation authorized
T2 | S1-S3 | delegated parallel unit: public/ADMIN catalog, categories and publication | in_progress | no source edits yet
T3 | S1-S3 | delegated parallel unit: ADMIN multipart Cloudinary proxy/gallery/cleanup | in_progress | real provider proof must not be fabricated
T4 | S1-S5 | parent: obtain focused test authorization, verify migrations/RBAC/compatibility and independent high-risk checks | pending | tests not run
T5 | S1-S5 | parent: docs/evidence/commits and conditional PR, no merge | pending | human review/CI pending

## Log
L1 — Original user request, verbatim:

Implementa la **Issue #32 — Catálogo de productos, categorías, Cloudinary y CRUD ADMIN**.

**Issue:** https://github.com/logistica-gc-uta/backend/issues/32

`La Issue #31 ya fue implementada, por lo que puedes continuar con la #32. ya se hizo merge `

### Especificaciones obligatorias

Toda la información necesaria está en estas tres fuentes:

1. **Issue #32:** contiene las tareas, requisitos, dependencias y criterios de aceptación.
2. **`docs/CI-SHOP-001-v1.2-CONSOLIDADO.md`:** contiene el contrato técnico completo, modelos, campos, reglas de negocio, validaciones y compatibilidad.
3. **`docs/REGALIA-SHOP-OPENAPI-v1.2.yaml`:** contiene las especificaciones OpenAPI de los endpoints, DTO, solicitudes, respuestas y errores.

Ambos documentos ya están descargados y disponibles en la carpeta `docs/` del repositorio. Utilízalos como fuentes de implementación, no necesitas consultar las versiones anteriores ni las adendas.

### Indicaciones de implementación

- Revisa primero el estado actual del código, las migraciones, los servicios existentes y los cambios incorporados en la Issue #31.
- Implementa todos los requisitos correspondientes a la #32, respetando los contratos definidos en los documentos.
- Mantén la compatibilidad con los endpoints existentes, los pedidos históricos y las funcionalidades logísticas.
- Utiliza migraciones seguras y versionadas, sin modificar ni perder datos existentes.
- Implementa la integración Cloudinary exclusivamente mediante el backend y con permisos ADMIN.
- Coordina los DTO y endpoints públicos con el contrato que utilizará el frontend.
- Añade y ejecuta las pruebas unitarias, de integración, seguridad y regresión correspondientes. (la misma dinamica que hizimos con la issue 31 solo las pruebas necesarias no todas)
- Si encuentras discrepancias entre la Issue, el Markdown, el YAML y el código existente, identifícalas y resuélvelas justificadamente, sin inventar campos ni cambiar contratos silenciosamente.

**Forma de trabajo:* utiliza una rama dedicada, documenta las decisiones técnicas y no realices merge automático.

Al finalizar, entrega un resumen de los cambios, migraciones, endpoints implementados, pruebas ejecutadas, resultados y riesgos pendientes.

**Importante:** trabaja únicamente en el alcance de la Issue #32. No implementes anticipadamente el checkout, los pagos simulados ni los comprobantes de las Issues #33 y #34, salvo las dependencias estructurales estrictamente necesarias.

sigamos con la misma dinamica que hicimos con la issue 31, ignoramos el hook porque es la primera vez que lo veo.
cuando todo este correctamente implementado realiza el PR de la issue y ahorra cuota(pero si es necesario realizar e importante para la implementacion si puedes usar mas couta)

L2 — Baseline observed: remote PR36 MERGED at62608a993d0b5f7507d909ff2b5aca6beb37c751; fetched origin/main and created fresh same-clone worktree `/home/saimoljimenez/.codex/worktrees/issue32-v12/backend`, branchfeat/32-catalog-v12. Source MD/YAML copied exactly from user-provided untracked docs into this worktree; original dirty .gitignore, prior#31 final ledger and unrelated old drafts/worktrees preserved. No old#32/#33 branch reused. Issue32 has status:approved/type:feature/size:exception. No tests/builds/migrations/install executed.

L3 — Explorer mvkneem7-5-56x3 map reviewed against source snippets MD§§3/5/6/7, YAML ProductShop/category/admin pagination. Human approved reconciliation S6. No application tests or sharedDB probes executed. Next shared schema/compatibility seam before parallel endpoint units.

L4 — Conditional purge authorization (user, verbatim): "si ves que es necesario eliminar los productos antiguos para una correcta implementacion, tienes autorizacion de eliminar los registro y crear nuevos desde cero.
purgar la base de datos , pero ten en cuanta que tiene que eliminar todos los registro relacionados al producto". Parent decision: no necessity demonstrated, preserve additive implementation. This authorizes destructive recovery only if necessary; no DB purge executed or delegated. Identify exact target DB, related records/history impact and backup before any destructive action; unrelated databases excluded.

L5 — T1 implementation report (mvknu4jx-6-wuia), NOT VERIFIED: generated formal edgeeb8ebd14→9f73d985 plus exact-decimal backfill, nullablehistoricalcents, explicitlegacyprojection/dualwrites,module skeletons,YAMLAdminProductreconciliation,runbook/tests authored. No DBcontact/tests/build. Parent structural review found missing Category.nameunique and nondurable provider-success/DBfailure orphan recovery. Correction mvko7ew6-7-p23j adds unique name and uploadreservationUPLOADING beforeprovider(nullableURLuntilsuccess), consistent lockorder and updatedAtwrites; generate a second formal edge instead of handediting operationJSON or oldpackages. No purge needed or executed. Shared seam not frozen until this correctionreturns.

L6 — Shared seam structurally reviewed: finalhashb263aff9; firstedge30ops(additive+data), second5ops(additive/widening/CHECKreplacementdestructiveclass,no table/column/rowdrops). StillUNVERIFIED/noDBapply. Added small controller-scoped Shop HTTP error seam matching YAMLApiError without touching auth31/legacyerrors. T2/T3 now run inparallel with disjointmodules/tests/docs; T3alone ownsdependencyfiles fordecoder/proxy. Tests stillawaitexplicitpermission. Sharedschema cannotchange underendpointworkers withoutparentreconciliation.

L7 — Imported consolidated Markdown had trailing whitespace; normalized only the worktree copy on import (source contract values unchanged), original downloaded file preserved. Verbatim request line with a trailing space enclosed in code to preserve text without trailing EOL whitespace.
