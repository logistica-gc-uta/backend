# Issue #11 — contrato de registro administrativo de pedidos (propuesta para implementación)

> **Estado:** diseño propuesto y no implementado. Este documento define el contrato pendiente de código, migraciones Prisma 8, pruebas con PostgreSQL y aprobación de frontend. **No habilita todavía** `POST /api/v1/orders/admin`. No cerrar la Issue #11 ni usar `Closes #11` hasta satisfacer sus criterios.

## 1. Antecedentes verificados

- La Issue #11 fue reabierta: el PR #18 de plantilla la había cerrado accidentalmente.
- Actualmente `POST /api/v1/orders` solo acepta CLIENT y pasa `@CurrentUser('userId')` a `OrdersService.createOrder`.
- `Order.userId` es FK obligatoria a `User`; no existe autoría separada ni destinatario invitado.
- Los productos se consultan y validan **fuera** de la transacción; luego se escribe stock absoluto calculado antes. Ese patrón puede perder actualizaciones o sobre-vender bajo concurrencia.
- `scheduledDeliveryDate` actualmente es opcional, y no se rechazan fechas anteriores al momento de crear el pedido.
- La planificación (#7) utiliza `scheduledDeliveryDate`; la confirmación de rutas (#10, PR #25 pendiente) debe conservar su propia validación de día local.

## 2. Decisión funcional: propietario, destinatario y creador son conceptos diferentes

**No crear cuentas falsas** para invitados. Nunca guardar `userId` del ADMIN como propietario de un pedido de otra persona.

| Concepto | CLIENT autenticado | ADMIN para cliente existente | ADMIN para destinatario sin cuenta |
| --- | --- | --- | --- |
| Propietario `Order.userId` | `JWT.userId` | ID de un usuario **CLIENT** existente, comprobado en BD | `NULL` (no existe cuenta) |
| Destinatario | Perfil del cliente; instantánea del nombre | Perfil del cliente elegido; instantánea del nombre | Nombre y teléfono proporcionados en el formulario |
| Creador `Order.createdById` | `JWT.userId` | `JWT.userId` del ADMIN | `JWT.userId` del ADMIN |
| Privacidad | Solo el cliente propietario ve su historial | Solo el cliente propietario ve su historial | Ningún CLIENT obtiene acceso por no existir propietario |

La entidad `User` representa identidad autenticable, **no** una ficha de entrega. El invitado no obtiene JWT ni puede usar `GET /orders/my-orders`. El destinatario es quien recibe los productos en la dirección georreferenciada; el propietario es quien posee el acceso digital al pedido. En pedidos guest el propietario digital es inexistente y las operaciones administrativas siguen controladas por ADMIN.

### Modelo relacional propuesto

Cambios **aditivos y de compatibilidad**, a emitir correctamente con Prisma 8:

- `Order.userId String?` / relación `user User?`: nullable para pedidos guest; conservar FK e índice.
- `Order.createdById String?` y relación explícita `createdBy User?`: autoría de nuevos pedidos; NULL histórico cuando el actor original no sea verificable.
- `Order.recipientType`: `REGISTERED_CLIENT` o `GUEST` para pedidos nuevos; permitir estado histórico no verificado durante migración sin inventar datos.
- `Order.recipientName String?`: instantánea al confirmar pedido; no leer el nombre dinámicamente si luego cambia el perfil. Obligatorio en pedidos nuevos.
- `Order.recipientPhone String?`: contacto de entrega aportado por ADMIN (obligatorio para GUEST, opcional para REGISTERED_CLIENT según acuerdo de UI); no utilizar este campo como identificador autenticable.
- `Order.deliveryWindowStart DateTime?`, `deliveryWindowEnd DateTime?`: franja solicitada. Asegurar orden temporal y mismo día local que `scheduledDeliveryDate`.
- Índices para búsqueda ADMIN por `scheduledDeliveryDate`, `zoneId`, `status`; sin alterar el índice y ciclo de vida de `RouteStop`/`OrderClaim`.

Agregar una invariante PostgreSQL, documentada y verificada sobre los nuevos registros: `recipientType=GUEST => userId IS NULL AND recipientName/recipientPhone no vacíos`; `recipientType=REGISTERED_CLIENT => userId IS NOT NULL AND recipientName no vacío`. Adaptarla para filas históricas sin clasificar. No inventar destinatarios ni creador durante backfill. Evitar restricciones que impidan migrar datos válidos legados.

Declarar relaciones múltiples `User.orders` y `User.createdOrders` con nombres explícitos en Prisma para evitar colisiones de relaciones. Verificar dependencias de `Order.userId` en consultas, seed, DTOs, tests, rutas, snapshots y proyecciones.

**Prisma 8:** modificar `src/prisma/contract.prisma`, emitir `contract.json`/`contract.d.ts`, crear migración real `migration.ts`, `ops.json`, snapshots/hashes y verificar la cadena con el CLI del repositorio. **No modificar hashes/ops manualmente** ni aplicar migraciones sobre bases compartidas.

## 3. API propuesta para React

Conservar `POST /api/v1/orders` para CLIENT sin permitir `clientId` ni sobrescritura del actor.

Agregar **`POST /api/v1/orders/admin`**, solo ADMIN autenticado mediante JWT de producción y `RolesGuard`. Ni CLIENT ni DRIVER pueden invocarlo. El actor `createdById` **nunca** proviene del body.

### Variante A: cliente registrado

```json
{
  "recipient": {
    "type": "REGISTERED_CLIENT",
    "clientId": "UUID_CLIENT_EXISTENTE",
    "contactPhone": "+593999999999"
  },
  "zoneId": "UUID_ZONA",
  "deliveryAddress": "Dirección validada por la interfaz",
  "deliveryLat": -1.24908,
  "deliveryLng": -78.61675,
  "scheduledDeliveryDate": "2030-02-14T15:00:00Z",
  "deliveryWindowStart": "2030-02-14T15:00:00Z",
  "deliveryWindowEnd": "2030-02-14T17:00:00Z",
  "items": [{ "productId": "UUID_PRODUCTO", "quantity": 2 }]
}
```

### Variante B: invitado sin cuenta

```json
{
  "recipient": {
    "type": "GUEST",
    "name": "Destinatario de ejemplo",
    "contactPhone": "+593999999999"
  },
  "zoneId": "UUID_ZONA",
  "deliveryAddress": "Dirección validada por la interfaz",
  "deliveryLat": -1.24908,
  "deliveryLng": -78.61675,
  "scheduledDeliveryDate": "2030-02-14T15:00:00Z",
  "deliveryWindowStart": "2030-02-14T15:00:00Z",
  "deliveryWindowEnd": "2030-02-14T17:00:00Z",
  "items": [{ "productId": "UUID_PRODUCTO", "quantity": 2 }]
}
```

Los ejemplos usan IDs simbólicos y fechas futuras; son **contratos propuestos**, no peticiones verificadas. Validar estrictamente el discriminador y prohibir campos adicionales y variantes mezcladas. Para REGISTERED_CLIENT, consultar el usuario y comprobar `role === CLIENT`, sin confiar en la identidad o nombre suministrados por el navegador. Para GUEST, prohibir `clientId`; validar nombre y teléfono con longitud acotada y normalización mínima, sin crear credenciales.

La respuesta `201` debe incluir `id`, `userId: string | null`, `createdById`, `recipientType`, `recipientName`, `recipientPhone` (solo para roles autorizados), zona, coordenadas, fecha/franja, líneas, total y `status: PENDING`. Documentar tipos anulables con OpenAPI real. La visibilidad de teléfono/nombre de invitado en consultas DRIVER debe limitarse estrictamente a su ruta propia; no incluirlos en difusiones públicas o logs.

### Fechas, ubicación y planificación

- Interpretar día operativo en `America/Guayaquil`, sin usar timezone del servidor.
- `createdAt`: instante fijado por el servidor; nunca equivale a fecha solicitada de entrega.
- `scheduledDeliveryDate`: instante de entrega acordado, requerido en ADMIN y **no pasado** al crear.
- `deliveryWindowStart` y `deliveryWindowEnd`: instantes ISO con zona explícita; `start < end`, mismo día local y `scheduledDeliveryDate` dentro de la franja. Una ventana sin acuerdo se rechaza; no introducir "00:00" ficticio.
- Validar zona, dirección, coordenadas completas y finitas/rangos mediante utilidades #9. En ADMIN requerir punto confirmado y depósito existente para permitir despacho, o documentar expresamente que queda PENDING y no elegible; no geocodificar automáticamente ni inventar coordenadas.
- Si se crea para hoy, exigir instante/franja futuros al momento del commit (evitar carrera con reloj o peticiones demoradas).
- No saltarse la separación de planificar/proponer/confirmar DRAFT/asignar/iniciar de #7/#10.

## 4. Stock y atomicidad (condición de aceptación obligatoria)

La reserva de stock, la creación de `Order`, las líneas `OrderItem` y las validaciones finales deben ocurrir en **una única transacción PostgreSQL**. La existencia y stock del producto se revalidan **dentro** de ella.

Estrategia: consolidar cantidades de productos repetidos; ordenar `productId` para adquirir bloqueos de fila en secuencia estable; bloquear el registro del producto y leer `stock` vigente dentro de la misma transacción, comprobar `stock >= cantidad` y descontar usando operación segura. Considerar escrituras de otros módulos sobre Product y evitar snapshots absolutos calculados fuera de locks. Si cualquier comprobación falla, hacer rollback íntegro, sin `Order` ni `OrderItem` parciales y sin stock decrementado. Asegurar el mismo algoritmo para creación CLIENT existente y ADMIN: **no duplicar lógica de inventario**.

No aceptar operaciones de modificación de stock que puedan eludir esta política. Evitar exponer detalles del pedido o los datos de un CLIENT no autorizado en errores.

## 5. Consultas y autorización

- `GET /orders/my-orders` conserva filtro por `JWT.userId`, nunca ofrece pedidos `userId=NULL`.
- `GET /orders/:id`: ADMIN global, CLIENT solo propietario real, DRIVER solo pedidos de ruta propia; conservar las comprobaciones IDOR/BOLA de la Issue #8. Guest sin sesión no obtiene endpoints privados.
- `GET /orders` ADMIN: agregar filtros paginados por `date` y `zoneId`, `status`; orden total determinista y tope de tamaño; sin afectar endpoints DRIVER/CLIENT.
- Cada nuevo campo PII (nombre/teléfono del destinatario) necesita proyección mínima por rol y exclusión de logs/telemetría.
- Mantener los invariantes transaccionales de Route/RouteStop/OrderClaim.

## 6. Pruebas requeridas antes del merge

Pruebas unitarias y E2E reales con PostgreSQL efímero, dos ADMIN/CLIENT y un DRIVER, JWT auténticos:

1. ADMIN crea pedido para CLIENT registrado; `userId` es el CLIENT, `createdById` es ADMIN, visibilidad correcta en `my-orders`.
2. ADMIN crea pedido GUEST; `userId=NULL`, `createdById` es ADMIN, recipientName/Phone persisten; ningún CLIENT lo obtiene por ID.
3. CLIENT sigue creando solo para sí; rechazo si intenta inyectar `clientId`, `createdById` o campos ADMIN. DRIVER/CLIENT reciben 403 en `/orders/admin`; sin JWT 401.
4. ADMIN no puede asociar otro ADMIN/DRIVER como propietario registrado, ni un ID inexistente. `recipient.type` desconocido/mezclado: 400.
5. Coordenadas omitidas/parciales/inválidas; zona inexistente, depósito no confirmado, fecha pasada, distinta zona, ventana invertida o interdiaria; sin efectos parciales.
6. PENDIENTE/stock: 2 peticiones concurrentes con stock insuficiente para ambas, una tiene éxito y otra error; nunca valores negativos, ni sobreventa. Dos productos, uno insuficiente: rollback de ambos.
7. Retries y conflictos de BD no duplican stock ni crean órdenes parciales (acordar idempotencyKey solo si se implementa).
8. Migración aditiva y reversión de respaldo en bases limpias y pobladas, filas históricas con propietarios y sin autor inventado; CLI y snapshots Prisma verificados.
9. Regresión E2E de seguridad #8, geografía #9, planificación #7, ciclo #10, Newman y CI completo con umbrales originales.

Usar el flujo normal de Gentle-AI / RDD para código nuevo, sin declarar revisiones/aprobaciones no obtenidas ni evadir puertas de calidad.

## 7. Entrega y dependencias de interfaz

- Rama dedicada `feat/11-admin-guest-orders` basada en `main`.
- PR de esta rama hacia `main`, inicialmente **Draft**. No fusionar ni cerrar Issue #11 hasta código, migración, pruebas E2E, CI verde y revisión requerida.
- Frontend Issue #6: consumir **solo después de integrar** la nueva API. La forma concreta del body y los nombres de campos se consideran propuestos mientras no exista aceptación de contrato frontend/backend.
- Mantener PR #25 (confirmación de rutas por día de negocio) como cambio separado; no incorporar accidentalmente su rama aquí. Reconciliar antes del merge.

## 8. Estado de este primer commit

Este commit fija únicamente el **contrato técnico propuesto**. No modifica rutas ejecutables, ORM, migraciones, ni stock. Falta la implementación real y las pruebas; el PR **no es mergeable por aceptación funcional** hasta entonces, aunque GitHub lo considere técnicamente fusionable.
