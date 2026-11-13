## Descripción

Retiro en tienda acordado como alternativa de gestión, tras el acuerdo explícito del cliente: el ADMIN registra el acuerdo (o el rechazo) y, cuando la persona retira el producto, confirma la entrega. Son eventos distintos: registrar el acuerdo no entrega el pedido. El pedido pendiente de retiro no genera otra ruta, no se reponen existencias ni se reembolsa nada, y el seguimiento del cliente refleja cada etapa.

## Issue relacionado

Closes #50

## Cambios realizados

- `POST /dispatch/interventions` (solo ADMIN) con tres acciones nuevas: `PICKUP_DECLINE` (el cliente no acepta: solo se audita y el pedido sigue pendiente de gestión), `PICKUP_AGREE` (acuerdo explícito: pendiente de retiro, sin otra ruta) y `PICKUP_CONFIRM` (retiro físico confirmado, con actor y momento: único evento que marca `DELIVERED`).
- Sin estado nuevo en `Order.status` (decisión confirmada): tabla nueva `OrderPickup` y la marca de gestión pendiente que el pedido ya tiene, de modo que planificadores, urgencias y asignación lo siguen ignorando.
- Reservas operativas con las protecciones de la reprogramación: en una ruta DRAFT o ASSIGNED aún no iniciada el pedido pierde su parada y su reserva sin vaciar la ruta; en una ruta iniciada se rechaza y no se borra ninguna parada; tras una entrega fallida se conservan el intento y la parada.
- Migración `20261113T0313_order_store_pickup`: tabla `orderPickup`, nuevas acciones permitidas y ampliación de las guardas de la base de datos (`dispatch_review_resolution_guard`, `t1e_validate_stop_visit`, `t1e_claim_history_guard`) para aceptar **solo** un retiro auditado en la misma transacción.
- Seguimiento: `pickup` y `pendingManagement` en `GET /shop/orders` y `/shop/orders/:id`, eventos `PICKUP_AGREED` y `PICKED_UP` en la línea de tiempo y `pickup` en la bandeja de incidencias del ADMIN. Contrato OpenAPI actualizado.
- Documentación del contrato y las decisiones en `docs/issue-50-store-pickup.md`.

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | PASS | `pnpm lint`, `tsc --noEmit` |
| Pruebas unitarias | PASS (nuevas) | `dispatch-intervention.service.spec.ts`, `orders.service.spec.ts`, `route-urgency.service.spec.ts` |
| Pruebas de integración | PASS (15 nuevas) | `test/store-pickup.e2e-spec.ts` sobre PostgreSQL 16 real y JWT reales |
| Regresión | PASS | suites e2e de despacho, rutas, Shop y pedidos |
| Compilación | PASS | `pnpm build` |

Ejemplos del issue: si el cliente no acepta el retiro no se entrega, no se crea ruta y el pedido sigue pendiente (y admite otra alternativa); si acuerda y después retira, son dos eventos y solo la confirmación entrega el pedido. Los rechazos no dejan cambios parciales (ruta, paradas, reservas y auditoría intactas) y stock, compras y comprobantes no cambian.

## Evidencias

`docs/issue-50-store-pickup.md` y la salida de Jest.

## Impacto técnico

**API / Contratos:** tres acciones nuevas en las intervenciones de despacho; campos nuevos `pickup` y `pendingManagement` en el seguimiento (web y Flutter deben mostrarlos); errores `PICKUP_ALREADY_AGREED`, `PICKUP_NOT_AGREED` y `PICKUP_ALREADY_CONFIRMED`. Hay que acordarlo con `frontend-web-logistica#38`.

**Base de datos / Migraciones:** una tabla nueva y guardas ampliadas con reglas explícitas; la migración se aplica sola en el runner aislado, que apunta al nuevo contrato.

**Seguridad y permisos:** solo ADMIN, con el actor tomado del JWT y claves idempotentes; la base de datos exige la auditoría en la misma transacción; el cliente solo ve el seguimiento de sus pedidos.

**Compatibilidad con otros componentes:** el enum de estados no cambia. `ci-security.spec.ts` espera 39 suites e2e.

**Limitaciones conocidas:** el retiro tras una emergencia (#51/#52) queda bloqueado porque «original en recuperación pendiente» aún no existe y no se inventó un estado; no hay una acción para revertir un acuerdo si el cliente no se presenta (pregunta abierta al líder); no hay llamadas automáticas, recobro ni reposición.

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

Conviene revisar con atención las guardas de la base de datos ampliadas: aceptan únicamente un `PICKUP_AGREE` o `PICKUP_CONFIRM` auditado en la misma transacción y con las mismas condiciones que la reprogramación. Decisiones a confirmar con el líder: representar el retiro con una tabla en lugar de un estado nuevo, y si hace falta una acción para revertir un acuerdo de retiro.
