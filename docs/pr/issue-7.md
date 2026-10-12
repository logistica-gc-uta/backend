## Descripción

Conecta la heurística Clarke & Wright (`planRoutes()`, PR #4) con PostgreSQL mediante un endpoint administrativo de **solo lectura** que propone rutas para un día. Separa **proponer** de **persistir/asignar**: la propuesta es temporal y no escribe nada; confirmarla (DRAFT) y asignarla siguen siendo las operaciones ya existentes del #10.

## Issue relacionado

Closes #7

## Cambios realizados

- `GET /api/v1/route-proposals?date=YYYY-MM-DD[&zoneId=…]` (solo ADMIN, JWT + rol): toma los pedidos `PENDING` programados ese día en `America/Guayaquil`, los agrupa por zona y devuelve propuestas de máximo 4 paradas que salen y regresan al depósito de su zona.
- Los pedidos que no se pueden planificar **no se ocultan**: salen en `excluded` con su razón (coordenadas ausentes o inválidas, zona sin depósito, reserva activa, revisión administrativa).
- Trazabilidad de la distancia: `distanceMethod = HAVERSINE_STRAIGHT_LINE`, `totalDistanceKm` ida y vuelta.
- Cada propuesta informa `scheduledInstants`, `confirmable` y `routeDate` para saber si `POST /routes` la acepta tal cual (ver Limitaciones).
- Límite de 2 000 pedidos planificables por zona (`422`), por el costo cuadrático del algoritmo.
- `pnpm run seed:planning-demo`: pedidos DEMO/TEST con coordenadas, idempotentes, sin tocar registros existentes.
- Carpeta `06-Planning` en la colección de Newman (21 requests) y documentación en `docs/route-planning.md` (Swagger incluido en el controlador y los DTO).

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | Aprobado | `pnpm run lint`: sin avisos nuevos (queda 1 aviso previo en `test/route-start.e2e-spec.ts:217`) |
| Pruebas unitarias | Aprobado | Servicio, controlador y DTO: 31 pruebas nuevas, todas en verde. Módulo de planificación con 100 % de líneas |
| Pruebas de integración | Aprobado | Consulta real contra PostgreSQL: 30 pedidos → 9 rutas de ≤ 4 paradas; propuesta confirmada con `POST /routes` (201 `DRAFT`) y sus pedidos pasan a `ACTIVE_ROUTE_CLAIM` |
| Compilación | Aprobado | `pnpm run build`, exit 0 |
| Pruebas funcionales | Aprobado | Newman aislado: 93 solicitudes / 380 aserciones, 0 fallos (72 previas preservadas + 21 nuevas) |

Suite completa local (Windows, Node 26): 420 de 438 pruebas. Los 18 fallos son de `test/run-newman-isolated.spec.ts` y `test/geolocation-migration.fixtures.spec.ts`, que ejecutan `/bin/bash`, permisos `0600` y symlinks y fallan en Windows, igual que antes de este PR. Su resultado en Linux queda a cargo del CI de este PR.

## Evidencias

Ejemplo de resultado, contrato y casos de error en [`docs/route-planning.md`](../route-planning.md). El reporte de Newman se genera con `bash test/run-newman-isolated.sh --report`. El resultado de GitHub Actions aparece en la pestaña Checks de este PR.

## Impacto técnico

**API / Contratos:** Endpoint nuevo `GET /api/v1/route-proposals`. `400` fecha ausente/inválida, `zoneId` no UUID o parámetro desconocido · `401` sin autenticar · `403` rol distinto de ADMIN · `404` zona inexistente · `422` demasiados pedidos en una zona. No cambia `POST /routes`, `POST /routes/:id/assign` ni ningún DTO existente.

**Base de datos / Migraciones:** Sin cambios de esquema ni migraciones. Usa las coordenadas de #9 y las reservas de #10. Entorno limpio reproducible: `docker compose up -d`, `pnpm prisma db migrate`, `pnpm run seed` y, opcionalmente, `pnpm run seed:planning-demo`.

**Seguridad y permisos:** Solo ADMIN. No escribe, no abre transacciones y no devuelve datos de usuarios. El `zoneId` y la fecha se validan antes de consultar.

**Compatibilidad con otros componentes:** Se sirve en `/route-proposals` y no en `/routes/proposals` porque una propuesta no es una ruta (no se persiste) y así `GET /routes/:id` nunca puede capturarla; además no obliga a modificar `RoutesController` ni los tests que lo montan. El frontend puede usar `routeDate`, `zoneId` y `orderIds` de una propuesta confirmable como cuerpo de `POST /routes`.

**Limitaciones conocidas:**
- La propuesta agrupa por **día calendario**, como pide el enunciado, pero la confirmación actual exige el **mismo instante exacto** en todos los pedidos (guarda temporal del #10). Por eso una propuesta con horas distintas sale `confirmable: false` y `routeDate: null`. Relajar esa regla a nivel de día se propone en un PR aparte que referencia #10 y #12, para no modificar aquí código del #10.
- Distancia en línea recta (Haversine), sin tráfico ni cierres de calles.
- Costo cuadrático: ~0,45 s con 1 000 pedidos en una zona y ~5,9 s con 3 000 (se contrastará en las pruebas de volumen y carga).
- No incluye disparador programado, pedidos de último momento ni ventanas horarias.

## Checklist de entrega

- [ ] Cumplí los criterios de aceptación del Issue (queda por confirmar el criterio «CI satisfactoria» en los Checks de este PR).
- [x] Implementé únicamente los cambios necesarios.
- [x] Ejecuté las pruebas correspondientes.
- [x] Verifiqué que el código compile correctamente.
