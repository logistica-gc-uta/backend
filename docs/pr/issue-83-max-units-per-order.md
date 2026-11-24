## Descripción

Agrega un máximo configurable de unidades por pedido (la suma de las cantidades de todas las líneas), editable solo por ADMIN y validado en el servidor tanto en la tienda como en el panel. El máximo por SKU existente (#33) no se toca: ambos límites se aplican a la vez.

## Issue relacionado

Closes #83

## Cambios realizados

- `limits.maxUnitsPerOrder` (1 a 1000, o `null` = sin límite, valor inicial) en la configuración comercial: se consulta en `GET /shop/settings` y `GET /admin/shop-settings`, y se cambia con el `PATCH /admin/shop-settings` existente (solo ADMIN, con versión y auditoría).
- Un pedido de N unidades con máximo N se acepta; N+1 se rechaza con `422 ORDER_UNITS_LIMIT_EXCEEDED` y `details: { requestedUnits, maximumAllowed }`.
- Se valida en los cuatro puntos de creación: cotización y confirmación de la tienda, `POST /orders/admin` y `POST /orders`. El rechazo ocurre antes de tocar stock, cobros o comprobantes.
- Una cotización previa no esquiva un máximo más bajo (`409 SHOP_SETTINGS_CHANGED`) y los pedidos ya registrados no se modifican.
- Migración `20261120T0424_max_units_per_order` y documentación en `docs/issue-83-max-units-per-order.md`.

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | PASS | `pnpm lint`, `tsc --noEmit` |
| Pruebas unitarias | PASS | suma de líneas, límite, N+1, sin límite y validación de la configuración |
| Pruebas de integración | PASS (23 nuevas) | `test/order-max-units.e2e-spec.ts` sobre PostgreSQL 16 real y JWT reales |
| Regresión | PASS | e2e completo del manifiesto aislado |
| Compilación | PASS | `pnpm build` |

La suite cubre bajo el máximo, en el límite y sobre él en ambos canales, varios productos, líneas repetidas, permisos, valores inválidos, ausencia de efectos parciales y un cambio de configuración concurrente con una confirmación.

## Evidencias

`docs/issue-83-max-units-per-order.md` y la salida de Jest.

## Impacto técnico

**API / Contratos:** campo nuevo `limits.maxUnitsPerOrder` (`number | null`) en las respuestas de configuración, entrada opcional en el `PATCH` y un código de error nuevo. `maxUnitsPerSkuPerOrder` pasa a ser opcional en el `PATCH` (`limits` debe traer al menos uno de los dos). Hay que acordar con web (`frontend-web-logistica#65`) el mensaje de `ORDER_UNITS_LIMIT_EXCEEDED`.

**Base de datos / Migraciones:** una columna nula en `shopBusinessSettings` y la restricción `shop_settings_valid` ampliada; no modifica filas existentes.

**Seguridad y permisos:** solo ADMIN cambia el máximo (sin sesión 401, CLIENT/DRIVER 403).

**Compatibilidad con otros componentes:** sin límite configurado todo se comporta como antes. `ci-security.spec.ts` espera 54 archivos e2e.

**Limitaciones conocidas:** un cambio de configuración invalida las cotizaciones vigentes (comportamiento ya existente al cambiar la versión).

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

Conviene revisar que el máximo se lea dentro de la transacción y antes de reservar stock en `admin-purchase.service.ts` y `orders.service.ts`, y bajo el bloqueo compartido ya existente en la confirmación. Decisiones a confirmar: `null` como «sin límite» inicial, el tope de 1000 y que el máximo por SKU siga siendo independiente.
