## Descripción

Entrega **condicionada** del backend del catálogo v1.2: API pública, CRUD ADMIN, migraciones aditivas y proxy Cloudinary. La implementación tiene verificación técnica y prueba real de ciclo completo; este PR no declara cumplido el DoD externo ni debe cerrarse o fusionarse automáticamente.

## Issue relacionado

Refs #32

Pendientes externos: dataset persistente de ≥200 productos proporcionado por #35 y acuerdo de contrato frontend/QA (#19/#21). Los 200 fixtures de las pruebas aisladas no sustituyen ese dataset.

## Tipo

- [x] Nueva funcionalidad — `type:feature`.

## Cambios realizados

| Unidad | Cambio |
|---|---|
| Datos y compatibilidad | Category/ProductImage/UploadedAsset, centavos exactos, SKU y migraciones versionadas; proyecciones legadas conservadas. |
| Catálogo | Categorías activas, filtros/precios/paginación estable, publicaciones y CRUD ADMIN; representación AdminProduct legada separada. |
| Imágenes | Proxy multipart con decodificación real, reservas durables, procedencia/propiedad/caducidad, galería bajo bloqueo y limpieza con confirmación del proveedor. |
| Contratos | Markdown/OpenAPI v1.2 y errores aprobados; rechazo atómico de retirada/degradación de primaria publicada sin reemplazo válido. |

## Pruebas realizadas

Resultados locales registrados en ejecuciones enfocadas, no una afirmación de inventario completo local:

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | PASS con advertencias | Lint global previo exit 0/7 advertencias; lint focal de los tests nuevos exit 0/7 advertencias. No se afirma cero advertencias. |
| Pruebas unitarias | PASS global local | 69 suites/810 casos; cobertura: sentencias 88,84 %, ramas 81,10 %, funciones 83,22 %, líneas 91,76 %. Umbral global de 80 % intacto; pruebas de comportamiento añadidas, sin excluir código ni cambiar producción. |
| Pruebas de integración | PASS enfocadas | Catálogo HTTP 5/5, uploads 7/7, migración/backup/restore aislada 1/1 y corrección de historial de rutas 6/6 (más 7 unitarios y diferencial independiente). El proveedor doble se identifica como tal. |
| Compilación | PASS | `nest build`, exit 0. |
| Pruebas funcionales | PASS real | ADMIN → Cloudinary real → PostgreSQL propio → publicación → Shop anónimo → imagen decodificada → detach → `cleanupOnce` con proveedor real → confirmación `deleted`, DB `DELETED`, sin asociación. |
| CI completa | NUEVA EJECUCIÓN PENDIENTE | La [última corrida](https://github.com/logistica-gc-uta/backend/actions/runs/40006176585) aprobó calidad/cobertura y pasó 341 casos E2E, pero falló uno por la exposición de subtotalCents en el historial ADMIN. La proyección ya está corregida con unitarios/HTTP/diferencial independientes; los runners legados restantes y Newman todavía no se dieron por aprobados. Falta CI del nuevo commit. |
| Flutter/dispositivo y aceptación frontend | NO EJECUTADO / PENDIENTE | La compatibilidad backend tiene pruebas enfocadas; no se afirma validación manual del cliente ni acuerdo humano del contrato. |

## Evidencias

- `docs/issue-32-v12-data.md`, `docs/issue-32-v12-catalog.md` y `docs/issue-32-v12-uploads.md`.
- `test/catalog-v12-migration.e2e-spec.ts`, `test/catalog-v12-api.e2e-spec.ts`, `test/catalog-v12-uploads.e2e-spec.ts`.
- Revisión independiente del código actual y probe real en copia scratch, sin cambios al worktree original.
- Recurso exclusivo de la prueba exitosa: `regalia/products/62a0b9ea-08cb-4d99-ad90-f86dc6990644`; upload `470bce56-b7ab-4f20-ac01-abd555e9fb74`. Borrado por `cleanupOnce` con confirmación real, sin fallback; contenedor propio eliminado (`docker inspect` exit 1).
- Un primer probe falló por el harness antes de ejecutar limpieza; su recurso exclusivo fue borrado por recuperación dirigida. Ese intento no se cuenta como PASS integrado.
- Credenciales cargadas de forma aislada y autorizada; no hay valores, `.env`, tokens ni firmas en esta entrega. Ninguna migración o purga se ejecutó sobre la base compartida.

## Impacto técnico

**API / Contratos:** rutas Shop/ADMIN nuevas; ADMIN default 10/max 50, público default 12/max 48. `CATEGORY_NOT_FOUND` 404, `PRODUCT_PUBLICATION_INVALID` 409 e `IMAGE_ASSOCIATION_FAILED` 422. `best_selling` declara fallback real a `featured`, sin inventar ventas.

**Base de datos / Migraciones:** cadena formal `eb8ebd14… → 9f73d985… → b263aff9…`; la corrección del default elimina el anterior y coloca `UPLOADING` dentro de la transacción. Artefactos reemitidos por Prisma, no hashes editados manualmente. No desplegada sobre DB compartida.

**Seguridad y permisos:** JWT/ADMIN reales, Cloudinary solo backend, procedencia y uso único de uploads, validación de imágenes, bloqueos y ausencia de despublicación automática ante una operación inválida. Sin cambios de auth #31 ni del hook permanente; bypass puntual GGA autorizado para esta entrega.

**Compatibilidad con otros componentes:** proyecciones de catálogo/pedidos legadas conservadas; no checkout, pagos o comprobantes de #33/#34. El dataset #35 y la aceptación frontend son dependencias, no funcionalidades implementadas anticipadamente.

**Limitaciones conocidas:** dataset persistente y acuerdo frontend/QA pendientes; CI remota y revisión humana pendientes. No merge automático ni cierre de #32. El PR es grande: incluye contratos/snapshots generados y una unidad de catálogo HTTP cohesiva con sus tests. La issue ya tiene `size:exception`; no se agrega automáticamente ninguna etiqueta protegida al PR.

## Checklist de entrega

- [ ] Cumplí todos los criterios de aceptación del Issue — quedan dependencias externas explícitas.
- [x] Implementé únicamente los cambios necesarios para el backend #32.
- [x] Ejecuté las pruebas enfocadas indicadas y la integración real autorizada.
- [x] Verifiqué que el código compile correctamente.
- [x] Comprobé los errores y excepciones cubiertos por los casos registrados.
- [x] Actualicé documentación y contratos.
- [x] No incluí credenciales ni información sensible.
- [x] Adjunté evidencia de los resultados observados.
- [ ] CI remota completa aprobada.
- [ ] Solicité revisión a otro integrante — la revisión técnica independiente de IA no sustituye revisión humana.

## Observaciones para el revisor

Revisar por commits: datos/contratos existentes; default de migración; diagnósticos/redacción del helper; catálogo HTTP y tests; servicios de uploads; wiring HTTP/galería y tests. Prestar atención a conservación de importes históricos, snapshots de lectura, orden de bloqueos y protección de la imagen primaria. Revertir por unidad, sin mezclar datos históricos con cambios de presentación. Mantener este PR condicionado hasta resolver #35 y el acuerdo frontend/QA.

### Corrección de compatibilidad detectada por CI

`e0f326c` conserva el contrato ADMIN/DRIVER de historial: excluye únicamente `subtotalCents` en ambas ramas, sin alterar el Float histórico ni ampliar Swagger. El fixture verificó remoción del contenedor; el ID exacto y un recibo independiente no quedaron capturados porque la consulta acotada de eventos Docker falló (exit 64). Esa limitación de auditoría se registra sin inventar evidencia ni repetir la batería.
