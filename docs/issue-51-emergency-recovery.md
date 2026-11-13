# Issue #51 — Emergencia en ruta, custodia individual y liberación de repartidor

## Decisiones de diseño

- **Granularidad por unidad (`RouteUnitRecovery`)**: La custodia tras una emergencia se registra por `(orderItemId, unitNumber)` (`1..quantity`) sobre todas las unidades de las paradas pendientes al momento de interrumpir la ruta. El pedido completo permanece bloqueado (`Order.requiresAdministrativeReview = true` y guardas de planificación/despacho/reprogramación/recogida `#50`) hasta que **todas** sus unidades queden recuperadas (`recoveredAt IS NOT NULL`) o cubiertas por una pérdida activa (`cancelledAt IS NULL`) con reemplazo `PREPARED`. Una pérdida con reemplazo `PENDING` (`stock === 0`) mantiene el pedido bloqueado hasta que se prepare el reemplazo o se recupere la unidad física.
- **Preservación de historia operativa**: Declarar una emergencia transiciona `Route.status` de `IN_PROGRESS` a `INTERRUPTED` conservando íntegras las paradas ya resueltas (`SUCCESSFUL` / `FAILED`) y sus `DeliveryAttempt`s. Solo las paradas pendientes liberan su `OrderClaim` activo y devuelven el `Order` a `PENDING` (`routeId = null`, `stopOrder = null`, `requiresAdministrativeReview = true`).
- **Retorno y liberación del repartidor independientes**: Tanto el repartidor (`POST /api/v1/routes/:id/return`, que además emite evento realtime `dispatch.incident.updated` con acción `EMERGENCY_DRIVER_RETURN`) como el administrador (`EMERGENCY_DRIVER_RELEASE`) pueden confirmar el retorno al depósito de una ruta `INTERRUPTED` de forma independiente a la recuperación de unidades y al cierre administrativo del incidente. La proyección `DriverAvailability` se recalcula respetando las ausencias vigentes (`#44` `DriverAbsence`).
- **Integración con `#52` y reversión `LOSS_CANCEL`**: No se permite confirmar recuperación física sobre una unidad con pérdida activa, ni declarar pérdida sobre una unidad ya confirmada como recuperada en `RouteUnitRecovery`. Para corregir pérdidas declaradas por error, `LOSS_CANCEL` permite anular lógicamente una pérdida reversible (`cancelledAt`), reponiendo existencias (`REPLACEMENT_CANCEL_IN`) solo si el reemplazo ya estaba `PREPARED`.

## Contrato API

Todas las intervenciones administrativas se ejecutan vía `POST /api/v1/dispatch/interventions` (rol `ADMIN`, `requestId` UUID idempotente, actor derivado exclusivamente del JWT).

| Acción | Campos requeridos | Efecto y reglas clave |
|---|---|---|
| `EMERGENCY_DECLARE` | `routeId`, `reason` | Pasa ruta `IN_PROGRESS` → `INTERRUPTED`, crea `RouteEmergency`, conserva paradas `SUCCESSFUL`/`FAILED`, libera `OrderClaim`s pendientes, desacopla pedidos pendientes (`requiresAdministrativeReview = true`) y crea `RouteUnitRecovery` por cada unidad pendiente. 409 `EMERGENCY_ALREADY_DECLARED` si ya existe emergencia. |
| `UNIT_RECOVERY_CONFIRM` | (`routeUnitRecoveryId` o `orderItemId` + `unitNumber`), `reason` (`emergencyId` opcional para desambiguar) | Marca `recoveredAt`/`recoveredById` en `RouteUnitRecovery`. Nunca modifica `Product.stock`, comprobantes ni cobros. 409 `UNIT_ALREADY_RECOVERED` si payload difiere; 409 `UNIT_HAS_ACTIVE_LOSS` si la unidad tiene pérdida activa no cancelada. |
| `EMERGENCY_CLOSE` | `routeId`, `reason` | Cierra `RouteEmergency` (`closedAt`, `closedById`, `closeReason`). Permitido aunque queden unidades pendientes; dichas unidades siguen visibles y sus pedidos siguen bloqueados. |
| `EMERGENCY_DRIVER_RELEASE` | `routeId`, `reason` | Confirma el retorno del vehículo/repartidor en una ruta `INTERRUPTED`, libera `DriverReservation` (`releasedAt`) y recalcula `DriverAvailability` respetando `#44` `DriverAbsence`. |
| `EMERGENCY_REQUEUE` | `orderId`, `reason` | Habilita manualmente el pedido para planificación/despacho (`requiresAdministrativeReview = false`) una vez que todas sus unidades están resueltas (`recoveredAt` o pérdida activa `PREPARED`). Sin resolución completa: 409 `RECOVERY_PENDING`. |

