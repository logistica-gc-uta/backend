# REGALÍA — Contrato de integración Shop ↔ Backend ↔ ADMIN

**Código:** CI-SHOP-001
**Versión:** 1.2.0 CONSOLIDADO — decisiones de negocio aprobadas; contratos nuevos sujetos a validación técnica e implementación
**Fecha de consolidación:** 23-10-2026 · **Fecha objetivo del proyecto:** 26-11-2026
**Ámbito:** `logistica-gc-uta/backend` (NestJS, Prisma 8/PostgreSQL), `logistica-gc-uta/frontend-web-logistica` (React/TypeScript), QA.
**Decisiones de negocio:** envío gratuito incluido en precio, IVA ficticio 15% configurable, máximo 10 unidades por SKU/pedido y horario configurable de 07:00 a 17:00, zona `America/Guayaquil`.
**Fuentes originales verificadas:** [ESP-SHOP-001 v1.2](https://docs.google.com/document/d/1hPLYkA885tqwjhNWZ08IW7KjSqUPZV1TIAge4_OQ5SQ/edit), [REGALÍA Figma](https://www.figma.com/design/Gt0COrpEq6AXBSWrZ21ejX), código de `main` de ambos repositorios revisado para el contrato inicial; Issues backend #31–#35 y frontend #19–#21 actualizadas al 23-10-2026. Se debe volver a inspeccionar el código al iniciar cada PR.

> **Estado normativo:** documento CONSOLIDADO y AUTOCONTENIDO para backend, frontend y QA. Las decisiones de negocio tomadas por el líder (envío, IVA simulado, límites y horarios) son vigentes; los DTO y endpoints NUEVOS se someten a validación técnica antes de integrarlos. Las rutas existentes en `main` no se modifican de manera incompatible. Ningún endpoint nuevo se considera disponible sin implementación y pruebas. Figma es referencia visual opcional y no fuente de contratos. Los ejemplos JSON no representan datos desplegados.

## Cómo usar este contrato sin leer versiones anteriores

**Documento principal único para implementación:** `CI-SHOP-001 v1.2 CONSOLIDADO`. Integra el contrato 1.0, el contrato/adenda 1.1 y las decisiones posteriores aprobadas; **no requiere consultar la adenda** para conocer las reglas aplicables. El SRS ESP-SHOP-001 v1.2 es antecedente de alcance, no fuente de campos contradictorios. Las Issues establecen tareas y responsables concretos; si surge un conflicto entre una Issue y este contrato, documentarlo y corregir ambos antes del PR, en vez de asumir precedencia tácita. **Nadie debe inventar DTO o respuesta que no esté acordada.**

| Tema | Regla vigente y completa |
|---|---|
| Envío | GRATIS; incluido en `priceCents`; `shipping.amountCents=0`, estado `FREE_INCLUDED`, no configurable |
| Impuesto | IVA **SIMULADO**, inicio 15 % (`rateBps=1500`), configurable/desactivable por ADMIN; se **suma** al subtotal y no constituye tributo SRI |
| Límite | 10 unidades **por SKU y por pedido**, ajustable 1–100 por ADMIN, con consolidación de líneas |
| Calendario | Hora aproximada entre **07:00 y 17:00**, extremos incluidos; horarios editables en ADMIN, zona fija `America/Guayaquil` |
| Dinero | Enteros de centavos para la API Shop; migración **aditiva, auditada y reversible** desde Float heredado |
| Cloudinary | Upload **proxy backend**, exclusivo ADMIN con JWT; credenciales privadas solo servidor |
| Tarjetas | Tres tarjetas **ficticias** de demostración, saldo en PostgreSQL, sin pasarela ni datos bancarios reales |
| Pedido | Cotización firmada y versionada; aceptación del total; transacción de stock + saldo ficticio + pedido + comprobante; idempotencia |
| Cancelación | No realizar reembolso o reposición automática; política aún diferida |
| UI | Figma es **referencia opcional**, las funcionalidades, estados y seguridad son obligatorios |

**Alcance de versiones:** CI-SHOP-001 **v1.2 (contrato de integración consolidado)** no es la misma especificación que **ESP-SHOP-001 v1.2 (SRS funcional)**, aunque compartan número de versión. Este contrato consolida todas sus propias revisiones, no altera retrospectivamente el SRS existente.

## 1. Convenciones transversales y compatibilidad

1. **Base real actual:** `http(s)://<host>/api/v1`; Swagger `http(s)://<host>/api/docs`. No omitir `/api/v1` en los nuevos servicios. `Authorization: Bearer <JWT>` en recursos de CLIENT o ADMIN; visitas al catálogo y detalles son públicas.
2. **Formato:** JSON UTF-8, claves `camelCase`, ID `string` UUID de la API, instantes ISO 8601 con offset explícito (en respuestas normalizados a UTC, por ejemplo `2026-11-15T15:00:00.000Z`); fecha/hora de interfaz local `America/Guayaquil` (`2026-11-15T10:00:00-05:00`). Fechas ambiguas sin offset → 400.
3. **Dinero (NUEVO):** `currency:"USD"`, precios y totales como **enteros de centavos** (`priceCents`, `subtotalCents`, `totalCents`, `balanceCents`) en toda la API del Shop. 1 USD = 100 centavos; sin valores flotantes, redondeo de cada línea definido: `unitPriceCents * quantity`; no aceptar `totalCents` calculado en React para autorizar el pago. El subtotal refleja el precio de productos (envío ya incluido), el IVA ficticio se calcula por separado y el total autorizado incluye IVA simulado.
4. **Migración de Float (decisión aprobada):** transición aditiva a columnas de enteros (precio, subtotal, IVA simulado y total en centavos), backfill por decimal exacto y verificación de valores heredados; auditoría de importes con más de dos decimales (no truncarlos silenciosamente). Mantener columnas/respuestas antiguas durante la convivencia, doble escritura controlada y comparación entre ambas representaciones. Desplegar migración con respaldo, transacciones, pruebas de lectura de historial y rollback reversible; prohibir reconstrucción retroactiva de comprobantes antiguos. La transición no debe romper ADMIN/Flutter ni pedidos existentes. **Compatibilidad de totales:** en la fase de convivencia, `Order.total` de la API heredada mantiene su semántica anterior (subtotal de productos), mientras que el Shop expone `subtotalCents`, `taxAmountCents`, `shippingAmountCents=0` y `totalCents` (total final de pago). El panel ADMIN debe mostrar ambas magnitudes con etiquetas correctas en pedidos nuevos, sin llamar «importe pagado» al subtotal legado; al migrar todos los consumidores se puede deprecar `Order.total` mediante nueva versión. No aplicar IVA ficticio retroactivamente a órdenes previas al Shop.
5. **Restricción de entrada:** validación estricta `whitelist: true`, `forbidNonWhitelisted: true` (existente); un campo desconocido o tipo incorrecto → 400 `VALIDATION_ERROR`; nunca ignorar silenciosamente propiedades relacionadas con pagos, destinatarios o roles. `null` no es intercambiable con ausencia.
6. **Errores:** estructura estandarizada nueva para el Shop (sección 12), estados HTTP y códigos estables. Frontend decide UI por `error.code`, no por textos en español. `requestId` para trazabilidad; sanitizar datos sensibles.
7. **Seguridad:** PUBLIC solo catálogo y `GET /zones`; CLIENT solo sus datos/checkout; ADMIN solo CRUD imágenes/categorías. Roles del JWT revalidados en backend; el frontend oculta controles por UX, **no** como control de seguridad. El Shop no usa datos reales de tarjetas ni muestra precios/ratings inventados.
8. **Endpoints EXISTENTES, intocables de forma incompatible:** `POST /auth/register`, `POST /auth/login`, `GET /products` (arreglo de stock>0), `POST /products` (ADMIN), `PATCH /products/:id/stock` (ADMIN), `GET /zones`, `POST /orders` (CLIENT, hoy no exige todos los campos), `POST /orders/admin`, `GET /orders/my-orders`, `GET /orders/:id`. Los nuevos endpoints `/shop/*`, `/admin/catalog/*` y `/admin/shop-settings` evitan alterar respuestas antiguas.
9. **Paginar:** `page` entero >=1, `pageSize` entero 1..48 con default 12 para catálogo y 1..50 default 10 para historial; envelope `{items,total,page,pageSize,totalPages}`. Orden estable por `id` como desempate; devolver `items:[]` si sin resultados.
10. **Contratos compartidos:** generar tipos TypeScript desde OpenAPI o tipos alineados con pruebas de contrato; documentar qué PR cambia contrato e incrementar versión; no improvisar nombres de campos sobre el componente React.

## 2. Inventario existente: puntos concretos a corregir

| Componente `main` | Comportamiento comprobado | Gap para Shop |
|---|---|---|
| `auth/RegisterDto`, `AuthService` | acepta `role` del request, default CLIENT; password mínimo 6 | quitar `role` del registro público, elevar mínimo a 8 para alta CLIENT y denegar mass assignment |
| `frontend authService`, `AuthProvider` | acceso ADMIN solamente, descarta CLIENT al restaurar | soportar sesión CLIENT para Shop y preservar guard ADMIN |
| `Product` | `name`, `description?`, `price: Float`, `stock`, `createdAt` | precio exacto, `categoryId`, `images`, `isPublished`, `featured`/tags opcionales |
| `GET /products` | devuelve `Product[]` con `stock>0` | API Shop pública paginada incluyendo agotados publicados (según filtro) y API ADMIN incluyendo despublicados |
| `CreateOrderDto` CLIENT | zona, dirección, items; fecha y coordenadas opcionales | Shop exige fecha/hora, ubicación y destinatario/teléfono; preserva `POST /orders` existente |
| `OrdersService.persistOrder` | ya bloquea fila producto en transacción y consolida IDs; precio/total Float | extender al flujo de pago/saldo/idempotencia y comprobante; no crear orden antes de autorizar tarjeta |
| `Order` | propietario, creador, destinatario, zona, hora, ruta, estados; recipientPhone protegido en proyección CLIENT actual | proyección Shop propia para CLIENT dueño (destinatario, contacto y snapshot de compra) |
| `Zone` | `depotLocation` null o `{lat,lng}` | Shop solo ofrece zonas con depósito, servidor revalida zona antes de confirmar |

## 3. Modelos de datos y campos (versión Shop)

### 3.1 Category (NUEVO)
`id: UUID` obligatorio, inmutable; `name: string(2..80)` obligatorio; `slug: string(2..100)` ASCII minúsculas, guiones, único; `description: string(0..300)|null`; `isActive:boolean`; `sortOrder:int(0..9999)`; `createdAt`, `updatedAt` ISO. No DELETE físico en v1. Category desactivada no puede vender productos nuevos; no se destruyen ventas anteriores.

### 3.2 Product Shop (NUEVO, derivado del registro existente)
`id`, `sku:string(3..50)` único (necesario para seeder idempotente); `name:string(3..160)`; `description:string(1..2000)`; `category:{id,name,slug}`; `categoryId:UUID`; `priceCents:int(>=1)`; `currency:"USD"`; `stock:int(0..2147483647)`; `isPublished:boolean`; `isFeatured:boolean` (ADMIN puede curar destacados); `images:ProductImage[]` (0..6 en borrador, >=1 al publicar); `primaryImageUrl:string|null`; `createdAt`, `updatedAt`. El stock 0 **no borra** producto del catálogo; `isAvailable = isPublished && category.isActive && stock>0` es valor derivado por backend.
ProductImage: `{id:UUID,secureUrl:HTTPS,publicId:string,altText:string(1..160),position:int(0..5),isPrimary:boolean}`. `publicId` es referencia Cloudinary, **no** prueba de autorización por sí solo. Una sola primaria. Para productos anteriores a la migración se admite `categoryId=null` mientras ADMIN regulariza; nunca publicarlos en el Shop sin categoría e imagen.

### 3.3 Compra, estados y snapshots
`ShopBusinessSettings`: `{version:int>=1, shippingMode:"FREE_INCLUDED", taxEnabled:boolean, taxRateBps:int(0..10000), maxUnitsPerSkuPerOrder:int(1..100), deliveryTimeZone:"America/Guayaquil", deliveryStartTime:"HH:mm", deliveryEndTime:"HH:mm", updatedAt, updatedById}`; un único registro activo versionado y auditado, sin edición directa por CLIENT. El número de IVA se expresa en puntos básicos: 1500=15%, y se conserva el porcentaje/rate exacto aplicado por pedido.
`CheckoutAttempt`: `{id,ownerUserId,idempotencyKey,requestHash,status:PROCESSING|SUCCEEDED|REJECTED|FAILED,code|null,orderId|null,createdAt,updatedAt}`; índice único `(ownerUserId,idempotencyKey)`; conserva resultado reenviable, nunca campos de tarjeta.
`SimulatedCardBalance`: `{fixtureId:string, balanceCents:int>=0, isActive:boolean,version:int}`. Los datos ficticios de tarjeta se definen **solo en configuración/test fixtures del backend**; la BD necesita saldo persistente, no PAN/CVV. Recuperación de demos solo mediante script/test no expuesto públicamente.
`PaymentAttempt`: `{id,checkoutAttemptId,ownerUserId,fixtureId,amountCents,currency,status:PENDING|APPROVED|REJECTED,rejectionCode|null,createdAt}`; proyección pública omite fixture secretos, solo `cardLast4` si procede.
`PurchaseReceipt`: `{id,number,orderId UNIQUE,paymentId UNIQUE,issuedAt,currency,totalCents,buyerSnapshot,recipientSnapshot,itemsSnapshot,disclaimer}`. Persistir snapshots de nombre, SKU, qty, unitPriceCents, lineTotalCents e imagen opcional para evitar cambios retroactivos. No es factura del SRI.
`ShopOrder`: utiliza el mismo `Order` y estados logísticos `PENDING|ASSIGNED|IN_TRANSIT|DELIVERED|CANCELLED`; no crear una tabla de órdenes alternativa. Nuevos datos de entrega del CLIENT se copian a campos existentes, y los snapshots completan información de compra. Total Shop = subtotal de productos (con logística incluida en cada precio) + **IVA ficticio configurado**, con costo de envío 0; guardar rateBps y taxAmountCents como snapshot inmutable. **No es IVA legal ni genera obligación tributaria o factura SRI.**

## 4. Registro y login (EXISTENTE + seguridad NUEVA)

**POST `/api/v1/auth/register`** PUBLIC; request NUEVO estricto `{ "name": "María Pérez", "email": "maria@example.test", "password": "ClaveFicticia123" }`. `name` tras trim 2..120, `email` válido/normalizado lowercase trim 5..254, `password` mínimo 8 y máximo 128 en nuevo contrato. `role` prohibido aun si vale CLIENT: `400 VALIDATION_ERROR`; salida `201 {id,name,email,role:"CLIENT",createdAt}`, sin hash, sin token automático. Email ya existente: `409 EMAIL_ALREADY_EXISTS`. El registro para ADMIN/DRIVER se gestiona en vías protegidas separadas.

**POST `/api/v1/auth/login`** EXISTENTE; request `{email,password}`, respuesta 200 `{access_token:string,user:{id,name,email,role:"ADMIN"|"CLIENT"|"DRIVER"}}`, 401 `INVALID_CREDENTIALS`. Frontend CLIENT puede guardar/restaurar sesión si JWT válido; solo ADMIN entra a rutas ADMIN; DRIVER no recibe panel por defecto. La renovación silenciosa/recuperación de contraseña **no está especificada**: no construir endpoints falsos.

## 5. Catálogo público (NUEVO)

**GET `/api/v1/shop/categories`** PUBLIC. Respuesta 200 `{items:CategorySummary[]}` solo categorías activas, ordenadas por `sortOrder,name,id`; CategorySummary `{id,name,slug,description,productCount,sortOrder}`. `productCount` cuenta productos publicados, con y sin stock.

**GET `/api/v1/shop/products`** PUBLIC. Query admitida (y sólo estas claves):
- `search`: `string` trim 1..100, sin comodines SQL suministrados por navegador; opcional.
- `categoryId`: UUID, opcional; alternativa por slug **no incluida** para evitar rutas ambiguas.
- `minPriceCents`, `maxPriceCents`: enteros >=0; `min<=max`; opcionales.
- `inStock`: boolean serializado `true|false`, default false (si true, stock>0).
- `sort`: enum `featured|recent|price_asc|price_desc|best_selling`; default `featured`.
- `page=1`, `pageSize=12` (1..48). Ignorar categorías desactivadas/productos despublicados, pero **mostrar stock 0** si `inStock=false`.
- Para `best_selling`, contar unidades de pedidos Shop con pago aprobado y no cancelados, si existen. Si no hay ventas, aplicar sort `featured` y devolver `sortApplied:"featured"` (sin afirmar «más vendidos» ficticios).

**Respuesta ejemplo 200:**
```json
{
  "items": [{
    "id":"11111111-1111-4111-8111-111111111111", "sku":"REG-NAV-001", "name":"Caja sorpresa navideña",
    "description":"Caja con detalles navideños", "category":{"id":"22222222-2222-4222-8222-222222222222","name":"Navidad","slug":"navidad"},
    "priceCents":3650, "currency":"USD", "stock":1, "isAvailable":true,
    "isFeatured":true, "images":[{"id":"33333333-3333-4333-8333-333333333333","secureUrl":"https://res.cloudinary.com/demo/image/upload/v1/regalia/caja.jpg","publicId":"regalia/caja","altText":"Caja sorpresa","position":0,"isPrimary":true}],
    "primaryImageUrl":"https://res.cloudinary.com/demo/image/upload/v1/regalia/caja.jpg",
    "createdAt":"2026-10-22T11:00:00.000Z","updatedAt":"2026-10-22T11:00:00.000Z"
  }],
  "total":200,"page":1,"pageSize":12,"totalPages":17,"sortApplied":"featured"
}
```
Los IDs, imagen y cantidad anteriores son **ejemplos**, no datos reales ni contratos ya desplegados.

**GET `/api/v1/shop/products/:id`** PUBLIC. Respuesta `ProductDetail` = los campos de ProductShop más `isPublished` implícito (debe ser publicado), `relatedProducts` opcional (no necesario v1). `404 PRODUCT_NOT_FOUND` si no existe/despublicado/inactivo; stock=0: 200 con `isAvailable:false`, compra deshabilitada.

## 6. Catálogo ADMIN y CRUD (NUEVO)

Ruta base **`/api/v1/admin/catalog`** — JWT ADMIN, 401 sin token, 403 CLIENT/DRIVER.

| Método | Ruta | Propósito / retorno |
|---|---|---|
| GET | `/products?page&pageSize&search&categoryId&status&sort` | Productos, incluyendo agotados y despublicados; envelope paginado; `status=all|published|unpublished|out_of_stock` |
| POST | `/products` | Alta `CreateProductRequest` → 201 `AdminProduct` |
| GET | `/products/:id` | Detalle ADMIN incluso despublicado/agotado |
| PATCH | `/products/:id` | Edición parcial; 200 `AdminProduct`; omitir campo conserva valor |
| PATCH | `/products/:id/publication` | Body `{isPublished:boolean}` → 200; validar categoría+imagen al publicar |
| GET | `/categories` | Todas las categorías, incluidas inactivas |
| POST | `/categories` | Crear categoría → 201 |
| PATCH | `/categories/:id` | Cambiar `name,description,isActive,sortOrder` de forma parcial |
| POST | `/uploads` | `multipart/form-data file` carga Cloudinary **desde backend**, devuelve `UploadAsset` |
| POST | `/products/:id/images` | `{uploadId,altText,isPrimary,position}`; vincula asset subido por ADMIN al producto |
| PATCH | `/products/:id/images/:imageId` | `{altText?,isPrimary?,position?}`; no permitir dos primarias |
| DELETE | `/products/:id/images/:imageId` | 204; desasociación segura, eliminación de Cloudinary diferida y auditada |

`CreateProductRequest` completo:
```json
{"sku":"REG-NAV-001","name":"Caja sorpresa navideña","description":"Caja con detalles navideños","categoryId":"22222222-2222-4222-8222-222222222222","priceCents":3650,"stock":12,"isFeatured":false,"isPublished":false}
```
Todos los campos obligatorios salvo `isFeatured` (default false), `isPublished` (default false). Un producto nuevo **no se publica** hasta tener categoría activa, descripción, precio, imagen principal y stock >=0. `PATCH` admite solo campo editables; `id,createdAt,price` legado, ventas y `soldCount` nunca editables desde el cliente. `sku` inmutable tras creación para proteger seed. `sku` duplicado 409 `SKU_ALREADY_EXISTS`.

`CreateCategoryRequest`: `{name,slug,description?,isActive?,sortOrder?}`; default isActive true/sortOrder 0. `PATCH` no cambia `id` ni `slug` inicialmente. Slug repetido 409 `CATEGORY_ALREADY_EXISTS`. Desactivar categoría impide nueva venta de sus productos y ocultará sus fichas públicas; conservar pedidos previos.

Compatibilidad:
- No romper `GET /api/v1/products` existente; se mantiene respuesta arreglo limitada a stock>0 mientras consumidores actuales migren.
- ADMIN nuevo usa `/admin/catalog/products` para ver stock=0; el antiguo `POST /products` puede mantenerse para compatibilidad, pero una migración a catálogo completo debe evitar crear publicaciones incompletas.
- Actualizar stock absoluto únicamente con serialización por fila coherente con el proceso de checkout. No implementar stock como suma REST sin lock.

## 7. Cloudinary — contrato elegido (NUEVO)

Se decide **upload backend-proxy** (más sencillo de asegurar para la primera versión que firmas entregadas al navegador): `POST /api/v1/admin/catalog/uploads`, `multipart/form-data` con `file` binario. JWT ADMIN obligatorio. Backend examina bytes y formato real (JPEG, PNG, WebP), límites propuestos 5 MiB, 8192×8192 píxeles, máximo 6 imágenes por producto y sanitización básica. Subir exclusivamente a carpeta propia `regalia/products`, credenciales solo servidor. **No exponer endpoint de firma a CLIENT**, ningún upload anónimo. API secret/Cloudinary URL config solo servidor.

Respuesta 201:
```json
{"uploadId":"44444444-4444-4444-8444-444444444444","secureUrl":"https://res.cloudinary.com/demo/image/upload/v1/regalia/products/foto.jpg","publicId":"regalia/products/foto","format":"jpg","bytes":153600,"width":1200,"height":1200,"status":"UPLOADED"}
```
El valor es de demostración.

Luego `POST /products/:id/images` con `{uploadId,altText,isPrimary,position}`. Backend comprueba que `uploadId` pertenece al ámbito/admin autorizado, no ha sido usado y no está expirado; no acepta `secureUrl/publicId` arbitrario para asociar. Persistir Cloudinary `secure_url` + `public_id` tras verificar. Las cargas huérfanas se limpian por job (TTL sugerida 24 h). Si falla Cloudinary o DB, no devolver éxito: error `UPLOAD_FAILED` / `IMAGE_ASSOCIATION_FAILED`; reintento seguro, cleanup diferido. Las URLs son referencias, no almacenamiento binario en PostgreSQL.

Seguridad inspirada en documentación Cloudinary (la API secreta nunca debe exponerse en JS): https://cloudinary.com/documentation/image_upload_api_reference ; https://cloudinary.com/documentation/authentication_signatures.

## 8. Zonas, calendario y dirección de checkout

Reutilizar **GET `/api/v1/zones`** PUBLIC y seleccionar solo zonas con `depotLocation:{lat,lng}` no nulo. El backend vuelve a comprobar que zona existe y depósito configurado al momento de compra. No inventar chequeo de polígonos geográficos.

`DeliveryInput` en Shop:
```json
{
  "recipient":{"name":"Ana Regalo","phone":"0991234567"},
  "zoneId":"55555555-5555-4555-8555-555555555555",
  "deliveryAddress":"Av. Cevallos y Montalvo, edificio 3, Ambato",
  "deliveryLocation":{"lat":-1.2425,"lng":-78.6188},
  "scheduledDeliveryDate":"2026-11-15T10:00:00-05:00",
  "deliveryNotes":"Entregar en recepción"
}
```
- `recipient.name`: trim 1..120, requerido, puede diferir del comprador; `recipient.phone`: trim 7..40, requerido.
- `zoneId`: UUID y depósito no nulo; `deliveryAddress`: trim 5..250, requerida; `deliveryLocation.lat` -90..90, `lng` -180..180 finitos y ambos obligatorios; marcador confirmado en frontend, no enviar falso `locationConfirmed` para reemplazar controles server.
- `scheduledDeliveryDate`: ISO offset explícito; exactamente 1 instante de **hora de entrega aproximada**, posterior al reloj de BD al commit; la fecha local y horario se muestran en `America/Guayaquil` (Ecuador continental, Ambato) y se guarda en UTC. Por defecto el horario local admitido es **07:00 a 17:00 inclusive**, ambos extremos incluidos. El backend valida fecha/hora local y configuración vigente tanto al cotizar como al pagar; fuera del horario => 422 `DELIVERY_OUTSIDE_HOURS`. El ADMIN puede editar inicio/fin (sin intervalos nocturnos) y cualquier cambio incrementa `settings.version`. No imponer franja start/end ni cambio de huso para el Shop v1.2. Galápagos tiene otra zona horaria y no pertenece al alcance operativo actual de Ambato.
- `deliveryNotes`: opcional trim 0..500; no incluir si no hay observación.
- **Envío gratis:** la logística está incorporada en `priceCents`. `shipping:{status:"FREE_INCLUDED",amountCents:0,includedInPrices:true}` siempre; no añadir cargo, no aplicar descuento por envío ni mostrar una cifra negativa.
- **IVA simulado:** por defecto `taxEnabled=true`, `taxRateBps=1500` (15%). Se agrega al subtotal, NO está incluido de nuevo en el precio: `taxAmountCents = (subtotalCents * taxRateBps + 5000) // 10000` para entradas enteras no negativas (redondeo half-up a centavo), **una sola vez por pedido**; `totalCents = subtotalCents + taxAmountCents`. Trabajar con enteros y evitar punto flotante. La UI muestra "IVA simulado (15 %)" separado y el aviso "Demostración sin validez tributaria". Puede modificarse o deshabilitarse solo por ADMIN; no son tributos legales/SRI. La cotización/pago captura versión de ajustes y porcentaje aplicado, y no cambia tras aprobarse.
- El backend guarda `Order.userId`/`createdById` desde JWT, no de request, y snapshots de destinatario/teléfono; `recipientType=REGISTERED_CLIENT` identifica dueño autenticado aunque quien recibe sea otra persona. No registrar a destinatarios como usuarios automáticamente.

### 8.1 Configuración operativa del Shop — API configurable ADMIN (NUEVO)

**GET `/api/v1/shop/settings`** PUBLIC → respuesta `ShopSettingsPublic`, solo reglas de compra, sin identidad de ADMIN. El navegador lee settings antes de mostrar cantidades y calendario; backend mantiene autoridad absoluta.

```json
{
  "version":1,
  "currency":"USD",
  "shipping":{"status":"FREE_INCLUDED","amountCents":0,"includedInPrices":true},
  "tax":{"mode":"SIMULATED","enabled":true,"rateBps":1500,"ratePercent":15},
  "limits":{"maxUnitsPerSkuPerOrder":10},
  "deliverySchedule":{"timeZone":"America/Guayaquil","startTime":"07:00","endTime":"17:00","boundariesInclusive":true},
  "updatedAt":"2026-10-22T12:00:00.000Z"
}
```

**GET `/api/v1/admin/shop-settings`** ADMIN → mismos campos y auditables `updatedById`, `createdAt`, `updatedAt`. **PATCH `/api/v1/admin/shop-settings`** ADMIN con body **parcial**:

```json
{
  "expectedVersion":1,
  "tax":{"enabled":true,"rateBps":1500},
  "limits":{"maxUnitsPerSkuPerOrder":10},
  "deliverySchedule":{"startTime":"07:00","endTime":"17:00"}
}
```

- `expectedVersion:int>=1` **obligatorio**; al actualizar con comparación de versión se incrementa `version` atómicamente y se devuelve el nuevo ShopSettingsAdmin. Si la versión del cliente no es actual → `409 SETTINGS_VERSION_CONFLICT`. Si no hay nada que editar → `400 VALIDATION_ERROR`.
- `tax.rateBps` entero entre 0 y 10000 (0 a 100%), `enabled:boolean`; tasa inicial 1500 (15%). `ratePercent=rateBps/100`; desactivado implica `amountCents=0`. Guardar rateBps y enabled en snapshot incluso si desactivado.
- `limits.maxUnitsPerSkuPerOrder` entero entre 1 y 100, **default 10**. La suma consolidada por SKU se comprueba tanto en quote como dentro de transacción; si supera límite → `422 QUANTITY_LIMIT_EXCEEDED` con `{productId,requestedQuantity,maximumAllowed}`.
- `deliverySchedule.startTime`/`endTime` strings `HH:mm`, `00:00..23:59`; `startTime<endTime`, sin horarios nocturnos en este alcance, **default 07:00–17:00 inclusive**. `timeZone` no editable en esta versión para evitar ambigüedad en Ambato. Fuera del horario → `422 DELIVERY_OUTSIDE_HOURS` con `{startTime,endTime,timeZone}`.
- `shipping` es solo lectura y siempre `FREE_INCLUDED`, monto 0: ningún endpoint puede cobrar adicionalmente transporte.
- Cambios ADMIN NO alteran `Order`, `PurchaseReceipt`, `PaymentAttempt` ya confirmados ni transacciones históricas. Cambios comerciales posteriores a cotizar invalidan el `quoteToken` con 409 `SHOP_SETTINGS_CHANGED` (comparar `settingsVersion` también bajo transacción). El frontend debe refrescar y pedir al CLIENT aceptar el nuevo total u horario.
- Si no existe fila de configuración en despliegue inicial, la migración crea una única fila explícita default; prohibido asumir un cero de IVA por accidente o inferir del reloj del servidor.
- El panel ADMIN implementa un formulario de configuración «Shop» en su menú actual, con estados de guardado, validaciones, error por concurrencia, y muestra expresamente «IVA de demostración»; no reemplaza el diseño global de ADMIN.

## 9. Simulador: 3 tarjetas ficticias y campos del formulario

**Decisión técnica y funcional consolidada para frontend #20 y backend #33:** el formulario de pago pide **número, titular, vencimiento y CVV totalmente ficticios**. Aunque el SRS anterior contemplaba selección por alias, esta decisión de integración reemplaza esa modalidad; Figma solo la ilustra y **no obliga a copiar su diseño**. El backend compara únicamente con fixtures de demostración, sin datos bancarios reales.

Fixtures SUGERIDOS, **exclusivamente `NODE_ENV=test|demo` / `SIMULATED_PAYMENTS_ENABLED=true`**, con números intencionalmente no bancarios:

| Identificador fixture | Número ficticio | Titular | Vence | CVV ficticio | Saldo inicial |
|---|---|---|---|---|---|
| DEMO_APPROVED | `9000 0000 0000 0001` | `PRUEBA APROBADA` | `12/30` | `111` | 50000 centavos |
| DEMO_LIMITED | `9000 0000 0000 0002` | `PRUEBA LIMITADA` | `12/30` | `222` | 2000 centavos |
| DEMO_EMPTY | `9000 0000 0000 0003` | `PRUEBA SIN SALDO` | `12/30` | `333` | 0 centavos |

Estas no son tarjetas de pago reales ni números de redes de pago. Para usar fixtures distintos, modificarlos **coordinadamente** en documentación de QA y backend. El frontend no determina la aprobación. El backend normaliza espacios de número, trim/case del titular, valida vencimiento calendario e igualdad exacta de fixture/CVV en memoria, validez activa y saldo persistido; nunca guarda ni loguea PAN/CVV del request, y no devuelve balance total de otras tarjetas a CLIENT. CVV solamente se usa para verificar un valor ficticio durante request; en el sistema real jamás procesar tarjetas verdaderas de esta forma. El saldo de DEMO_LIMITED varía por compras anteriores; definir reset de DEMO protegido.

`PaymentCardInput` (en POST checkout):
```json
{"number":"9000 0000 0000 0001","holderName":"PRUEBA APROBADA","expiresMonth":12,"expiresYear":2030,"cvv":"111"}
```
Requeridos todos; `number` string de 16 dígitos ficticios después de normalizar; `holderName` 2..100; `expiresMonth` int 1..12, `expiresYear` int >=2026 (validación real del calendario); `cvv` string de 3 dígitos ficticios. No persistir/localStorage/log de campos sensibles incluso siendo de prueba. Si `SIMULATED_PAYMENTS_ENABLED` está apagado, fallo controlado 503 `PAYMENT_SIMULATION_DISABLED`, jamás derivar a una pasarela real.

## 10. Cotización y compra: contratos HTTP exactos

### 10.1 `POST /api/v1/shop/checkout/quote` — CLIENT JWT
Request JSON (todos salvo notes):
```json
{
  "items":[{"productId":"11111111-1111-4111-8111-111111111111","quantity":2}],
  "delivery":{
    "recipient":{"name":"Ana Regalo","phone":"0991234567"},
    "zoneId":"55555555-5555-4555-8555-555555555555",
    "deliveryAddress":"Av. Cevallos y Montalvo, Ambato",
    "deliveryLocation":{"lat":-1.2425,"lng":-78.6188},
    "scheduledDeliveryDate":"2026-11-15T10:00:00-05:00"
  }
}
```
`items` 1..50 líneas, cada `quantity` entera 1..**maxUnitsPerSkuPerOrder** (por defecto 10), `productId` UUID. IDs duplicados se consolidan por producto **antes de validar** el límite y la existencia; 6+5 del mismo SKU se rechaza con 422 `QUANTITY_LIMIT_EXCEEDED` bajo configuración de 10. No hay límite global de 10 unidades para el carrito: es por cada SKU dentro del pedido. Cambio ADMIN del límite versiona settings y puede invalidar cotización anterior. Cliente no envía precios, id dueño ni total. Fecha/ubicación obligatorias en Shop.

Response 200:
```json
{
 "currency":"USD",
 "items":[{"productId":"11111111-1111-4111-8111-111111111111","name":"Caja sorpresa navideña","quantity":2,"unitPriceCents":3650,"lineTotalCents":7300,"availableStock":8,"available":true}],
 "subtotalCents":7300,
 "shipping":{"status":"FREE_INCLUDED","amountCents":0,"includedInPrices":true},
 "tax":{"mode":"SIMULATED","enabled":true,"rateBps":1500,"ratePercent":15,"amountCents":1095},
 "totalCents":8395,"settingsVersion":1,
 "validUntil":"2026-10-22T12:15:00.000Z", "quoteToken":"qtk_DEMO_OPAQUE_EXAMPLE"
}
```
**Importante:** el precio unitario del producto incluye el costo logístico, pero el IVA SIMULADO se presenta por separado. **Ejemplo:** subtotal $73,00 + IVA ficticio $10,95 + envío $0 = total demostrativo $83,95. La pantalla de confirmación debe mostrar exactamente el total de la cotización.

**Importante:** cotización informativa con `quoteToken` válido durante **15 minutos** para refrescar UI; **no reserva stock ni garantiza precio futuro**. `quoteToken` es un token opaco de corta duración **firmado por el backend** que vincula propietario CLIENT, líneas consolidadas, precios unitarios, importe confirmado y vencimiento; React lo trata como opaco y no puede fabricarlo. El token no almacena campos de tarjeta; **incluye también `settingsVersion`, tasa IVA ficticia y reglas comerciales que afectaron el total/fecha/cantidad**. Si cambian antes del pago → 409 `SHOP_SETTINGS_CHANGED` y nueva cotización. Checkout vuelve a calcular todo bajo transacción y **contrasta los precios con el snapshot firmado**. Si algún precio cambia, rechaza `409 PRICE_CHANGED` y exige recotizar y volver a confirmar el importe. No basta comparar totales: puede haber cambios de precios de líneas que se compensan entre sí. Stock y zona siempre se validan otra vez aunque el token siga vigente.

### 10.2 `POST /api/v1/shop/checkout` — CLIENT JWT
Headers `Authorization: Bearer ...`, `Idempotency-Key: <UUID v4 generado al iniciar intención de compra>`, `Content-Type:application/json`.
Payload idéntico a quote más **`quoteToken:string` obligatorio** emitido por el backend durante la cotización y `paymentCard` como en sección 9. `quoteToken` caducado, alterado o inconsistente con configuración vigente → `409 QUOTE_EXPIRED`, `400 VALIDATION_ERROR` o `409 SHOP_SETTINGS_CHANGED` según el caso; nunca cobrar sin nueva confirmación. No enviar `userId`, `status`, `priceCents`, `totalCents`, `paymentStatus`, `stock`, `receiptNumber` ni `createdAt`.

**Respuesta de éxito 201**:
```json
{
  "checkoutAttemptId":"66666666-6666-4666-8666-666666666666",
  "status":"SUCCEEDED",
  "order":{"id":"77777777-7777-4777-8777-777777777777","number":"RG-2026-0125","status":"PENDING","subtotalCents":7300,"taxAmountCents":1095,"taxRateBps":1500,"shippingAmountCents":0,"totalCents":8395,"currency":"USD","scheduledDeliveryDate":"2026-11-15T15:00:00.000Z"},
  "payment":{"status":"APPROVED","amountCents":8395,"cardLast4":"0001","reference":"PAY-DEMO-000125"},
  "receipt":{"id":"88888888-8888-4888-8888-888888888888","number":"CMP-RG-2026-0125"}
}
```
El número comercial `RG-...` es NUEVO, legible, único y no reemplaza el UUID interno; no inferirlo ni construirlo desde React.

**Fallos previstos sin compra confirmada:** `400 VALIDATION_ERROR`, `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 PRODUCT_NOT_FOUND|ZONE_NOT_FOUND`, `409 STOCK_UNAVAILABLE|PRODUCT_UNPUBLISHED|PRICE_CHANGED|QUOTE_EXPIRED|IDEMPOTENCY_KEY_REUSED`, `422 CARD_INVALID|CARD_EXPIRED|INSUFFICIENT_DEMO_FUNDS|DELIVERY_INVALID`, `503 PAYMENT_SIMULATION_DISABLED`. La especificación de errores exacta está en §12. `INSUFFICIENT_DEMO_FUNDS` es una simulación, no respuesta bancaria. También se aplican `QUANTITY_LIMIT_EXCEEDED`, `DELIVERY_OUTSIDE_HOURS`, `SHOP_SETTINGS_CHANGED`.

**Cotización y consentimiento:** el cliente solo pulsa «Pagar» después de ver el total firmado de `quoteToken`. El backend vuelve a bloquear, recalcular y comparar cada precio; `PRICE_CHANGED` obliga a mostrar precios nuevos antes de otra intención de compra.

**Idempotencia:** única `(userId,key)`. Primera invocación registra el intento. Repetición con misma clave y payload semántico igual devuelve exactamente la decisión anterior (incluyendo orderId/receiptId, sin duplicaciones); si distinta carga → 409 `IDEMPOTENCY_KEY_REUSED`. Tras tarjeta rechazada y cambio de tarjeta se genera **nueva clave de intención**. Doble clic usa clave anterior; si timeout, **consultar** §10.3 antes de reintentar y no generar clave nueva a ciegas.

### 10.3 `GET /api/v1/shop/checkout-attempts/:idempotencyKey` — CLIENT JWT
Respuesta 200:
```json
{"status":"PROCESSING","checkoutAttemptId":"66666666-6666-4666-8666-666666666666","orderId":null,"receiptId":null,"errorCode":null,"updatedAt":"2026-10-22T12:00:00.000Z"}
```
Para `SUCCEEDED`, retorna orderId/receiptId; `REJECTED`, errorCode y orderId null; `FAILED`, código sin inventar éxito. 404 si clave no existe o pertenece a otro usuario (no exponer pertenencia). La consulta no cambia saldo ni stock. Si un intento queda atascado PROCESSING, un reconciliador interno debe resolverlo sin compras duplicadas, y la interfaz mantiene estado 07B.

### 10.4 Atomicidad / concurrencia obligatoria

1. Resolver cliente JWT y validar el formato de `Idempotency-Key`. **Antes de rechazar un `quoteToken` por caducidad o cambios comerciales, consultar el intento ya persistido para ese `(userId,idempotencyKey)`**: un reintento de una compra que sí se confirmó debe recuperar el mismo resultado aun si el token expiró después del commit. No devolver `QUOTE_EXPIRED` en lugar del resultado previamente confirmado.
2. Para una clave EXISTENTE, contrastar un identificador canónico seguro de la intención (líneas consolidadas, entrega, quote de origen y tarjeta ficticia validada identificada solo por `fixtureId`); si coincide, devolver exactamente su decisión/referencias; si difiere, `409 IDEMPOTENCY_KEY_REUSED`. Nunca guardar PAN/CVV ni representaciones del CVV. Una tarjeta inválida/rechazada requiere nueva clave para un nuevo intento. Para una clave NUEVA, verificar la firma, vencimiento y contenido de `quoteToken`, y **solo entonces** adquirir su propiedad `(userId,idempotencyKey)` bajo índice único antes de la transacción de compra. Bloquear/reconciliar intentos simultáneos de una misma clave y no repetir débito.
3. Dentro de una transacción PostgreSQL, bloquear productos por ID **en orden determinista** y fila de saldo de tarjeta ficticia según política global de locks; **no desbloquear entre comprobación y actualización**. Revalidar publicación, categoría activa, precios contra las líneas firmadas del quote, stock (`stock >= requested`), límite de unidades por SKU y horarios/IVA/configuración vigentes con `settingsVersion` sobre valores actuales. Un cambio de precio exige nueva aceptación expresa. Si varios productos, venta **todo o nada**.
4. Comprobar autenticidad del fixture sin PAN real, vigencia y saldo `balanceCents >= totalCents` **incluido IVA simulado**. Usar enteros exactos (centavos); descuento de saldo por total (subtotal + taxAmountCents), envío 0. Reducir saldo y stock, crear Order PENDING, OrderItems con snapshots, PaymentAttempt APPROVED, PurchaseReceipt única, marcar CheckoutAttempt SUCCEEDED: **una misma transacción lógica**. Si falla cualquiera, rollback de todo; ninguna venta parcial.
5. Fallo de stock devuelve `409 STOCK_UNAVAILABLE` indicando productId y `availableStock` sin restar al cliente rechazado ni crear comprobante; fallo de saldo `422 INSUFFICIENT_DEMO_FUNDS`, con saldo sin cambio. Se permite registro auditado de un intento rechazado sin venta, evitando mezclar transacción abortada con error de integridad.
6. Dos CLIENT simultáneos con stock inicial 1: una sola orden aprobada; inventario final 0; el otro ve agotado, carrito editable, su tarjeta sin débito. El mismo criterio vale para dos compras con saldo conjunto insuficiente. Asegurar transacción de lecturas/locks en el **mismo connection pinning** de Prisma 8 existente.
7. Tras crash, red desconectada, timeout, deadlock o rollback: recuperar por clave, evitar duplicados, y jamás mostrar pantalla de compra confirmada sin respuesta verificada. Los errores transitorios se pueden reintentar controladamente con la misma clave tras resolver el estado, no ciegamente.

## 11. Mis pedidos, estados y comprobantes

**GET `/api/v1/shop/orders?page=1&pageSize=10&status=PENDING|ASSIGNED|IN_TRANSIT|DELIVERED|CANCELLED`** — CLIENT JWT, orden `createdAt desc,id desc`, envelope paginado. Resumen por pedido:
```json
{"id":"77777777-7777-4777-8777-777777777777","number":"RG-2026-0125","createdAt":"2026-10-22T12:00:00.000Z","scheduledDeliveryDate":"2026-11-15T15:00:00.000Z","status":"PENDING","subtotalCents":7300,"taxAmountCents":1095,"taxRateBps":1500,"shippingAmountCents":0,"totalCents":8395,"currency":"USD","paymentStatus":"APPROVED","receiptId":"88888888-8888-4888-8888-888888888888","itemsCount":2,"primaryImageUrl":"https://res.cloudinary.com/demo/image/upload/v1/regalia/products/foto.jpg"}
```

**GET `/api/v1/shop/orders/:id`** — CLIENT JWT, dueño exclusivamente, 404 a ajenos. Respuesta
```json
{
 "id":"77777777-7777-4777-8777-777777777777","number":"RG-2026-0125","createdAt":"2026-10-22T12:00:00.000Z","scheduledDeliveryDate":"2026-11-15T15:00:00.000Z",
 "status":"PENDING","routeId":null,"currency":"USD","subtotalCents":7300,"taxAmountCents":1095,"taxRateBps":1500,"shippingAmountCents":0,"totalCents":8395,"paymentStatus":"APPROVED",
 "buyer":{"id":"99999999-9999-4999-8999-999999999999","name":"María Pérez","email":"maria@example.test"},
 "recipient":{"name":"Ana Regalo","phone":"0991234567"},
 "delivery":{"zoneId":"55555555-5555-4555-8555-555555555555","zoneName":"Centro","address":"Av. Cevallos y Montalvo, Ambato","location":{"lat":-1.2425,"lng":-78.6188},"scheduledDeliveryDate":"2026-11-15T15:00:00.000Z","notes":null},
 "items":[{"productId":"11111111-1111-4111-8111-111111111111","sku":"REG-NAV-001","name":"Caja sorpresa navideña","quantity":2,"unitPriceCents":3650,"lineTotalCents":7300,"imageUrl":null}],
 "timeline":[{"code":"PENDING","label":"Pedido registrado","at":"2026-10-22T12:00:00.000Z"}],
 "receiptId":"88888888-8888-4888-8888-888888888888"
}
```
Timeline refleja eventos persistidos y verificables; **no inventar marcas temporales** ni GPS. Estados de fallos de visita visibles por un historial autorizado, sin sustituir arbitrariamente OrderStatus por `FAILED`. El CLIENT no modifica rutas/estados ni visualiza datos personales del driver fuera de lo necesario.

**GET `/api/v1/shop/orders/:id/receipt`** — CLIENT dueño; `200 Receipt` como JSON renderizable/imprimible desde navegador; descargar PDF no obligatorio en v1:
```json
{
 "id":"88888888-8888-4888-8888-888888888888","number":"CMP-RG-2026-0125","orderId":"77777777-7777-4777-8777-777777777777","issuedAt":"2026-10-22T12:00:00.000Z",
 "merchantName":"REGALÍA","buyer":{"name":"María Pérez","email":"maria@example.test"},
 "recipient":{"name":"Ana Regalo"},"items":[{"sku":"REG-NAV-001","name":"Caja sorpresa navideña","quantity":2,"unitPriceCents":3650,"lineTotalCents":7300}],
 "currency":"USD","subtotalCents":7300,"tax":{"mode":"SIMULATED","rateBps":1500,"amountCents":1095},"shipping":{"status":"FREE_INCLUDED","amountCents":0,"includedInPrices":true},"totalCents":8395,"payment":{"status":"APPROVED","reference":"PAY-DEMO-000125","cardLast4":"0001"},
 "disclaimer":"COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA"
}
```
`orderId` y `paymentId` únicos. No generar comprobante para rechazos; consultar comprobante de otro usuario devuelve 404. No generar RUC, clave de acceso, XML, firma SRI ni tributos oficiales: **sí se muestra un IVA simulado de 15% configurable** claramente identificado como demostración y conservado como snapshot histórico, sin afirmación fiscal.

## 12. Tabla de errores estables (NUEVO)

```json
{
  "error": {
    "code":"STOCK_UNAVAILABLE",
    "message":"Este producto se agotó y no está disponible por ahora.",
    "details":{"productId":"11111111-1111-4111-8111-111111111111","requestedQuantity":2,"availableStock":0},
    "requestId":"req-01HXEXAMPLE"
  }
}
```
No incluir contraseña, token, número completo de tarjeta, CVV, firma Cloudinary o URL secreta en `details`.

| HTTP | Código | Cuándo | Acción UI |
|---|---|---|---|
| 400 | VALIDATION_ERROR | tipos, formato, campo desconocido, monto cliente, fecha sin offset | errores por campo sin perder inputs |
| 401 | UNAUTHENTICATED | sin JWT/expirado | login Shop y retorno seguro |
| 403 | FORBIDDEN | rol CLIENT en rutas ADMIN o acceso no permitido | acceso denegado, no filtrar secretos |
| 404 | PRODUCT_NOT_FOUND | SKU/ID inexistente | volver al catálogo |
| 404 | ZONE_NOT_FOUND | zona inexistente | volver a selección de zona |
| 404 | ORDER_NOT_FOUND | pedido ajeno/inexistente | no revelar recursos de terceros |
| 404 | CHECKOUT_ATTEMPT_NOT_FOUND | clave de otro usuario/inexistente | indicar verificación asistida, nunca autorizar recobro automático |
| 409 | STOCK_UNAVAILABLE | unidades insuficientes tras bloqueo concurrente | variante 06B agotado; conservar carrito, ajustar |
| 409 | PRODUCT_UNPUBLISHED | producto/categoría no visible al checkout | retirar/actualizar selección |
| 409 | PRICE_CHANGED | precio de una línea difiere del snapshot firmado, aunque total coincidiera | refrescar quote y pedir nueva confirmación |
| 409 | QUOTE_EXPIRED | token firmado de cotización expirado | generar nuevo quote y reconfirmar total |
| 409 | IDEMPOTENCY_KEY_REUSED | misma clave con payload diferente | crear nueva intención solo tras resolución del anterior |
| 409 | SKU_ALREADY_EXISTS | SKU duplicado ADMIN | editar SKU (antes de crear) |
| 409 | CATEGORY_ALREADY_EXISTS | slug duplicado ADMIN | corregir categoría |
| 422 | CARD_INVALID | tarjeta de prueba no existe/incorrecta | editar campos 07A |
| 422 | CARD_EXPIRED | vencimiento ficticio pasado | editar tarjeta 07A |
| 422 | INSUFFICIENT_DEMO_FUNDS | saldo de fixture insuficiente | 07A rechazada sin pedido |
| 422 | DELIVERY_INVALID | zona sin depósito, coordenadas inválidas o fecha pasada | corregir checkout |
| 422 | DELIVERY_OUTSIDE_HOURS | hora local de Ambato fuera de franja ADMIN (por defecto 07:00–17:00 inclusive) | elegir hora admitida |
| 422 | QUANTITY_LIMIT_EXCEEDED | cantidad consolidada por SKU mayor que límite ADMIN (por defecto 10) | reducir unidades |
| 409 | SHOP_SETTINGS_CHANGED | tasa IVA, límite u horario ADMIN cambió desde cotización | nueva cotización y confirmación del total |
| 409 | SETTINGS_VERSION_CONFLICT | ADMIN edita configuración a partir de versión desactualizada | refrescar ajustes antes de guardar |
| 413 | IMAGE_TOO_LARGE | archivo > 5 MiB | reducir imagen |
| 415 | IMAGE_UNSUPPORTED | contenido no es JPEG/PNG/WebP | cambiar archivo |
| 422 | IMAGE_ASSOCIATION_FAILED | uploadId no autorizado, vencido, usado | volver a cargar/seleccionar |
| 502 | UPLOAD_FAILED | proveedor Cloudinary falló | reintentar subida sin duplicar producto |
| 503 | PAYMENT_SIMULATION_DISABLED | entorno sin pagos DEMO habilitados | bloqueo explícito de checkout |
| 500 | INTERNAL_ERROR | error no recuperable | mensaje neutro + requestId; nunca inventar éxito |

Los códigos `CARD_INVALID`, etc. son **contrato nuevo**, no errores comprobados de API actual. No fabricar error por reactividad local antes de recibir/interpretar la respuesta del backend; validación de campos UI sí puede anticipar errores de formato.

## 13. Matriz permisos y visibilidad

| Recurso/operación | Anónimo | CLIENT | ADMIN | DRIVER |
|---|---:|---:|---:|---:|
| Shop catálogo/imagen pública | Sí | Sí | Sí | Sí |
| Registro CLIENT, login | Sí | Sí (si cierra/gestiona sesión) | Sí | Sí |
| Checkout quote, compra y verificar intento | No | Propio | No (sin suplantar cliente) | No |
| Historial, detalle y comprobante Shop | No | Solo propio | Por ADMIN existente, con endpoint administrativo específico si requiere | No |
| ADMIN productos/categorías/uploads y configuración Shop | No | No | Sí | No |
| API órdenes logísticas ADMIN | No | No | Sí | Según endpoints DRIVER permitidos |
| Flutter ruta propia del driver | No | No | Solo vistas ADMIN específicas | Solo asignado |

Nunca confiar en `userId` suministrado por la UI. Backend determina dueño desde JWT. El dueño puede ver su teléfono destinatario; el endpoint general de órdenes histórico debe conservar proyección que protege información según rol. No reutilizar respuesta ADMIN íntegra en pantalla CLIENT.

## 14. Pantallas funcionales ↔ rutas ↔ endpoints (Figma solo orientativo)

| Pantalla | Ruta React propuesta | Consumo API nuevo o existente |
|---|---|---|
| 01 Inicio | `/shop` | `GET /shop/categories`, `/shop/products?sort=featured` |
| 02 Catálogo | `/shop/catalogo` | `GET /shop/products` con query |
| 03 Producto | `/shop/productos/:id` | `GET /shop/products/:id` |
| 06 Carrito + 06A/06B | `/shop/carrito` | Estado local; revalidación via `POST /shop/checkout/quote` |
| 10 Registro | `/shop/registro` | `POST /auth/register` |
| 11 Login | `/shop/login` | `POST /auth/login` |
| 04 Checkout | `/shop/checkout` | `GET /zones`; `GET /shop/settings`; `POST /shop/checkout/quote` |
| Ajustes operativos ADMIN | `/configuracion/shop` dentro del panel existente | `GET/PATCH /admin/shop-settings` |
| 07 Pago + 07A/07B | `/shop/pago` | `POST /shop/checkout`; `GET /shop/checkout-attempts/:key` |
| 12 Confirmación | `/shop/confirmacion/:id` | `GET /shop/orders/:id` |
| 13 Comprobante | `/shop/mis-pedidos/:id/comprobante` | `GET /shop/orders/:id/receipt` |
| 08 Historial | `/shop/mis-pedidos` | `GET /shop/orders` |
| 14 Detalle | `/shop/mis-pedidos/:id` | `GET /shop/orders/:id` |
| 09 ADMIN Catálogo (referencia) | `/productos` y `/categorias` | `/admin/catalog/*` (no rediseñar ADMIN global) |

06B se muestra **dentro del carrito existente**, no como menú adicional. 07A/07B son variantes de `/shop/pago`, no URLs obligatorias. La variante 07B bloquea repetir el checkout hasta conocer el resultado del attempt.

## 15. Matriz exhaustiva de pruebas mínimas de contrato

| ID | Escenario | Esperado / evidencia |
|---|---|---|
| CT-001 | Shop anónimo lista categorías/productos | 200; no recursos ADMIN |
| CT-002 | Paginación 200 registros (12 por página) | 17 páginas, última 8; orden estable sin duplicados |
| CT-003 | Sin stock y `inStock=false` | aparece `isAvailable=false`; sin añadir |
| CT-004 | Producto no publicado o categoría inactiva | no listado, detalle 404 |
| CT-005 | Filtros combinados precio/categoría/búsqueda | solo coincidencias; validación rango |
| CT-006 | Registro `role=ADMIN` enviado por anónimo | 400; ninguna cuenta privilegiada |
| CT-007 | Login CLIENT y acceso a `/productos` ADMIN | 403 en API/redirect permitido en UI, sin datos |
| CT-008 | Checkout sin contacto, fecha, zona o coordenadas | 400/422 tipificado; sin compra |
| CT-009 | Fecha sin offset y fecha vencida tras espera lock | 400/422; sin compra |
| CT-010 | Tarjeta DEMO válida saldo suficiente | 201, pago aprobado, saldo y stock reducidos, 1 pedido |
| CT-011 | Tarjeta DEMO con saldo 0 | 422, sin pedido, stock/saldo sin cambios, sin comprobante |
| CT-012 | Tarjeta no fixture / vencida / nombre incorrecto / CVV erróneo | 422; sin datos secretos en logs |
| CT-013 | Precio manipulado o total enviado por React | 400; total recalculado por backend |
| CT-014 | 2 clientes simultáneos, 1 unidad | 1 aprobado, 1 `STOCK_UNAVAILABLE`, stock final 0, no dos cobros |
| CT-015 | 2 compras simultáneas agotan saldo de misma tarjeta | no saldo negativo ni doble aprobación |
| CT-016 | 2 productos, uno sin stock | transacción total revertida, ningún ítem reservado ni cobrado |
| CT-017 | DOBLE CLIC misma `Idempotency-Key` | una orden/comprobante, misma respuesta al repetir |
| CT-018 | Misma clave, payload cambiado | 409 `IDEMPOTENCY_KEY_REUSED` |
| CT-019 | Timeout tras commit, consulta por clave | `SUCCEEDED` y mismo orderId; no recobro |
| CT-020 | Fallo forzado DB antes de commit | rollback total y recuperación del intento |
| CT-021 | Historial, detalle y comprobante de otro CLIENT | 404/403 sin exponer datos |
| CT-022 | ADMIN CRUD producto agotado, publicar sin imagen | gestión permitida, publicación rechazada |
| CT-023 | CLIENT/anónimo upload Cloudinary | 401/403 sin subir bytes ni firmar |
| CT-024 | ADMIN JPG/PNG/WebP correcto | URL Cloudinary y publicId guardados |
| CT-025 | Upload MIME inválido > límite | 415/413, ninguna imagen asociada |
| CT-026 | 2 imágenes marcadas principales | solo 1 principal o conflicto determinista |
| CT-027 | Cambio precio tras compra | OrderItem/comprobante conservan valores históricos |
| CT-028 | Cambio estado desde Flutter | Shop muestra transición respaldada, no GPS ficticio |
| CT-029 | Seeder 200 regalos repetido | sin duplicación, no sobrescribe datos de negocio |
| CT-030 | Regresión rutas ADMIN y POST `/orders` actual | siguen funcionando y no cambian sus envelopes existentes |
| CT-031 | Cambio de zona con ubicación previa en frontend | marcador pierde confirmación y exige nueva selección |
| CT-032 | Cancelación/no validación posterior | no se considera entrega; **sin devolución de saldo ni reposición automática**; política de reversión diferida hasta decisión expresa |
| CT-033 | Envío incluido en precio | GET Shop settings y quote devuelven FREE_INCLUDED, 0 centavos; ninguna comisión oculta |
| CT-034 | IVA simulado 15% | subtotal 7300 → impuesto 1095 → total 8395; etiqueta simulación en UI y comprobante |
| CT-035 | Cambio tasa IVA por ADMIN | versión de ajustes sube; quote antiguo devuelve SHOP_SETTINGS_CHANGED; nuevo quote usa tasa nueva |
| CT-036 | IVA simulado deshabilitado por ADMIN | taxAmountCents=0 y total=subtotal; captura enabled=false y rate en comprobante |
| CT-037 | Límite 10 por SKU | qty 10 acepta si hay stock; qty 11 o duplicados 6+5 rechaza sin descontar stock/saldo |
| CT-038 | ADMIN cambia máximo a 5 | ajuste versionado; frontend actualiza, backend rechaza 6 incluso con UI manipulada |
| CT-039 | Horario de entrega | 06:59 rechaza; 07:00 y 17:00 aceptan; 17:01 rechaza (hora local America/Guayaquil) |
| CT-040 | ADMIN cambia horario de atención | quote anterior invalida settingsVersion; nuevo valida límites vigentes |
| CT-041 | Cambio de IVA entre cotización y pago | 409 SHOP_SETTINGS_CHANGED y nueva confirmación; no cobro sin consentimiento |
| CT-042 | Migración aditiva Float legado | respaldo/backfill, diferencias auditadas >2 decimales, doble lectura y rollback sin alterar precios históricos |
| CT-043 | CLIENT intenta editar shop-settings | 403; no altera configuración |

Backend unitarios + integración **contra PostgreSQL real**; frontend Vitest/React Testing Library y E2E de flujo Shop→ADMIN→DRIVER. Mateo aporta dataset e integra evidencias. Nunca declarar PASS solo porque el escenario esté escrito.

## 16. Despliegue, límites y configuración

- ADMIN solo consulta el envío (gratis, **no editable en v1.2**). El ADMIN configura `taxRateBps=1500` / `taxEnabled=true`, `maxUnitsPerSkuPerOrder=10`, horario local `07:00–17:00`, mediante `/admin/shop-settings` y versionado optimista; panel frontend presenta formulario ADMIN. Solo tasas ficticias, nunca facturas SRI reales.
- Env backend: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` protegidos; `SIMULATED_PAYMENTS_ENABLED` **false fuera de demo/test**; `BUSINESS_TIME_ZONE=America/Guayaquil` documentado; no VITE/React secrets.
- CORS: limitar orígenes de React desplegado; backend actual usa CORS abierto, endurecer configuración antes de exposición pública. No afirmar seguridad solo por ocultar botones.
- Semillas reproducibles e idempotentes para 200 productos, categorías, imágenes legítimas y las 3 tarjetas de prueba con balances; evitar sobrescribir producción/historia.
- UI: loading, empty, errors, reintento, aborts; disable submit durante request, but no confiar en disable del navegador para consistencia.
- OpenAPI debe exponer DTO y status de endpoints nuevos. Versionar contratos compartidos, ejecutar tests de consumidores y no fusionar PR incompatibles.

## 17. Orden y responsabilidad para implementación

| Etapa | Backend | Frontend Kerly | QA Mateo |
|---|---|---|---|
| 0 Seguridad | backend #31 | #20 auth CLIENT (UI separada) | role escalation tests |
| 1 Contrato catálogo | backend #32 | frontend #19 estructura/contrato, #21 ADMIN | #35 estructura de 200 productos |
| 2 Catálogo + Cloudinary | backend #32 API y DB | frontend #19 filtros/detalle, #21 CRUD | seed real, tests |
| 3 Quote y checkout | backend #33 | frontend #20 carrito/mapa | concurrencia y error cases |
| 4 Comprobante | backend #34 | frontend #20 historial/comprobante | inmutabilidad y E2E |
| 5 Validación general | backend #31-34 | frontend #19-21 | #35 + Flutter/Carlos |

**Acuerdos prioritarios con Kerly:** congelar el sobre de errores, regla envío gratis + IVA ficticio configurable + settingsVersion, máximos SKU/horarios, moneda/centavos, nombres exactos de campos y path `/api/v1/shop/*`, diferencia lista ADMIN/pública, DTO `DeliveryInput`, JSON `paymentCard` y `Idempotency-Key`. Un mock MSW debe ajustarse a este contrato, no al revés.

## 18. Decisiones del líder vigentes, exclusiones y acuerdos diferidos

1. **ENVÍO GRATIS (APROBADO):** está absorbido en los precios de productos. `shipping.status=FREE_INCLUDED`, `amountCents=0`, `includedInPrices=true`; el ADMIN no puede cobrar envío adicional desde este contrato.
2. **IVA FICTICIO CONFIGURABLE (APROBADO):** por defecto `taxEnabled=true`, `taxRateBps=1500` (15%) calculado sobre subtotal. Se muestra como IVA **simulado**, no fiscal. ADMIN puede modificar la tasa/desactivar y se conserva tasa+importe históricos. Jamás emitir SRI/IVA tributario oficial.
3. **CANCELACIONES (DIFERIDO):** las cancelaciones administrativas existentes siguen operando; no realizar **devoluciones ni reposición automática** hasta decidir reglas auditables. Preparar modelo/servicio de ajustes y reversiones versionable sin activar endpoints públicos ni cambios monetarios.
4. **RECUPERACIÓN DE CONTRASEÑA Y EMAIL (DIFERIDO):** se admite preparar interfaces de servicio y plantillas detrás de feature flag desactivada, pero no se exige implementación ni correos reales. No crear enlaces ni flujos que aparenten estar funcionando.
5. **CANTIDADES (APROBADO):** máximo **10 por SKU y por pedido** por defecto, ajustable ADMIN desde 1 a 100. No es máximo 10 por carrito entero; consolidar líneas repetidas por SKU antes de validar. Debe existir stock suficiente en BD.
6. **HORARIO (APROBADO):** **07:00–17:00 inclusive** en `America/Guayaquil` (Ambato/Ecuador continental), configurable ADMIN. Fecha elegida es una hora aproximada concreta dentro del horario, no intervalo formal de entrega.
7. **CLOUDINARY (DECISIÓN TÉCNICA):** mantener subida a través de backend proxy autenticado ADMIN. Permite valida JWT/MIME/bytes y mantener secretos fuera del navegador. La política puede cambiarse solo mediante nuevo contrato versionado y pruebas.
8. **MIGRACIÓN FLOAT (DECISIÓN TÉCNICA):** añadir columnas en centavos, auditar conversiones, doble escritura temporal, comparaciones e implementación reversible con respaldo y rollback; **ninguna modificación retroactiva de históricos**.
9. **PENDIENTE DE FUTURO DOCENTE:** devolución efectiva al cancelar, franjas con capacidad o rutas por conductor, emails, restablecimiento real de contraseñas, impuesto SRI real. No incluirlos en alcance funcional por defecto.

---

**Regla de aprobación:** para congelar versión `1.2.0`, backend, frontend y QA validan el contrato completo, OpenAPI, Swagger, tipos TS, pruebas y consumidores. El documento no modifica por sí solo ninguna base de datos ni endpoint existente.


## 19. Especificación ejecutable por agente: autenticación (#31) y criterios de compatibilidad

Esta sección facilita implementar la primera Issue de manera **autónoma**, sin buscar contratos en una adenda. Es un resumen normativo del contrato de la sección 4 y de la Issue backend #31; no autoriza refactorizaciones fuera de su alcance.

| Operación | Método/path | Entrada obligatoria | Resultado exitoso | Rechazos principales |
|---|---|---|---|---|
| Registro público | POST `/api/v1/auth/register` | `name` (2..120), `email` (normalizado, único), `password` (8..128) | 201 `{id,name,email,role:"CLIENT",createdAt}` | 400 `VALIDATION_ERROR`; 409 `EMAIL_ALREADY_EXISTS` |
| Login actual | POST `/api/v1/auth/login` | `email`, `password` | 200 `{access_token,user:{id,name,email,role}}` | 401 `INVALID_CREDENTIALS` |

**Invariantes de seguridad:** el registro **no acepta** ninguna propiedad `role`, incluso con valor `CLIENT`; deniega explícitamente ADMIN/DRIVER/otros campos usando la validación estricta actual. Solo servidor establece rol. El servicio y los serializadores no exponen `password` hasheado, JWT secretos ni hashes; el login de cuentas ADMIN, CLIENT y DRIVER existentes permanece operativo. Los campos de nombre/email se validan y normalizan de modo coherente con los índices únicos. La verificación de existencia previa **no sustituye** capturar la carrera de unicidad PostgreSQL para devolver 409 en peticiones simultáneas.

**Compatibilidad importante:** el código anterior permite passwords de alta de mínimo 6 caracteres; exigir >=8 en registros **nuevos** no debe impedir el login de cuentas antiguas válidas ni exigir que se reescriban contraseñas existentes. No cambiar la firma pública del JWT ni los guards existentes de ADMIN/DRIVER sin test de compatibilidad.

**Pruebas contractuales específicas:** (a) alta legítima CLIENT 201; (b) alta con `role=CLIENT|ADMIN|DRIVER` 400; (c) campos `isAdmin`/`createdAt` extra 400; (d) email inválido y campos vacíos 400; (e) email duplicado, incluso en carrera, 409 sin 500; (f) respuesta no contiene hash, token de registro ni secretos; (g) ADMIN/DRIVER/CLIENT hacen login tras el cambio; (h) CLIENT no accede a CRUD ADMIN ni carga de imágenes.

**Secuencia mínima para el agente:** inspeccionar DTO/controller/service/guards y tests actuales → introducir corrección aditiva y pruebas → ejecutar lint, typecheck, unit tests y E2E relevantes → publicar PR revisable con evidencia → **no fusionar**. No implementar catálogo ni checkout dentro de #31.

## 20. Trazabilidad, estado de implementación y dependencias

| Backend / responsabilidad | Frontend consumidor / responsabilidad | Condición para declarar integrado |
|---|---|---|
| #31 Saimol: registro seguro CLIENT, roles y proyecciones | #20 Kerly: registro/login CLIENT, guards separados | Pruebas 201/400/401/403/409, login legacy válido |
| #32 Saimol: categorías, productos, migración centavos y Cloudinary | #19 Kerly: inicio/catálogo/detalle; #21 Kerly: CRUD ADMIN | DTO reales + Swagger/OpenAPI y 200 productos QA |
| #33 Saimol: settings, cotización, IVA ficticio, tarjetas y checkout atómico | #20 Kerly: carrito/entrega/tarjeta/estados; #21 Kerly: ajustes ADMIN | PostgreSQL concurrencia/idempotencia, versión de settings, suma económica consistente |
| #34 Saimol: recibo, historial, proyecciones CLIENT | #20 Kerly: confirmación/comprobante/mis pedidos/seguimiento | Snapshots inmutables, autorización por dueño y estados logísticos reales |
| #35 Mateo: datos demo y QA end-to-end | #19/#20/#21, Flutter DRIVER | Evidencia CT-001..CT-043, sin marcar PASS antes de ejecutar |

**Código existente que no debe romperse:** autenticación ADMIN/DRIVER, `/api/v1/products` (arreglo stock>0), `/api/v1/orders` CLIENT sin pago, `/api/v1/orders/admin`, `/api/v1/orders/my-orders`, `/api/v1/orders/:id`, `/api/v1/zones`, rutas, urgencias, planificación y seguimiento Flutter. Los nuevos endpoints `/shop/*` y `/admin/catalog/*` se agregan **sin sustituirlos**. El backend existente ya usa `Prisma 8/PostgreSQL`, `Temporal.Instant` y bloqueos de stock; comprobar su estado real al comenzar.

**Criterio para congelar 1.2.0:** responsables backend/frontend/QA validan nombres, tipos, cuerpos, errores, seguridad, migraciones y pruebas; el PR incorpora contrato OpenAPI coincidente, pruebas de consumidor y Swagger. Si hay conflicto con una Issue, corregir la Issue o el contrato y registrarlo. Hasta entonces, «propuesto» no significa «implementado».

## 21. Registro de consolidación y fuentes

- **Base normativa del alcance:** [ESP-SHOP-001 v1.2](https://docs.google.com/document/d/1hPLYkA885tqwjhNWZ08IW7KjSqUPZV1TIAge4_OQ5SQ/edit), aprobado para planificación e Issues.
- **Contrato técnico precedente:** CI-SHOP-001 v1.0 (24 operaciones HTTP, 47 esquemas) — reemplazado por este documento consolidado.
- **Actualización técnica previa:** CI-SHOP-001 v1.1 + adenda comercial (27 operaciones HTTP, 57 esquemas) — integradas **en el cuerpo** de este documento, no se requiere lectura separada.
- **Issues de ejecución:** backend [#31](https://github.com/logistica-gc-uta/backend/issues/31), [#32](https://github.com/logistica-gc-uta/backend/issues/32), [#33](https://github.com/logistica-gc-uta/backend/issues/33), [#34](https://github.com/logistica-gc-uta/backend/issues/34), [#35](https://github.com/logistica-gc-uta/backend/issues/35); frontend [#19](https://github.com/logistica-gc-uta/frontend-web-logistica/issues/19), [#20](https://github.com/logistica-gc-uta/frontend-web-logistica/issues/20), [#21](https://github.com/logistica-gc-uta/frontend-web-logistica/issues/21).
- **Referencia visual:** [Figma REGALÍA](https://www.figma.com/design/Gt0COrpEq6AXBSWrZ21ejX) **opcional** y no normativo para implementación.
- **Fecha de integración de la información:** 23 de octubre de 2026. Los ejemplos de fechas y entidades son ilustrativos, no pruebas de backend desplegado.

**Regla única para lectores y agentes:** utilizar **CI-SHOP-001 v1.2 CONSOLIDADO** y su OpenAPI 3.1 v1.2. No mezclar v1.0, v1.1, la adenda ni cifras históricas del mockup como fuente de campos o totales. Implementar por Issue con pruebas, sin merge automático.
