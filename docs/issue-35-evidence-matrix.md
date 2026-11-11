# Issue #35 — Matriz de evidencia (CI-SHOP-001 v1.2 §15)

Resultados **ejecutados** sobre PostgreSQL 16 real en contenedores propios (Windows 11, Node 26). Los casos CT se ejecutaron el 2026-11-04; el 2026-11-10 se reintegraron las ramas sobre `main` (commit `2eb0230`) y se repitió la suite e2e completa (ver abajo). Nada se marca PASS sin haberse ejecutado; lo que no se pudo ejecutar figura como BLOCKED con su motivo.

## Resumen de ejecución

| Conjunto | Resultado |
|---|---|
| e2e autónomos (33 suites sin las 3 heredadas), tras reintegrar sobre `main` | **517 de 520 PASS** en la corrida completa. Las 3 que fallaron son de `realtime.e2e-spec` (Issue 13, no tocada por #35): `reconnects and resynchronizes…` devolvió 500; ejecutada sola pasa 9/9. Se registra como intermitente (H-4), sin causa confirmada |
| de ellos, nuevos de #35 | seed 7 · contrato 13 · concurrencia 7 · contrato OpenAPI 10 · migración +1 |
| Unitarias (84 suites, 982 pruebas) | 940 PASS · 42 FAIL, todos preexistentes en Windows (ver «Fallos conocidos») |
| Cobertura unitaria | líneas 89,3 % · funciones 84,6 % · ramas 80,3 % (exigido ≥ 80 %) |
| `tsc --noEmit` / `pnpm lint` | sin errores |

## Matriz CT-001 … CT-043

Leyenda: **PASS** ejecutado y correcto · **PASS (parcial)** ejecutado, con un subcaso que no se ejecutó (indicado) · **BLOCKED** no ejecutable desde este repositorio.

| ID | Resultado | Evidencia (archivo e2e/unit) |
|---|---|---|
| CT-001 | PASS | `shop-contract-matrix-v12` |
| CT-002 | PASS | `shop-contract-matrix-v12`, `shop-demo-seed` (17 páginas, última de 8, sin duplicados, orden estable) |
| CT-003 | PASS | `shop-contract-matrix-v12` (`isAvailable=false`, `inStock=true` lo oculta) |
| CT-004 | PASS | `shop-contract-matrix-v12`, `shop-quote-v12` |
| CT-005 | PASS | `shop-contract-matrix-v12` (categoría + precio + búsqueda; rango inválido 400) |
| CT-006 | PASS | `issue31-auth` (registro con `role` ADMIN/CLIENT/DRIVER → 400, sin cuenta creada) |
| CT-007 | PASS | `shop-contract-matrix-v12`, `shop-orders-v12` |
| CT-008 | PASS | `shop-quote-v12` (contacto, fecha, zona y coordenadas nulos/ausentes → 400/422 tipificado) |
| CT-009 | PASS | `shop-quote-v12` (fecha sin offset y fecha pasada), `shop-concurrency-matrix-v12` (la fecha vence mientras la compra espera el bloqueo del producto: 422 `DELIVERY_INVALID`, sin cobro, stock ni registros) |
| CT-010 | PASS | `shop-checkout-v12` |
| CT-011 | PASS | `shop-checkout-v12`, `shop-checkout-concurrency-v12` |
| CT-012 | PASS | `shop-checkout-v12`, `simulated-card.spec` |
| CT-013 | PASS | `shop-contract-matrix-v12`, `shop-checkout-v12` |
| CT-014 | PASS | `shop-checkout-v12` (2 compradores), `shop-concurrency-matrix-v12` (12 compradores, stock 5) |
| CT-015 | PASS | `shop-checkout-concurrency-v12`, `shop-concurrency-matrix-v12` (10 compras, saldo 2000) |
| CT-016 | PASS | `shop-contract-matrix-v12`, `shop-checkout-v12` (rollback con trigger de fallo) |
| CT-017 | PASS | `shop-checkout-v12`, `shop-concurrency-matrix-v12` (8 reintentos simultáneos) |
| CT-018 | PASS | `shop-checkout-v12` |
| CT-019 | PASS | `shop-checkout-recovery-v12` (respuesta perdida tras commit) |
| CT-020 | PASS | `shop-checkout-v12`, `shop-checkout-recovery-v12` |
| CT-021 | PASS | `shop-orders-v12`, `shop-checkout-recovery-v12` |
| CT-022 | PASS | `catalog-v12-api` |
| CT-023 | PASS | `catalog-v12-uploads` |
| CT-024 | PASS | `catalog-v12-uploads` (proveedor simulado); subida real: 200 imágenes por `seed:shop-images` |
| CT-025 | PASS | `catalog-v12-uploads` |
| CT-026 | PASS | `catalog-v12-uploads` |
| CT-027 | PASS | `shop-checkout-recovery-v12`, `shop-orders-v12` |
| CT-028 | BLOCKED | Requiere la app Flutter (otro repositorio) |
| CT-029 | PASS | `shop-demo-seed` |
| CT-030 | PASS (parcial) | `issue31-auth`, `route-*`, `urgent-dispatch`, `realtime`. **No ejecutado:** `app`, `orders-security`, `drivers-routes-security` (las lanza el runner aislado, que en Windows falla por `pnpm`) |
| CT-031 | BLOCKED | Requiere el frontend React |
| CT-032 | BLOCKED | La política de reversión está diferida por decisión del contrato; no hay comportamiento que probar |
| CT-033 | PASS | `shop-settings-v12`, `shop-quote-v12` |
| CT-034 | PASS (parcial) | `shop-quote-v12`, `shop-checkout-v12`, `shop-orders-v12` (7300 + 1095 = 8395; leyenda en comprobante). **No ejecutado:** etiqueta en la interfaz |
| CT-035 | PASS | `shop-contract-matrix-v12` |
| CT-036 | PASS | `shop-contract-matrix-v12`, `shop-orders-v12` |
| CT-037 | PASS | `shop-quote-v12`, `shop-contract-matrix-v12` (10 acepta; 11 y 6+5 rechazan sin cambios) |
| CT-038 | PASS (parcial) | `shop-contract-matrix-v12` (backend rechaza 6 con máximo 5). **No ejecutado:** actualización del frontend |
| CT-039 | PASS | `shop-quote-v12` (06:59 ✗, 07:00 ✓, 17:00 ✓, 17:01 ✗) |
| CT-040 | PASS | `shop-contract-matrix-v12`, `shop-settings-v12`, `shop-concurrency-matrix-v12` (cambio de horario por el ADMIN: la cotización anterior da `SHOP_SETTINGS_CHANGED` sin cobro; la nueva rechaza 10:00 con 08:00–09:00 y acepta 08:30 y compra) |
| CT-041 | PASS | `shop-checkout-v12`, `shop-contract-matrix-v12`, `shop-concurrency-matrix-v12` |
| CT-042 | PASS | `catalog-v12-migration` (backfill exacto; importes con más de dos decimales —0,005, 2,675 y 12,345— quedan sin centavos y los identifica la consulta de auditoría, sin truncar; históricos intactos tras migrar; el rollback desde el respaldo devuelve los mismos importes sin columnas de centavos) |
| CT-043 | PASS | `shop-settings-v12` |

**Totales:** 37 PASS · 3 PASS (parcial) · 3 BLOCKED (CT-028, CT-031, CT-032) · 0 FAIL, de 43. Los 3 parciales (CT-030, 034, 038) tienen el subcaso pendiente indicado: las suites heredadas (solo corren bien en Linux/CI) y la etiqueta/actualización en las interfaces web.

## Validación del OpenAPI candidato (`docs/REGALIA-SHOP-OPENAPI-v1.2.yaml`)

Pedida por el comentario de contratos del issue. Dos suites nuevas:

- `test/shop-openapi-document.spec.ts` (unitaria, 6 pruebas, PASS): OpenAPI 3.1, base `/api/v1`, todas las referencias `$ref` resuelven, `operationId` únicos, toda operación declara una respuesta 2xx y esquemas de seguridad existentes, parámetros de ruta declarados y los 59 esquemas compilan como JSON Schema 2020-12 (Ajv).
- `test/shop-openapi-contract.e2e-spec.ts` (e2e sobre PostgreSQL real, 10 pruebas): valida con Ajv el cuerpo **real** de cada respuesta contra el esquema que el contrato declara para ese método, ruta y estado. Cubre registro, login, catálogo público y administrativo, ajustes, quote, checkout, intento, pedidos, comprobante y errores 401/403/409/422 (`ApiError`).

Resultado: 9 PASS y 1 desvío documentado (D-4). El contrato es la autoridad: la prueba no se relajó.

| ID | Severidad | Hallazgo | Estado |
|---|---|---|---|
| D-4 | Media | `GET /shop/orders` devuelve `primaryProductId` en cada item (commit `d9319a8`, miniaturas de pedidos) y el esquema `OrderSummary` tiene `additionalProperties: false` sin ese campo. Un consumidor que valide contra el contrato rechazaría la respuesta | Abierto: backend debe agregar el campo al contrato (o quitarlo de la API). La prueba usa `it.failing`: el CI sigue en verde y se pondrá rojo cuando se corrija, para cambiarla a `it` |

## CP-SHOP-001 … CP-SHOP-034

La definición de estos casos **no está en el repositorio** (solo se menciona `CP-SHOP-016..018,026..029` en `odd/tasks/34-shop-receipts-v12.md`). No se mapean ni se marcan para no inventar resultados. Pendiente: recibir el listado.

## Defectos y hallazgos

| ID | Severidad | Hallazgo | Estado |
|---|---|---|---|
| D-1 | Alta | Las suites de Shop tenían fechas de entrega fijas (`2026-11-15`, 42 ocurrencias): desde esa fecha la cotización las rechaza por «fecha pasada» y el CI se pone en rojo | Corregido: fechas movidas a 2030 (102 pruebas PASS). Conviene generarlas dinámicamente |
| D-2 | Media | En Windows los fixtures no encuentran `pnpm` (`spawnSync pnpm ENOENT`): 4 suites (136 pruebas) no podían correr | Corregido en los dos fixtures, solo ante ENOENT |
| D-3 | Baja | `ci-security.spec.ts` fija el número de suites e2e; al agregar suites hay que actualizarlo | Corregido: 37 (33 de `main` + 4 de #35) |
| H-1 | Informativo | El reintento idempotente devuelve el mismo contenido pero con otro orden de claves JSON | Sin acción |
| H-2 | Informativo | `PATCH /admin/shop-settings` espera a las compras en curso (checkout toma los ajustes `FOR SHARE`); la compra en curso conserva los ajustes con los que se cotizó | Comportamiento correcto, cubierto por prueba |
| H-3 | Informativo | Con 12 compradores simultáneos no hubo bloqueos ni agotamiento del pool | Sin acción |
| H-4 | Media | `realtime.e2e-spec` falló una vez (500 al resincronizar tras reconectar) dentro de la corrida completa y pasó 9/9 al repetirla sola. No es parte de #35, pero conviene repetirla en CI (Linux) para descartar una condición de carrera | Abierto: sin causa confirmada |

## Fallos conocidos (preexistentes, solo Windows)

42 pruebas unitarias fallan igual con y sin los cambios de #35: `prisma-legacy-rawsql-compat` (21), `geolocation-migration.fixtures.spec` (16), `run-newman-isolated` (4) y 1 de `ci-security` (corregida). Dependen de bash, rutas POSIX o ejecutables falsos que Windows no resuelve; en CI (Linux) corren.
