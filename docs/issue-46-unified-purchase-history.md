# Issue #46 — Historial unificado de compras Shop y ADMIN

## Qué se contrastó antes de implementar

- `ShopOrdersService` (lista, detalle y comprobante) usaba `JOIN` obligatorio a `purchaseReceipt` y filtraba `o."userId" = comprador` y `r."buyerId" = comprador`. Por eso un pedido propio **sin comprobante** desaparecía de la lista, del detalle y del comprobante.
- Las compras ADMIN nuevas (issue #45) ya generan comprobante con `buyerId` del cliente registrado, así que entraban en el historial; faltaba el **origen** y los pedidos conservados sin comprobante.
- Shop y ADMIN guardan `Order.createdById`: en Shop es el propio comprador y en ADMIN es el administrador. Ese es el discriminante de origen.
- La base de datos ya impide que un comprobante tenga un `buyerId` distinto del `userId` del pedido (`Receipt buyerId must match order.userId`); el filtro del servidor se conserva como segunda barrera.

## Contrato

| Operación | Cambio |
|---|---|
| `GET /api/v1/shop/orders` | Una sola lista de pedidos propios (Shop + ADMIN), `createdAt desc, id desc`. Nuevos campos `source` y `receiptAvailable`. |
| `GET /api/v1/shop/orders/:id` | El detalle existe aunque no haya comprobante. Mismos campos nuevos. |
| `GET /api/v1/shop/orders/:id/receipt` | Pedido propio sin comprobante: `404` con `error.code = RECEIPT_UNAVAILABLE`. Pedido ajeno o inexistente: `404 ORDER_NOT_FOUND` (sin revelar nada). |

Campos nuevos, en lista y detalle:

| Campo | Valores |
|---|---|
| `source` | `SHOP` (lo hizo el cliente) o `ADMIN` (lo registró un ADMIN a su nombre). Se calcula en el servidor: `ADMIN` si `createdById` existe y es distinto del titular; `SHOP` en cualquier otro caso. |
| `receiptAvailable` | `true` si hay comprobante fiable; `false` si el pedido se conserva sin él. |

**Pedido conservado sin comprobante (`receiptAvailable = false`):**

- Siguen presentes y reales: `id`, `source`, `createdAt`, `scheduledDeliveryDate`, `status`, `routeId`, la línea de tiempo (seguimiento), el comprador (el propio titular), el destinatario y la dirección si el pedido los tiene.
- Pasan a `null`: `scheduledDeliveryDate` (solo si el pedido antiguo no la tiene), `number`, `totalCents`, `subtotalCents`, `taxAmountCents`, `taxRateBps`, `shippingAmountCents`, `taxEnabled`, `paymentStatus`, `receiptId`, y en la lista `itemsCount`, `primaryImageUrl` y `primaryProductId`. En el detalle `items` es `[]`, `recipient` y `delivery.location` pueden ser `null`.
- **No se reconstruye ningún importe, pago ni ítem con el catálogo actual.**

Con comprobante (`receiptAvailable = true`) la respuesta es la de siempre más los dos campos nuevos.

Paginación y orden: sin cambios (`page`, `pageSize` máx. 50, `status`). Orden estable por `createdAt desc, id desc`.

## Decisiones de diseño

| Tema | Decisión |
|---|---|
| Origen | `source` con `SHOP` y `ADMIN`, derivado de `createdById`. Un pedido antiguo sin `createdById` se trata como `SHOP`. |
| Disponibilidad del comprobante | `receiptAvailable` booleano; los datos del comprobante en `null`. |
| Comprobante ausente | `404` con código propio `RECEIPT_UNAVAILABLE`, distinto de `ORDER_NOT_FOUND`. No se crea ningún comprobante. |
| Seguridad | La condición es `o.userId = titular AND (sin comprobante OR r.buyerId = titular)`: conserva los dos filtros cuando hay comprobante y exige al menos el dueño del pedido cuando no lo hay. Los invitados (`userId` nulo) nunca entran en el historial de nadie ni se vinculan por teléfono. |
| Datos de prueba | No se migra ni se regenera nada. |

## Contrato OpenAPI

`docs/REGALIA-SHOP-OPENAPI-v1.2.yaml`: `OrderSummary` y `OrderDetail` incorporan `source` y `receiptAvailable` y admiten `null` donde corresponde (incluidos `recipient` y `delivery.location`). De paso se declara `primaryProductId` en `OrderSummary`: la API ya lo devolvía y el contrato no lo tenía.

## Riesgos y limitaciones

- Los clientes (web y Flutter) deben tolerar `null` en los campos derivados del comprobante y no asumir que `receiptId` siempre existe. Es un cambio de contrato que hay que acordar con `frontend-web-logistica#35`.
- Los pedidos de invitado solo se consultan por un canal externo acordado con ADMIN; este cambio no los expone.
- Los estados de gestión de retiro y emergencia (#50 y #51) se mostrarán cuando existan; el estado operativo sale del backend, no del medio de pago.

## Pruebas

- Unitarias (`orders.service.spec.ts`, 8 nuevas): origen, pedido sin comprobante (lista y detalle), datos corruptos, `RECEIPT_UNAVAILABLE` y `ORDER_NOT_FOUND`.
- E2E sobre PostgreSQL real (contenedor propio), `test/unified-purchase-history.e2e-spec.ts` (11 pruebas): una compra Shop y una ADMIN creadas por la API pública más pedidos conservados insertados directamente; cada una aparece con su origen en la lista de A y B no ve ninguna; orden y paginación estables; detalle sin comprobante con seguimiento; comprobante ausente sin generar uno; invitado con el mismo teléfono de A fuera de su historial; filtro por estado; y el invariante de la base de datos sobre el titular del comprobante.
- Regresión: suites e2e de Shop (checkout, pedidos, recuperación) y de pedidos ADMIN.
