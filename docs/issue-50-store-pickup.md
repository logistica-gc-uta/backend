# Issue #50 — Retiro en tienda acordado

## Qué se contrastó antes de implementar

- `DispatchInterventionService` ya tenía `CONTACT` y `RESCHEDULE` (acuerdo explícito y reprogramación), pero nada acreditaba un **retiro**.
- Tras una entrega fallida el pedido conserva su estado y queda con `requiresAdministrativeReview = true` («entrega pendiente de gestión»). Los planificadores, las urgencias y la asignación ya ignoran los pedidos con esa marca, así que mantenerla es lo que evita que se cree otra ruta.
- La base de datos protege esa marca con guardas: `dispatch_review_resolution_guard` (el pedido solo cambia con una resolución auditada), `t1e_validate_stop_visit` (una visita fallida exige la marca o una resolución auditada) y `t1e_claim_history_guard` (una reserva solo se suelta en casos válidos). **Ninguna conocía el retiro**: sin ampliarlas, el retiro habría sido imposible incluso desde el backend.
- Una ruta DRAFT reserva el pedido con un `OrderClaim` pero no le pone `Order.routeId`; la ruta se busca por la reserva.

## Decisión de diseño (confirmada)

**Sin estado nuevo en `Order.status`.** «Pendiente de retiro en tienda» no es un valor del enum: se representa con una tabla nueva `OrderPickup` y la marca de gestión pendiente que el pedido ya tiene. Así el enum de cinco estados y todos los consumidores (Shop, ADMIN, Flutter) siguen igual; ven campos nuevos opcionales.

## Flujo y contrato

Acciones nuevas de `POST /api/v1/dispatch/interventions` (solo ADMIN, con `requestId` idempotente; el actor sale del JWT):

| Acción | Campos | Efecto |
|---|---|---|
| `PICKUP_DECLINE` | `orderId`, `attemptId?` | El cliente **no acepta** el retiro. Solo se audita: no se entrega, no se crea ruta, el pedido sigue pendiente de gestión y admite otra alternativa acordada. |
| `PICKUP_AGREE` | `orderId`, `attemptId?` | El ADMIN registra el acuerdo **explícito** de retiro. El pedido queda pendiente de retiro (conserva estado y marca de gestión), suelta sus reservas operativas de forma segura y no genera otra ruta. **No es una entrega.** |
| `PICKUP_CONFIRM` | `orderId` | El ADMIN confirma el retiro **físico**: el pedido pasa a `DELIVERED`, se limpia la marca de gestión y quedan actor y momento. Es el único evento que entrega. |

`attemptId` es obligatorio (y debe ser el último intento fallido) solo si el pedido espera gestión por una entrega fallida; se rechaza si no hay un intento sin resolver.

Errores tipados (409): `PICKUP_ALREADY_AGREED`, `PICKUP_NOT_AGREED`, `PICKUP_ALREADY_CONFIRMED`; además los de siempre (ruta congelada, no vaciar una ruta reservada, pedido ya entregado o cancelado, intento fallido distinto del último).

### Reservas operativas

| Situación | Resultado |
|---|---|
| Pedido sin reservas | se registra el acuerdo |
| Ruta **DRAFT** o **ASSIGNED** aún no iniciada | el pedido pierde su parada y su reserva con la operación estructural central; los demás pedidos de la ruta no cambian; una ruta con una sola parada no se vacía (409) |
| Ruta **iniciada** (`IN_PROGRESS`) | 409: no se borran paradas de una ruta iniciada |
| Entrega fallida | la ruta original debe estar terminada y haber liberado el pedido; el intento y la parada fallida se conservan |

### Seguimiento

`GET /shop/orders`, `GET /shop/orders/:id`, `GET /orders` y `GET /orders/:id` incorporan `pickup` (`{state: PENDING_PICKUP | PICKED_UP, agreedAt, pickedUpAt} | null`), mientras `GET /shop/orders` y `GET /shop/orders/:id` añaden además `pendingManagement` (`true` si la entrega espera gestión y aún no hay retiro). La línea de tiempo del detalle suma `PICKUP_AGREED` («Pendiente de retiro en tienda») y `PICKED_UP` («Entregado: retirado en tienda»). La bandeja de incidencias del ADMIN (`GET /dispatch/inbox`) trae `pickup` por incidencia.

Recorrido: **Entrega pendiente de gestión** (`pendingManagement`) → **Pendiente de retiro en tienda** (`pickup.state = PENDING_PICKUP`) → **Entregado por retiro** (`status = DELIVERED`, `pickup.state = PICKED_UP`).

## Cambios en la base de datos

Migración `20261113T0313_order_store_pickup`:

- Tabla `orderPickup` (un retiro por pedido; acuerdo con quién y cuándo; confirmación con quién, cuándo y su clave; una restricción exige que la confirmación esté completa y no sea anterior al acuerdo).
- La restricción de acciones de `dispatchIntervention` admite `PICKUP_AGREE`, `PICKUP_DECLINE` y `PICKUP_CONFIRM`.
- Las tres guardas se amplían para aceptar **solo** un `PICKUP_AGREE` o `PICKUP_CONFIRM` auditado **en la misma transacción**, con las mismas condiciones que la reprogramación (intento fallido de una ruta terminada, sin reservas ni intentos posteriores, mismas fechas). Cualquier otra modificación de un pedido con gestión pendiente sigue rechazada.
- El objetivo del runner aislado (`test/run-e2e-isolated.mjs`) pasa al nuevo contrato.

## Riesgos y limitaciones

- **Retiro tras emergencia (#51/#52): bloqueado.** El estado de «original en recuperación pendiente» no existe todavía; no hay nada que consultar para negar el retiro de un producto no recuperado, y no se inventó un estado. Cuando exista, `PICKUP_AGREE` deberá rechazarlo.
- Si el cliente acordó retirar y no se presenta, no hay una acción para **revertir** el acuerdo (volver a entrega): no se definió y queda como pregunta al líder.
- No hay llamadas automáticas, ni recobro, reembolso o reposición de stock: las pruebas verifican que stock, compras y comprobantes no cambian.
- Los clientes (web `frontend-web-logistica#38`, Flutter) deben mostrar `pickup` y `pendingManagement`; son campos nuevos obligatorios en la respuesta de seguimiento.

## Pruebas

- Unitarias: `dispatch-intervention.service.spec.ts` (17 nuevas: acuerdo, rechazo, confirmación, doble confirmación e idempotencia, reservas DRAFT/ASSIGNED/iniciada, intento fallido, validación de campos, pedidos entregados o cancelados), `orders.service.spec.ts` (proyección y línea de tiempo) y `route-urgency.service.spec.ts` (bandeja).
- E2E en PostgreSQL real con JWT reales, `test/store-pickup.e2e-spec.ts` (15 pruebas): flujo completo desde la entrega fallida del repartidor, rechazo, acuerdo, confirmación y seguimiento del cliente; el planificador ignora el pedido y no se puede armar una ruta con él; reservas de rutas DRAFT, ASSIGNED, iniciada y de una sola parada; stock, compras y comprobantes intactos; permisos (CLIENT, DRIVER, anónimo, actor en el cuerpo); aislamiento entre clientes; restricciones de la base de datos; e historial con el actor de cada evento.
- Regresión: suites de despacho (`urgent-dispatch`, `dispatch-agreement-prestart`), rutas, Shop y pedidos.
