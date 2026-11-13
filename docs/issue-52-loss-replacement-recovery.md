# Issue #52 — Pérdida, reemplazo y recuperación tardía

## Qué se contrastó antes de implementar

- **Existencias**: `Product.stock` es un único contador. La compra ya descontó la salida original (`orders.service.ts`, `checkout-confirmation.service.ts`, `admin-purchase.service.ts`: `FOR UPDATE` del producto y `stock - cantidad`), así que «existencia libre» = `Product.stock` actual. No existen productos a medida ni unidades individuales: el modelo es producto + cantidad.
- **Bloqueo y no negativo**: las ventas bloquean el producto con `lockInventoryProduct` y la base de datos exige `stock >= 0` (`product_catalog_amount_inventory`). El reemplazo usa el **mismo bloqueo**, por eso una venta concurrente y un reemplazo no pueden dejar el stock negativo ni descontar dos veces la última unidad.
- **Integración con #51**: ver [issue-51-emergency-recovery.md](issue-51-emergency-recovery.md). Una pérdida activa bloquea `UNIT_RECOVERY_CONFIRM` sobre esa misma unidad y no puede declararse pérdida si esa unidad ya fue confirmada como recuperada en `RouteUnitRecovery`. Para reanudar o recoger en tienda (`#50` `PICKUP_AGREE`), un pedido bajo emergencia requiere que todas sus unidades estén recuperadas o cubiertas por reemplazo `PREPARED`.
- La entrega del reemplazo no necesita un flujo nuevo: el pedido ya se gestiona con `CONTACT` / `RESCHEDULE` (mismo día u otra fecha acordada) y `PICKUP_*` (#50). Por eso **la pérdida no modifica el pedido**.

## Decisión de diseño

Una pérdida es **una unidad** de un ítem (`orderItemId` + `unitNumber`), no el pedido completo: un ítem de 3 unidades puede perder la unidad 2 sin tocar la 1 y la 3. `(orderItemId, unitNumber)` es único, así que la misma unidad no se declara dos veces.

Dos tablas nuevas:

| Tabla | Para qué |
|---|---|
| `orderItemLoss` | La pérdida: quién y cuándo la declaró; el reemplazo (quién y cuándo lo preparó, o nada si sigue pendiente); la recuperación del original (quién, cuándo y su estado `SELLABLE`/`DAMAGED`). Cada bloque tiene su `requestId` único y restricciones que exigen que esté completo. |
| `productStockMovement` | Historial de existencias: `REPLACEMENT_OUT` (−1) y `RECOVERY_IN` (+1), con el stock resultante y el actor. **Único por (pérdida, tipo)**: garantiza en la base de datos que no hay doble descuento ni doble suma aunque se repita o compita la petición. |

## Contrato

Acciones nuevas de `POST /api/v1/dispatch/interventions` (solo ADMIN, `requestId` idempotente, actor del JWT; el cuerpo no acepta actor):

| Acción | Campos | Efecto |
|---|---|---|
| `LOSS_DECLARE` | `orderId`, `orderItemId`, `unitNumber?`, `attemptId?` | Declara la pérdida de una unidad. **Con existencia libre** descuenta una unidad una sola vez y el reemplazo queda `PREPARED`; **sin ella** queda `PENDING` y no se toca el stock. `unitNumber` es obligatorio si el ítem tiene más de una unidad. |
| `REPLACEMENT_PREPARE` | `lossId` | Prepara el reemplazo de una pérdida `PENDING` cuando ya hay existencia. Sin existencia: 409 `NO_FREE_STOCK` y no se escribe nada (nunca se simula un reemplazo preparado). |
| `ORIGINAL_RECOVER` | `lossId`, `recoveryCondition` (`SELLABLE`/`DAMAGED`) | El original reaparece. `SELLABLE` suma **una** unidad, **una sola vez**; `DAMAGED` se registra sin aumentar el stock. Una pérdida ya recuperada o cancelada no se reclasifica ni se vuelve a sumar. |
| `LOSS_CANCEL` | `lossId`, `reason` | Anula lógicamente una pérdida declarada por error (`cancelledAt`, `cancelledById`, `cancelReason`, `cancelRequestId`, solo si es reversible). Si el reemplazo estaba `PREPARED`, registra movimiento compensatorio `REPLACEMENT_CANCEL_IN` (`+1` stock) en la misma transacción; si estaba `PENDING`, no toca existencias. El índice único parcial `WHERE "cancelledAt" IS NULL` permite declarar otra pérdida real después. Rechaza (`409`) si `recoveredAt != null`, el pedido está `IN_TRANSIT`/`DELIVERED`/`CANCELLED`, tiene `OrderClaim` activo o tiene `OrderPickup`. Reevalúa `Order.requiresAdministrativeReview` si existen unidades pendientes en `RouteUnitRecovery`. |

`GET /api/v1/dispatch/orders/:id/losses` (ADMIN): pérdidas del pedido con `replacement` y `original` **separados** y los movimientos de existencias de cada una.

Errores tipados (409): `LOSS_ALREADY_DECLARED`, `LOSS_ALREADY_CANCELLED`, `LOSS_ALREADY_RECOVERED`, `LOSS_CANCEL_ORDER_STATE`, `LOSS_CANCEL_ACTIVE_CLAIM`, `LOSS_CANCEL_PICKUP_EXISTS`, `NO_FREE_STOCK`, `REPLACEMENT_ALREADY_PREPARED`, `ORIGINAL_ALREADY_RECOVERED`; además 400 por campos inválidos, 404 por pedido/ítem/pérdida inexistente y 409 si el pedido ya está entregado o cancelado.

## Qué NO hace (alcance)

- No crea otra compra, cobro, comprobante ni devolución; no fabrica stock.
- No modifica el pedido ni abre otra entrega: la recuperación tardía no reabre un pedido cumplido.
- No decide la fecha del reemplazo: «mismo día / otra fecha acordada» se gestiona con `CONTACT`/`RESCHEDULE`, y el pedido sigue pendiente de gestión mientras no haya acuerdo (no se inventa una fecha confirmada).

## Cambios en la base de datos

Migración `20261113T1535_order_item_loss_replacement_recovery`: tablas `orderItemLoss` y `productStockMovement` con sus únicos y checks, y las tres acciones nuevas en `dispatch_audit_valid`. No toca las guardas de pedidos de #50: la pérdida no modifica el pedido. El runner aislado apunta al nuevo contrato.

## Riesgos y limitaciones

- **Integración con #51 (implementada)**: `LOSS_DECLARE` enlaza opcionalmente `emergencyId` y valida exclusión mutua contra `RouteUnitRecovery` (`UNIT_ALREADY_RECOVERED`); `PICKUP_AGREE` (#50), `RESCHEDULE`, `RoutePlanningService` y `RouteUrgencyService` bloquean pedidos con unidades sin recuperar o con reemplazo `PENDING` (`409 RECOVERY_PENDING`).
- La pérdida por sí sola no cambia el estado del pedido; cuando proviene de una emergencia en ruta (#51), `EMERGENCY_DECLARE` detiene el pedido con `requiresAdministrativeReview = true`.
- `LOSS_CANCEL` cubre la anulación de pérdidas declaradas por error antes de recuperar el original o despachar/recoger el pedido (incluye actualización de índice único parcial y movimiento compensatorio `REPLACEMENT_CANCEL_IN` en la migración `20261113T1720_emergency_recovery_and_loss_cancel`).
- La web (`frontend-web-logistica#39`) debe usar las acciones anteriores (incluido `LOSS_CANCEL`) y los GET de `#52`/`#51`; no hay datos ficticios mientras tanto.
- El cliente no ve estas pérdidas: son un seguimiento interno del ADMIN.

## Pruebas

- Unitarias: `dispatch-loss.service.spec.ts` (15: declaración con y sin stock, unidades, duplicados, ítems/pedidos/intentos inválidos, reemplazo pendiente, recuperación vendible/dañada, desbordes, lectura).
- E2E en PostgreSQL real con JWT reales, `test/loss-replacement.e2e-spec.ts` (22): los ejemplos del issue (2 libres → 1 → 2; stock 0; original dañado), repetición idempotente, concurrencia (cinco declaraciones simultáneas, última unidad disputada entre dos pérdidas y entre una venta y un reemplazo, cuatro preparaciones y cuatro recuperaciones simultáneas), unidades de un ítem de varias unidades, rechazos sin cambios parciales, permisos, historial con actor y restricciones de la base de datos.
