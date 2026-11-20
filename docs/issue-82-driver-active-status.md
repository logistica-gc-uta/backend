# Issue #82 — Baja operativa reversible de repartidores

## Qué se contrastó antes de implementar

- Las ausencias (#44) cubren rangos de fechas y no impiden iniciar sesión; `Driver.isAvailable` es una bandera de compatibilidad que las rutas recalculan. **Ninguna de las dos sirve como baja**: hacía falta un estado administrativo propio.
- La regla «ruta asignada, en curso o terminada/interrumpida sin regreso al depósito confirmado» ya existe como `RouteAvailabilityService.persistedHolds` (un borrador no cuenta; una ruta `COMPLETED` o `INTERRUPTED` con inicio y regreso confirmados, tampoco). La baja la reutiliza en lugar de duplicarla.
- Todas las entradas de asignación bloquean la fila del repartidor con el mismo `lockDriver` (UPDATE de la fila) antes de crear la reserva: planificación (`assignInTransaction`), asignación heredada, confirmación y reasignación de ADMIN (`lockResources`).
- La sesión se valida en cada petición (`JwtStrategy.validate` consulta al usuario) y el tiempo real tiene su propia autenticación (`RealtimeService.authenticate`).

## Decisión de diseño

Estado administrativo **en `Driver`** (la cuenta de repartidor), no en `User`: los clientes y los administradores no tienen baja operativa.

| Campo | Para qué |
|---|---|
| `Driver.isActive` | `true` por defecto → las cuentas existentes siguen activas. |
| `Driver.statusChangedAt/ById`, `statusReason` | Último cambio de estado (quién, cuándo y por qué). Una baja exige actor y momento (restricción de la base de datos). |
| `DriverStatusChange` | Historial **append-only** de cada baja y reactivación (un disparador rechaza editar o borrar). |

La disponibilidad efectiva (`effectiveAvailability`) suma `isActive` y deja `isAvailable = false` mientras esté dado de baja, pero la baja **no modifica** `isAvailable`, las reservas ni las ausencias: reactivar solo devuelve el acceso.

## Contrato

Todo es solo ADMIN, con el actor tomado del JWT (el cuerpo no acepta actor).

| Operación | Efecto |
|---|---|
| `POST /drivers/:id/deactivate` `{ reason? }` | Baja. Registra actor, momento, motivo e historial. |
| `POST /drivers/:id/activate` `{ reason? }` | Reactivación. Restablece el acceso; no anula ausencias ni otras restricciones. |
| `GET /drivers` y respuestas de la baja/reactivación | Incluyen `isActive`, `statusChangedAt`, `statusChangedById`, `statusReason` y `effectiveAvailability.isActive`. |
| `GET /drivers/:id/status-changes` | Historial de bajas y reactivaciones, del más reciente al más antiguo. |

### Motivos estables (para la web)

| Código | HTTP | Cuándo |
|---|---|---|
| `DRIVER_HAS_OPEN_ROUTE` | 409 | La baja se rechaza porque hay una ruta asignada, en curso o terminada/interrumpida sin regreso confirmado (o una reserva viva). Trae `blockingRoutes: [{ routeId, status, returnConfirmed }]`. **No modifica nada.** |
| `DRIVER_ALREADY_INACTIVE` / `DRIVER_ALREADY_ACTIVE` | 409 | La baja o la reactivación no cambian el estado. |
| `DRIVER_INACTIVE` | 403 | `POST /auth/login` de un repartidor dado de baja (solo tras verificar la contraseña, para no revelar qué cuentas están inactivas). |
| `DRIVER_INACTIVE` | 401 | Una sesión (JWT) emitida antes de la baja deja de valer. |
| `DRIVER_INACTIVE` | 409 | Asignar, confirmar o reasignar una ruta a un repartidor inactivo. |

## Cómo se aplica el estado

- **Login y sesión previa:** `AuthService.login` y `JwtStrategy.validate`. Al reactivar, la misma sesión vuelve a valer (el JWT no se revoca, solo se rechaza mientras dure la baja).
- **Tiempo real:** `RealtimeService.authenticate` no abre canal y `canSubscribe` rechaza a una conexión abierta antes de la baja.
- **Asignaciones:** `assignInTransaction`, `assignLegacy`, `confirmInTransaction` y `REASSIGN_DRIVER` comprueban `isActive` con la fila del repartidor ya bloqueada. La propuesta de urgencias y de planificación usa `effective()`, que deja a un inactivo fuera.

## Concurrencia

La baja y la asignación se serializan con el **mismo bloqueo de fila** del repartidor: gana la que llega primero y la otra lo ve (la asignación creada hace fallar la baja con `DRIVER_HAS_OPEN_ROUTE`; la baja hecha hace fallar la asignación con `DRIVER_INACTIVE`).

Como red de seguridad, la base de datos lo impone aunque algún camino no bloquee: los disparadores `driver_reservation_requires_active_driver` y `route_requires_active_driver` rechazan una reserva o una ruta nueva para un repartidor inactivo, leyendo la fila con `FOR SHARE` (una baja concurrente espera a que esa transacción termine y viceversa).

## Cambios en la base de datos

Migración `20261120T0109_driver_active_status`: columnas nuevas de `driver` (`isActive` con valor por defecto `true`), tabla `driverStatusChange`, restricciones (`driver_inactive_has_actor`, motivo de 1 a 500 caracteres), el disparador append-only y los dos disparadores de asignación. El contrato renombra la relación `Driver.user` como `DriverUser` para distinguirla de la nueva `statusChangedBy`; no cambia ninguna columna.

## Pruebas

- Unitarias: `driver-status.service.spec.ts` (baja, reactivación, conflictos, historial y utilidad), `jwt.strategy.spec.ts`, `auth.service.spec.ts` (login), `realtime.service.spec.ts` y las de disponibilidad.
- E2E en PostgreSQL real con JWT reales, `test/driver-active-status.e2e-spec.ts` (24): migración por etapas de una cuenta existente, permisos, sesión previa y login, reactivación sin tocar ausencias, rutas `ASSIGNED`/`IN_PROGRESS`/`COMPLETED`/`INTERRUPTED` con y sin regreso, rechazo de asignación y reasignación, guardas de la base de datos, Socket.IO real y la carrera entre asignación y baja.

## Riesgos y limitaciones

- La baja no cierra por la fuerza un socket ya conectado: lo rechaza en la siguiente suscripción y no abre canales nuevos.
- No hay revocación individual de tokens: una sesión previa se rechaza mientras el repartidor esté inactivo y vuelve a valer al reactivarlo si el JWT no venció.
- Fuera de alcance (según el issue): eliminar cuentas, modificar el calendario de ausencias y la app móvil. La app móvil debe mostrar el mensaje de `DRIVER_INACTIVE` en el login; hay que acordarlo con web (`frontend-web-logistica#64`) y Flutter.
