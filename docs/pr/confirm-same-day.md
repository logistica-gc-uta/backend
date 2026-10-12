## Descripción

Relaja la guarda de confirmación de rutas: `POST /routes` (y la asignación de un DRAFT) aceptan pedidos programados a **horas distintas del mismo día calendario `America/Guayaquil`**, en lugar de exigir el mismo instante exacto. Es lo que necesita la propuesta de Clarke & Wright (#7), que agrupa por día como pide el enunciado: sin este cambio, una propuesta con horas distintas no se podía persistir.

## Issue relacionado

Refs #7, #10, #12

> Este PR depende de la rama `feat/7-route-planning-api` (PR de #7). Debe fusionarse **después** de ese PR; hasta entonces su base es esa rama.

## Cambios realizados

- `route-assignment.service.ts` (`lockOrders`): la comparación de instante exacto pasa a "mismo día de negocio" (`isSameBusinessDay`, `America/Guayaquil`). Se revalida bajo los mismos bloqueos de pedidos que antes.
- `src/common/temporal.util.ts`: `BUSINESS_TIME_ZONE`, `businessDay` e `isSameBusinessDay`.
- La propuesta (`GET /route-proposals`) usa como `routeDate` el instante programado más temprano y deja de devolver `confirmable`, que pasa a ser siempre verdadero.
- `POST /routes/assign` **se mantiene estricto** (un único instante común exacto): no cambia su comportamiento.
- Documentación actualizada: `docs/route-assignment.md`, `docs/route-planning.md`, `docs/clarke-wright.md`.

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | Aprobado | `pnpm run lint`: sin avisos nuevos (queda 1 aviso previo en `test/route-start.e2e-spec.ts:217`) |
| Pruebas unitarias | Aprobado | Casos nuevos: mismas fechas a distinta hora, instante de ruta distinto del de los pedidos, mismo día local con distinta fecha UTC, y rechazo a un segundo de la medianoche local. Los 3 casos de aceptación fallan contra la regla anterior |
| Pruebas de integración | Pendiente de CI | Dos casos e2e nuevos en `test/route-assignment.e2e-spec.ts` con PostgreSQL efímero: confirmar y asignar con horas distintas, y rechazo sin DRAFT parcial. No se pudieron ejecutar en Windows (`spawnSync pnpm ENOENT` del fixture, también en los tests previos) |
| Compilación | Aprobado | `pnpm run build` |
| Pruebas funcionales | Aprobado | Newman aislado: 93 solicitudes / 382 aserciones, 0 fallos; incluye confirmar una propuesta con pedidos a las 15:00Z y 18:00Z |

## Evidencias

Resultado de GitHub Actions en la pestaña Checks de este PR.

## Impacto técnico

**API / Contratos:** `POST /routes` ahora acepta pedidos del mismo día local con distinta hora (antes 409). Siguen respondiendo 409 un pedido sin fecha, de otro día local, de otra zona, no `PENDING`, con revisión administrativa o ya reservado. `confirmable` se elimina de la respuesta de `GET /route-proposals` (aún sin consumidores).

**Base de datos / Migraciones:** Sin cambios de esquema ni migraciones.

**Seguridad y permisos:** Sin cambios. La validación sigue ocurriendo bajo bloqueo, dentro de la misma transacción.

**Compatibilidad con otros componentes:** `GET /drivers/me/routes` filtra por `Route.date` en el mismo día local, coherente con este criterio. El `POST /routes/assign` antiguo no cambia.

**Limitaciones conocidas:** El día de negocio es fijo (`America/Guayaquil`). No hay ventanas horarias ni reglas de hora máxima dentro del día (VRPTW).

## Checklist de entrega

- [ ] Cumplí los criterios de aceptación del Issue (pendiente la confirmación de CI).
- [x] Implementé únicamente los cambios necesarios.
- [x] Ejecuté las pruebas correspondientes.
- [x] Verifiqué que el código compile correctamente.
