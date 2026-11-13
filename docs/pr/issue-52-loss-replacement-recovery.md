## Descripción

La tienda asume la pérdida de una unidad que no se recupera y cumple el mismo pedido con un reemplazo. El ADMIN declara la pérdida de **una unidad** de un ítem; si hay existencia libre se descuenta una unidad una sola vez para el reemplazo, y si no la hay el reemplazo queda pendiente (no se simula uno preparado). Si el original aparece después, el ADMIN comprueba su estado: solo uno vendible suma una unidad, una sola vez; uno dañado se registra sin tocar el stock. No hay otra compra, cobro ni comprobante, y la recuperación tardía no reabre el pedido.

## Issue relacionado

Closes #52

## Cambios realizados

- `POST /dispatch/interventions` (solo ADMIN) con tres acciones nuevas: `LOSS_DECLARE` (declara la pérdida y, con existencia libre, prepara el reemplazo), `REPLACEMENT_PREPARE` (prepara un reemplazo pendiente cuando ya hay existencia; sin ella 409 `NO_FREE_STOCK` y sin cambios) y `ORIGINAL_RECOVER` (`SELLABLE` suma una unidad una vez; `DAMAGED` no).
- `GET /dispatch/orders/:id/losses` (solo ADMIN): pérdidas del pedido con el original y el reemplazo **separados** y los movimientos de existencias.
- Migración `20261113T1535_order_item_loss_replacement_recovery`: tablas `orderItemLoss` (una fila por unidad, único por `(orderItemId, unitNumber)`) y `productStockMovement` (único por `(pérdida, tipo)`: la base de datos impide el doble descuento y la doble suma) y las acciones nuevas en la auditoría.
- El reemplazo usa el mismo bloqueo de producto que las ventas, así que una venta concurrente y un reemplazo no dejan el stock negativo ni descuentan dos veces la última unidad.
- La pérdida no modifica el pedido; la entrega del reemplazo (mismo día u otra fecha acordada) se gestiona con `CONTACT`/`RESCHEDULE`/`PICKUP_*` ya existentes.
- Documentación del contrato y las decisiones en `docs/issue-52-loss-replacement-recovery.md`.

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | PASS | `pnpm lint`, `tsc --noEmit` |
| Pruebas unitarias | PASS (15 nuevas) | `dispatch-loss.service.spec.ts`; cobertura de ramas 82,04 % (umbral 80 %) |
| Pruebas de integración | PASS (22 nuevas) | `test/loss-replacement.e2e-spec.ts` sobre PostgreSQL 16 real y JWT reales |
| Regresión | PASS | e2e completo del manifiesto aislado |

Ejemplos del issue: con 2 libres el reemplazo deja 1 y la recuperación vendible deja 2 sin descontar de nuevo la compra; con stock 0 la pérdida no vuelve el stock positivo ni habilita salida; un original dañado, o confirmado dos veces, nunca suma una unidad extra. También se prueban repetición idempotente, concurrencia (declaraciones, preparaciones y recuperaciones simultáneas; una venta contra un reemplazo por la última unidad), ítems de varias unidades, rechazos sin cambios parciales y permisos.

## Evidencias

`docs/issue-52-loss-replacement-recovery.md` y la salida de Jest.

## Impacto técnico

**API / Contratos:** tres acciones nuevas en las intervenciones y un GET de seguimiento ADMIN; errores `LOSS_ALREADY_DECLARED`, `NO_FREE_STOCK`, `REPLACEMENT_ALREADY_PREPARED`, `ORIGINAL_ALREADY_RECOVERED`. Hay que acordarlo con `frontend-web-logistica#39`.

**Base de datos / Migraciones:** dos tablas nuevas con únicos y checks; no se tocan las guardas de pedidos. La migración se aplica sola en el runner aislado, que apunta al nuevo contrato.

**Seguridad y permisos:** solo ADMIN, actor tomado del JWT (el cuerpo no lo acepta) y claves idempotentes; un CLIENT o DRIVER recibe 403.

**Compatibilidad con otros componentes:** el enum de estados y el seguimiento del cliente no cambian. `ci-security.spec.ts` espera 43 archivos e2e.

**Limitaciones conocidas:** #51 (emergencia/custodia) aún no existe: no se inventó un estado y `LOSS_DECLARE` no se enlaza a un incidente; cuando exista, #50 (`PICKUP_AGREE`) deberá rechazar un pedido con el original en recuperación pendiente. No hay una acción para anular una pérdida declarada por error (pregunta abierta al líder). El cliente no ve estas pérdidas.

## Checklist de entrega

- [x] Cumplí los criterios de aceptación del Issue.
- [x] Implementé únicamente los cambios necesarios.
- [x] Ejecuté las pruebas correspondientes.
- [x] Verifiqué que el código compile correctamente.
- [x] Comprobé los posibles errores y excepciones.
- [x] Actualicé la documentación cuando fue necesario.
- [x] No incluí credenciales ni información sensible.
- [x] Adjunté evidencia de los resultados.
- [ ] Solicité revisión a otro integrante.

## Observaciones para el revisor

Decisiones a confirmar con el líder: que la pérdida sea por **unidad** (ítem + número de unidad) y no por pedido, que la entrega del reemplazo reutilice `CONTACT`/`RESCHEDULE` en lugar de un flujo propio, y si hace falta una acción para anular una pérdida declarada por error. Conviene revisar que `productStockMovement` sea único por `(pérdida, tipo)`: es lo que garantiza en la base de datos que no hay doble descuento ni doble suma.