Consultas de emergencia (`ADMIN`):

- `GET /api/v1/dispatch/emergencies`: lista las emergencias declaradas con conteos (`totalUnits`, `recoveredUnits`, `lostPreparedUnits`, `lostPendingUnits`, `pendingUnits`), estado de retorno del repartidor y unidades pendientes.
- `GET /api/v1/dispatch/routes/:id/emergency`: detalle completo de la emergencia de la ruta con todas sus unidades y cruce con `#52` (`lossId`, `replacementPreparedAt`, `lossRecoveredAt`).

Retorno desde la app del repartidor (`DRIVER`):

- `POST /api/v1/routes/:id/return`: ahora admite rutas en estado `IN_PROGRESS -> COMPLETED` o `INTERRUPTED` (con evidencia de `startedAt` y `startedById`), libera `DriverReservation`, recalcula disponibilidad respetando `#44`, y cuando `route.status === 'INTERRUPTED'` emite `dispatch.incident.updated` (`EMERGENCY_DRIVER_RETURN`) al canal en tiempo real de despacho.

## Bloqueos y compatibilidad con otros flujos

- Mientras un pedido tenga unidades pendientes de recuperación en emergencia (o con pérdida `PENDING` sin stock), `RoutePlanningService`, `RouteUrgencyService`, `RouteAssignmentService`, `CONTACT` / `RESCHEDULE` y `PICKUP_AGREE` (`#50`) rechazan la operación (`409 RECOVERY_PENDING`).
- Una vez resueltas todas las unidades del pedido (físicamente recuperadas o con reemplazo `PREPARED`), el administrador decide explícitamente entre `EMERGENCY_REQUEUE`, `CONTACT` + `RESCHEDULE`, o `PICKUP_AGREE` (`#50`); ningún pedido se reencola automáticamente.
- `RouteProgressService` rechaza mutaciones de visita/entrega/completado sobre rutas `INTERRUPTED`.
- `RouteUrgencyService.inbox()` y `RouteHistoryService` exponen el estado `INTERRUPTED`, las rutas interrumpidas y las unidades pendientes de recuperación.

## Base de datos y disparadores PostgreSQL 16

Migración `20261113T1720_emergency_recovery_and_loss_cancel`:

- Agrega `RouteStatus.INTERRUPTED`, tablas `routeEmergency` y `routeUnitRecovery`, columnas de cancelación en `orderItemLoss` (`cancelledAt`, `cancelledById`, `cancelReason`, `cancelRequestId`), índice único parcial `active_order_item_loss_unit` (`WHERE "cancelledAt" IS NULL`) y movimiento `REPLACEMENT_CANCEL_IN` en `productStockMovement`.
- Actualiza las funciones trigger `route_integrity_guard`, `route_stop_integrity_guard`, `t1e_validate_route_coherence`, `t1e_validate_stop_visit`, `t1e_claim_history_guard`, `t1e_reservation_history_guard` y `dispatch_review_resolution_guard` para soportar el ciclo `IN_PROGRESS -> INTERRUPTED`, la liberación controlada de claims/reservas y la resolución administrativa tras custodia completa.

## Pruebas

- Unitarias: `route-lifecycle.policy.spec.ts`, `route-availability.service.spec.ts`, `route-return.service.spec.ts`, `dispatch-emergency.service.spec.ts`, `dispatch-intervention.service.spec.ts`, `dispatch-loss.service.spec.ts`, `route-progress.service.spec.ts`, `route-urgency.service.spec.ts`, `route-history.service.spec.ts`.
- E2E en PostgreSQL 16 real con JWT reales: `test/emergency-recovery.e2e-spec.ts`, `test/loss-replacement.e2e-spec.ts` (incluye `LOSS_CANCEL`) y `test/store-pickup.e2e-spec.ts`.
