# Issue #83 — Máximo configurable de unidades por pedido

## Qué se contrastó antes de implementar

- La capacidad del vehículo limita la planificación de rutas, no la compra: no se toca.
- Ya existe un máximo **por SKU** (`ShopBusinessSettings.maxUnitsPerSkuPerOrder`, 1 a 100, por defecto 10; antecedente #33). Se valida sobre la cantidad consolidada de cada producto en la cotización y en la confirmación de la tienda. **No se duplica ni se reemplaza:** el nuevo máximo es otro campo de la misma fila de configuración y los dos límites se aplican a la vez.
- La configuración vive en un registro único con versión y auditoría (`PATCH /admin/shop-settings`, solo ADMIN, con `expectedVersion`). El nuevo campo reutiliza ese mecanismo: mismo permiso, misma versión y misma auditoría.
- Hay cuatro puntos donde se crea un pedido: cotización y confirmación de la tienda (`/shop/checkout/quote` y `/shop/checkout`), compra desde el panel (`POST /orders/admin`) y `POST /orders` de un cliente.

## Decisiones

| Tema | Decisión |
|---|---|
| Qué se cuenta | La **suma de las cantidades** de todas las líneas (las líneas repetidas del mismo producto también suman). No se cuentan líneas, productos distintos ni paradas. |
| Campo | `ShopBusinessSettings.maxUnitsPerOrder`, entero **1 a 1000** o `null`. |
| Comportamiento inicial | `null` = **sin límite**: nada cambia hasta que un ADMIN lo configure, y los pedidos existentes se conservan. |
| Quitar el límite | `PATCH` con `limits.maxUnitsPerOrder: null`. |
| Relación con el máximo por SKU | Independientes. Un pedido debe cumplir ambos; el error por SKU conserva su código (`QUANTITY_LIMIT_EXCEEDED`). |
| Pedidos históricos | No se tocan: la regla solo se evalúa al crear. |

## Contrato

`GET /shop/settings` (público) y `GET /admin/shop-settings` (ADMIN) incluyen `limits.maxUnitsPerOrder` (`number | null`) junto a `limits.maxUnitsPerSkuPerOrder`. Así la web muestra el límite efectivo.

`PATCH /admin/shop-settings` (solo ADMIN) acepta `limits.maxUnitsPerOrder` y `limits.maxUnitsPerSkuPerOrder`, ambos opcionales, pero `limits` debe traer al menos uno. Los valores no válidos (0, negativos, decimales, texto o mayores de 1000) responden `400 VALIDATION_ERROR` sin modificar la configuración.

### Rechazo por superar el máximo

`422` con el sobre de errores de la tienda y un código estable:

```json
{ "error": { "code": "ORDER_UNITS_LIMIT_EXCEEDED", "message": "...", "details": { "requestedUnits": 6, "maximumAllowed": 5 } } }
```

Un pedido de exactamente N unidades con máximo N se acepta; N+1 se rechaza. El mismo código y forma se usan en los cuatro puntos de creación. En la compra de administración el intento queda registrado como `REJECTED` (con su clave de idempotencia, como cualquier otro rechazo) y no genera pedido.

## Cambios de configuración y concurrencia

- La **confirmación** lee la configuración bajo `FOR SHARE` y el cambio de configuración toma `FOR UPDATE` sobre la misma fila: una confirmación ve el máximo anterior o el nuevo completo, nunca uno intermedio. Si el cambio llega primero, la versión de la cotización ya no coincide y responde `409 SHOP_SETTINGS_CHANGED`: **una cotización vieja no esquiva un máximo más bajo**.
- La compra de administración y `POST /orders` leen el máximo dentro de su transacción con el mismo bloqueo compartido y **antes de tocar stock**.
- El rechazo ocurre antes de reservar stock, cobrar o emitir comprobante: no deja efectos parciales.

## Cambios en la base de datos

Migración `20261120T0424_max_units_per_order`: columna `maxUnitsPerOrder int4` nula y una restricción (`shop_settings_valid`) ampliada con `maxUnitsPerOrder IS NULL OR BETWEEN 1 AND 1000`. No toca filas existentes.

## Pruebas

- Unitarias: `order-units-limit.util.spec.ts` (suma, límite, N+1, sin límite, SKU vs total) y casos nuevos en `shop-settings.service.spec.ts`.
- E2E en PostgreSQL real, `test/order-max-units.e2e-spec.ts` (23): valor inicial, permisos (sin sesión, CLIENT, DRIVER), valores inválidos, auditoría, tienda en el límite y sobre él, cotización antigua con un máximo más bajo, panel, `POST /orders`, líneas repetidas, pedidos existentes intactos, subir y quitar el límite, y una confirmación concurrente con un cambio de configuración.

## Riesgos y limitaciones

- Con el máximo configurado, un cambio de configuración invalida las cotizaciones vigentes (comportamiento ya existente al cambiar la versión).
- Un máximo total menor que el máximo por SKU es válido: simplemente el total manda.
- Falta acordar con web (`frontend-web-logistica#65`) el mensaje a mostrar para `ORDER_UNITS_LIMIT_EXCEEDED`.
