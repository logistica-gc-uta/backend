# Issue #85 — Contrato de Seguimiento para el flujo administrativo

## Inventario (qué ya existe y se reutiliza)

| Necesidad de Seguimiento | Contrato existente |
|---|---|
| Distinguir una ruta cancelada | `GET /routes` y `GET /routes/:id` (ADMIN): `status: CANCELLED`, `cancelledAt`, `cancelledById`, `cancelReason`, `driverId` retenido, `orders` y `stops` con los pedidos originales (asociación histórica estable). |
| Pedido liberado por la cancelación | `GET /orders/:id`: `status: PENDING`, `routeId: null`. |
| Repartidor | `GET /drivers/me/routes` excluye las canceladas (sin cambios para la app móvil). |
| Emergencias | `GET /dispatch/emergencies` (`id`, `routeId`) y `GET /dispatch/routes/:id/emergency` (unidades con `emergencyId`, `routeId`, `orderId`). |
| Incidentes | `GET /dispatch/inbox`: `incidents[]` con `orderId`, `routeId`, `emergencyId`, `emergency{emergencyId, routeId}`; `interruptedRoutes[]` con `routeId` y `emergencyId`. Los incidentes son pedidos en revisión: no dependen del día. |
| Avisos en tiempo real | `route.updated`, `order.status.updated`, `dispatch.incident.updated`, `driver.availability.updated`, publicados tras el commit y filtrados por destinatario. |
| Resincronización | Tras reconectar no hay reenvío: se vuelve a autenticar, a suscribir y a consultar REST (`GET /routes`, `GET /dispatch/inbox`, `GET /dispatch/emergencies`). |

Las relaciones ruta ↔ pedido ↔ incidente ↔ emergencia se resuelven con estos identificadores estables **sin añadir una API paralela**.

## Lo que faltaba y se agregó (solo lo necesario)

1. **`emergencyId` en los eventos de emergencia.** El contrato `dispatch.incident.updated` ya lo aceptaba, pero ningún publicador lo rellenaba: el tablero no podía enlazar el aviso con la emergencia sin recargar todo. Ahora llevan `routeId` y `emergencyId`: `EMERGENCY_DECLARE`, `EMERGENCY_CLOSE`, `EMERGENCY_DRIVER_RELEASE` y `EMERGENCY_DRIVER_RETURN` (ruta y emergencia), y `UNIT_RECOVERY_CONFIRM` y `EMERGENCY_REQUEUE` (pedido, ruta y emergencia).
2. **`routeId` en el aviso de visita fallida** (`dispatch.incident.updated` al registrar una entrega fallida): antes solo traía el pedido.
3. **Códigos 404 estables** en `GET /dispatch/routes/:id/emergency`: `ROUTE_NOT_FOUND` (la ruta no existe) y `ROUTE_EMERGENCY_NOT_FOUND` (la ruta existe pero no tiene emergencia), para que el consumidor maneje explícitamente un caso que ya no está disponible.

Todos son campos o códigos **aditivos**: no cambian ningún campo ni permiso de lectura existente, y los avisos siguen siendo identificadores y banderas (sin motivos, contactos ni direcciones).

## Decisiones

- **La cancelación previa a la salida no publica `dispatch.incident.updated`** (decisión ya documentada en `admin-route-cancellation.md`: no es un incidente de entrega). Seguimiento se entera por `route.updated` (`CANCELLED`) y por `order.status.updated` (`PENDING`) de los pedidos liberados, y recarga `GET /routes`. Queda explícito en las pruebas.
- **Sin suscripción global de rutas:** Seguimiento suscribe por id de ruta o pedido (los conoce de `GET /routes`) y a `incidents`; las rutas creadas después se ven en la siguiente consulta REST. Los avisos son pistas de invalidación, no un replay.
- Los avisos nunca llevan `reason`, `cancelReason`, teléfonos, correos ni direcciones.

## Pruebas

`test/monitor-contract.e2e-spec.ts` (10), con PostgreSQL real, REST real y Socket.IO real:

- **Cancelación:** estado persistido antes de los avisos, `route.updated` y `order.status.updated` exactos, sin incidente, sin motivo en los avisos, relaciones por id, reenvío exacto sin republicación y rechazo sin avisos.
- **Emergencia e incidentes:** identificadores de los eventos iguales a los de REST (`emergencyId`, `routeId`, `orderId`), recuperación de unidad y cierre, 404 con código estable y aviso de visita fallida enlazado a la ruta.
- **Reconexión:** sin reenvío de eventos y estado completo recuperable por REST.
- **Destinatarios:** CLIENT y DRIVER ajenos no pueden suscribirse ni reciben avisos, las lecturas REST siguen siendo solo ADMIN, y el dueño y el repartidor asignado reciben solo lo de su recurso.

Unitarias actualizadas: `dispatch-emergency.service.spec.ts` y `route-return.service.spec.ts`.
