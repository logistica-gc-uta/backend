# Issue #44 — Ausencias de repartidores y disponibilidad por fecha

## Qué se contrastó antes de implementar

- `RouteAvailabilityService.effective` combina reservas/rutas persistidas (`persistedHolds`) con la bandera `Driver.isAvailable`. No existía ningún calendario de ausencias.
- `effective` lo usan la **asignación** (`RouteAssignmentService`), el **reemplazo** (`DispatchInterventionService`), la **urgencia** (`RouteUrgencyService`), el **retorno** (`RouteReturnService`) y el listado/consulta de repartidores. Su forma de respuesta la fijan pruebas existentes y la consulta de Flutter `GET /drivers/me/availability`.
- La asignación ya bloquea la fila del repartidor (`lockDriver`) antes de evaluar la disponibilidad. Esa es la pieza que se reutiliza para la concurrencia.

## Decisiones de diseño

| Tema | Decisión |
|---|---|
| Fecha o rango | **Rango cerrado** `[startDate, endDate]` en un solo registro (pueden ser el mismo día). Días operativos de `America/Guayaquil`, guardados como texto `YYYY-MM-DD`. |
| Qué se puede registrar | Solo hoy o fechas futuras. Una fecha pasada, un día de calendario inexistente o un rango invertido se rechazan con 400. |
| Solapes | Un repartidor no puede tener dos ausencias **activas** que se crucen (`409 ABSENCE_OVERLAP`). Las contiguas y las anuladas no bloquean. |
| Corregir / anular | Las ausencias **no se editan ni se borran**. Se **anulan** (`cancelledAt`, `cancelledById`, `cancelReason`) y, si hace falta, se registra otra. Una ausencia que ya terminó no se toca (`409 ABSENCE_ALREADY_ELAPSED`). |
| Auditoría | Cada ausencia guarda quién la registró y cuándo, y quién la anuló y cuándo. Solo ADMIN opera. |
| Conflicto con una ruta asignada | **Se registra** y la respuesta lista en `conflicts` las rutas `ASSIGNED`/`IN_PROGRESS` del repartidor dentro del rango, con sus pedidos. **No se cancela, libera ni reasigna nada**: decide el ADMIN. |
| Asignación | Se evalúa la ausencia del **día de la ruta**: ausente ese día → `409 DRIVER_ABSENT`; ausente otro día → no bloquea. No se crea ninguna ruta por una ausencia futura. |
| Retorno | Terminar y devolver una ruta libera solo su reserva; **la ausencia vigente permanece**. El evento `driver.availability.updated` ya refleja la ausencia de hoy. |
| Levantar una ausencia | Solo marca la anulación; **no libera reservas operativas pendientes**. |
| Concurrencia | El registro y la anulación toman el mismo bloqueo de la fila del repartidor que la asignación: o la ausencia gana (la asignación recibe `DRIVER_ABSENT`) o la asignación gana (la ausencia informa el conflicto). Nunca se ignora. |

## Contrato

| Operación | Rol | Notas |
|---|---|---|
| `POST /api/v1/drivers/:driverId/absences` | ADMIN | Cuerpo `startDate`, `endDate`, `reason?`. `201` con la ausencia y `conflicts`. Errores: `400 INVALID_DATE / ABSENCE_DATE_IN_PAST / ABSENCE_RANGE_INVALID`, `404`, `409 ABSENCE_OVERLAP`. |
| `GET /api/v1/drivers/:driverId/absences?from=&includeCancelled=` | ADMIN | Activas con fin ≥ `from` (por defecto hoy), con sus `conflicts`. |
| `POST /api/v1/drivers/:driverId/absences/:absenceId/cancel` | ADMIN | Cuerpo `reason?`. `409 ABSENCE_ALREADY_CANCELLED / ABSENCE_ALREADY_ELAPSED`. |
| `GET /api/v1/drivers/:driverId/availability?date=` | ADMIN | Disponibilidad de un día operativo (hoy o futuro): `isAvailable`, `hasPersistedHolds`, `compatibilityFlagBlocks`, `blockingRouteIds`, **`date`**, **`absence`**. |
| `POST /routes/:id/assign` | ADMIN | Nuevo error `409` con `code: DRIVER_ABSENT` y `absence`. El `409` por reservas/rutas no cambia. |

`RouteAvailabilityService.effective(driverId, tx, day?)`: **sin `day` devuelve exactamente la forma histórica** (reservas + bandera), así que `GET /drivers/me/availability` (Flutter) y el listado `GET /drivers` no cambian. Con `day` suma la ausencia de ese día.

## Cambios en la base de datos

Migración aditiva `20261111T2346_driver_absences`: tabla `driverAbsence` con claves foráneas a `driver` y `user`, índices y dos restricciones `CHECK` (formato de fecha, `endDate >= startDate`, longitud del motivo, y coherencia de los campos de anulación). No modifica tablas existentes. El objetivo del runner aislado (`test/run-e2e-isolated.mjs`) pasa al nuevo contrato.

## Riesgos y limitaciones

- `GET /drivers/me/availability` y el listado de repartidores **no muestran la ausencia** para no cambiar su forma (hay pruebas y Flutter que dependen de ella); la ausencia se ve con el nuevo `GET /drivers/:id/availability?date=`. Mostrarla ahí es un cambio de contrato a acordar con web y móvil.
- La asignación se hace hoy también para fechas futuras; cuando el issue #49 limite las rutas al día actual, la regla sigue siendo la misma (ausencia del día de la ruta).
- No hay tope de duración del rango ni reglas de turnos o nómina (fuera de alcance).
- Si el PR #60 (issue #43) se fusiona antes, `test/ci-security.spec.ts` necesita el conteo de suites e2e actualizado (ambos PR agregan una).

## Pruebas

- Unitarias: `route-availability-absence.spec.ts` (disponibilidad por día) y `driver-absences.spec.ts` (DTO, reglas de fecha, controlador).
- E2E en PostgreSQL real (contenedor propio): `test/driver-absences.e2e-spec.ts`, 16 pruebas: registro, consulta, anulación y auditoría; permisos; validación de fechas; solapes; restricciones de la base de datos; los tres ejemplos del issue; retorno y levantamiento sin liberar reservas; la consulta de Flutter intacta; y 8 rondas de asignación y ausencia simultáneas.
- Regresión: suites de rutas (asignación, retorno, reconciliación, despacho urgente, progreso).
