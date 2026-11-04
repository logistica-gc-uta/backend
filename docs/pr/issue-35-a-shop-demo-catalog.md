## Descripción

Primera parte de #35: catálogo de demostración reproducible de 200 regalos en 10 categorías temáticas, con un seeder idempotente sobre PostgreSQL, imágenes reales en Cloudinary y las 3 tarjetas demo con saldo persistente.

## Issue relacionado

Refs #35

## Cambios realizados

- Dataset puro de 200 regalos (SKU único, descripción, precio en centavos, stock variado con 11 agotados, 2 destacados por categoría).
- Seeder `seedShopDemo` con `ON CONFLICT DO NOTHING`: no pisa stock, precio, publicación, imágenes ni saldos.
- Script `seed:shop-images`: genera una imagen por regalo y la sube con el proveedor firmado de la API; reanudable, con simulación por defecto.
- Manifiesto `images.json` validado (solo URLs públicas de Cloudinary) y script `seed:shop-demo`.
- Documentación en `docs/issue-35-shop-demo-catalog.md`.

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | PASS (0 errores) | `pnpm lint`, `tsc --noEmit` |
| Pruebas unitarias | PASS (34) | dataset 13, manifiesto 17, PNG 4 |
| Pruebas de integración | PASS (7) | `test/shop-demo-seed.e2e-spec.ts`, PostgreSQL real en contenedor propio |
| Compilación | PASS | `tsc --noEmit` |
| Pruebas funcionales | PASS | 3 imágenes públicas responden 200 `image/png`; catálogo público de 17 páginas, última de 8 |

## Evidencias

Salida de Jest del e2e y de los scripts en el comentario del PR.

## Impacto técnico

**API / Contratos:** sin cambios.

**Base de datos / Migraciones:** sin migraciones; solo inserciones de datos.

**Seguridad y permisos:** las credenciales de Cloudinary se leen solo del `.env` local y no se imprimen; las tarjetas demo solo en `test`/`demo` con `SIMULATED_PAYMENTS_ENABLED=true`.

**Compatibilidad con otros componentes:** el catálogo público muestra los 200 regalos una vez ejecutado el seed.

**Limitaciones conocidas:** las imágenes son ilustraciones generadas, no fotos del producto; `seed:shop-demo` no se ejecutó contra la base de desarrollo local por falta de migraciones.

## Checklist de entrega

- [x] Cumplí los criterios de aceptación del Issue (parte A).
- [x] Implementé únicamente los cambios necesarios.
- [x] Ejecuté las pruebas correspondientes.
- [x] Verifiqué que el código compile correctamente.
- [x] Comprobé los posibles errores y excepciones.
- [x] Actualicé la documentación cuando fue necesario.
- [x] No incluí credenciales ni información sensible.
- [x] Adjunté evidencia de los resultados.
- [ ] Solicité revisión a otro integrante.

## Observaciones para el revisor

`images.json` apunta a la cuenta de Cloudinary del equipo; si cambia la cuenta, borrarlo y volver a ejecutar `seed:shop-images --upload`.
