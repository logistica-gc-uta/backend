# Issue #35-A — Catálogo reproducible de 200 regalos

Datos de demostración para probar la tienda (Shop v1.2) con un catálogo realista. Todo es **sintético**: ningún dato personal, ninguna tarjeta real.

## Qué crea el seed

| Elemento | Detalle |
|---|---|
| Categorías | 10 temáticas (Navidad, Cumpleaños, San Valentín, Aniversarios, Graduaciones, Nacimientos, …) |
| Regalos | 200 = 10 categorías × 20. SKU único `RG-XXX-NNN`, nombre único, descripción sin enlaces, precio en centavos |
| Stock | Reproducible por SKU: 11 agotados exactos (stock 0), 24 con 1–5 unidades y el resto con 10–120 |
| Destacados | 2 por categoría |
| Imágenes | Una por regalo en Cloudinary (carpeta `regalia/demo/`), adjuntas como imagen principal |
| Tarjetas | Las 3 tarjetas demo (`DEMO_APPROVED`, `DEMO_LIMITED`, `DEMO_EMPTY`) con saldo persistente, solo con `NODE_ENV=test\|demo` y `SIMULATED_PAYMENTS_ENABLED=true` |

La paginación pública de 12 da **17 páginas y la última trae 8 regalos** (CT-002).

## Idempotencia

Todo se identifica por clave natural (slug, SKU, publicId, fixtureId) con `INSERT … ON CONFLICT DO NOTHING`.
Una segunda ejecución no crea ni cambia nada y **nunca pisa** lo que alguien modificó después:

- stock, precio y publicación de un regalo;
- una imagen que el ADMIN ya eligió (solo se adjunta si el regalo no tiene imagen);
- el saldo de una tarjeta ya gastada.

Un regalo se publica únicamente cuando esa ejecución le dejó imagen; si un ADMIN lo despublica, sigue despublicado.

## Cómo usarlo

```bash
pnpm seed                      # crea el ADMIN admin@delivery.com (lo necesita el paso de imágenes)
pnpm seed:shop-images          # simulación: dice cuántas imágenes faltan, no sube nada
pnpm seed:shop-images --upload # genera y sube las pendientes a Cloudinary (reanudable)
pnpm seed:shop-demo            # siembra categorías, regalos, imágenes y tarjetas
```

- `seed:shop-images --upload` lee `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` y `CLOUDINARY_API_SECRET` **solo del `.env` local** y nunca los imprime.
- Las imágenes son tarjetas ilustrativas generadas por el script (degradado del color de la categoría y una forma que sale del SKU). No son fotos reales del producto.
- Los datos de cada imagen quedan en `src/prisma/shop-demo/images.json` (solo URLs públicas, sin secretos). Mientras ese archivo exista, `seed:shop-demo` lo usa; sin él, los regalos se crean **sin publicar** y el catálogo público queda vacío.
- `SHOP_DEMO_ADMIN_EMAIL` cambia el ADMIN autor de las imágenes (por defecto `admin@delivery.com`).

## Verificación

| Prueba | Resultado |
|---|---|
| `shop-demo/dataset.spec.ts` (13) y `images-manifest.spec.ts` (17) | PASS |
| `shop-demo/png.spec.ts` (4) | PASS |
| `test/shop-demo-seed.e2e-spec.ts` (7, PostgreSQL real en contenedor propio) | PASS |
| `tsc --noEmit` | PASS |
| `pnpm lint` | 0 errores (advertencias previas ajenas a estos archivos) |
| 3 imágenes (primera, intermedia, última) con `HEAD` público | 200 `image/png` |

El e2e cubre: 10 categorías y 200 regalos sin publicar; segunda ejecución sin cambios; 30 imágenes ⇒ 30 públicos; no pisa stock/precio/publicación; no reinicia el saldo de una tarjeta; con las 200 imágenes pagina en 17 páginas (última de 8) y las 200 son alcanzables.

## Limitaciones

- No se ejecutó `seed:shop-demo` contra la base de desarrollo local (puerto 5434) porque no tenía aplicadas las migraciones de la tienda; la verificación se hizo en una base efímera propia.
- Las tarjetas demo no se crean fuera de `test`/`demo`.
