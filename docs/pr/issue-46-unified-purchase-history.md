## Descripción

Historial único de compras propias que incluye los pedidos de Shop y los registrados por un ADMIN, cada uno con su origen. Un pedido propio conservado sin comprobante deja de desaparecer: su detalle y seguimiento existen y el comprobante informa su indisponibilidad, sin reconstruir importes ni generar uno nuevo. La autorización del titular en lista, detalle y comprobante se mantiene.

## Issue relacionado

Closes #46

## Cambios realizados

- `GET /shop/orders`: una sola lista ordenada por `createdAt desc, id desc` con los campos nuevos `source` (`SHOP` o `ADMIN`) y `receiptAvailable`. El `JOIN` obligatorio al comprobante pasa a `LEFT JOIN` conservando el filtro del titular.
- `GET /shop/orders/:id`: el detalle existe sin comprobante; importes, pago e ítems quedan en `null`/vacío (nunca reconstruidos con el catálogo) y el seguimiento se conserva.
- `GET /shop/orders/:id/receipt`: un pedido propio sin comprobante responde `404 RECEIPT_UNAVAILABLE` y no genera uno; uno ajeno o inexistente sigue dando `404 ORDER_NOT_FOUND`.
- `docs/REGALIA-SHOP-OPENAPI-v1.2.yaml`: `OrderSummary` y `OrderDetail` con los campos nuevos y `null` donde corresponde; se declara `primaryProductId`, que la API ya devolvía.
- Documentación del contrato y las decisiones en `docs/issue-46-unified-purchase-history.md`.

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | PASS | `pnpm lint`, `tsc --noEmit` |
| Pruebas unitarias | PASS (8 nuevas) | `src/modules/shop/orders/orders.service.spec.ts` |
| Pruebas de integración | PASS (11 nuevas) | `test/unified-purchase-history.e2e-spec.ts` sobre PostgreSQL 16 real en contenedor propio |
| Regresión | PASS | suites e2e de Shop y de pedidos ADMIN (ver evidencias) |
| Compilación | PASS | `pnpm build` |

Ejemplos del issue cubiertos: el cliente A ve su compra Shop y su compra ADMIN en una sola lista, cada una con su origen, y el cliente B no ve ninguna; un pedido propio anterior sin comprobante tiene detalle disponible y comprobante no disponible, sin precio reconstruido.

## Evidencias

`docs/issue-46-unified-purchase-history.md` y la salida de Jest.

## Impacto técnico

**API / Contratos:** campos nuevos (`source`, `receiptAvailable`) y campos derivados del comprobante que ahora pueden ser `null` cuando no hay comprobante; error nuevo `RECEIPT_UNAVAILABLE`. Hay que acordarlo con `frontend-web-logistica#35`.

**Base de datos / Migraciones:** sin cambios.

**Seguridad y permisos:** solo el titular ve sus pedidos; el filtro por dueño se mantiene en lista, detalle y comprobante; los invitados no se vinculan por teléfono; un pedido ajeno sigue dando `ORDER_NOT_FOUND` sin revelar su existencia.

**Compatibilidad con otros componentes:** los clientes deben tolerar `null` en los campos del comprobante. `ci-security.spec.ts` espera 37 suites e2e.

**Limitaciones conocidas:** los estados de retiro y emergencia (#50 y #51) se mostrarán cuando existan; un pedido antiguo sin `createdById` se trata como `SHOP`.

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

Decisiones que conviene confirmar con el líder: nombres de los campos (`source`, `receiptAvailable`), el código `RECEIPT_UNAVAILABLE` con `404` y que los campos del comprobante pasen a `null` en lugar de omitirse.
