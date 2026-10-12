# Issue #11 — contrato de registro administrativo de pedidos

> **Estado actual:** A–E completas funcionalmente y verificadas de forma independiente, incluida la compatibilidad legacy local **no oficial** autorizada por el usuario: TypeScript raíz sin diagnósticos, 44 suites/559 pruebas con cobertura, 18 suites/322 E2E y Newman completo (§12). `POST /api/v1/orders/admin` disponible para ADMIN autenticado. Resolución RDD y commits autorizados por el usuario: RDD desactivado a nivel de clon local (`clone_local: off`) al superar el presupuesto nativo de contexto por el volumen indivisible de Prisma 8 / migraciones, siguiendo el precedente de Issue #9 y #10 con excepción de tamaño autorizada (`size:exception`). Entrega estructurada en work-unit commits para PR #26.

La evidencia final y los siguientes pasos están en §12–13. Las secciones A–D conservan evidencia histórica; sus pendientes se refieren a ese momento, no al estado actual.

## 1. Antecedentes verificados

- La Issue #11 fue reabierta: el PR #18 de plantilla la había cerrado accidentalmente.
- Actualmente `POST /api/v1/orders` solo acepta CLIENT y pasa `@CurrentUser('userId')` a `OrdersService.createOrder`.
- Unidad A permite `Order.userId=NULL` con FK conservada; agrega creador y destinatario separados. B clasifica nuevas filas CLIENT y ADMIN con propietario/creador reales e instantánea; historia sin clasificar permanece NULL.
- C reemplaza el patrón previo de lectura fuera de transacción: stock/precio vigentes se leen con `FOR UPDATE` dentro del callback transaccional, con productos consolidados y orden de locks estable.
- `scheduledDeliveryDate` sigue opcional en CLIENT y requerida en ADMIN. D exige en ambas entradas, cuando se proporciona, un instante válido con offset explícito y estrictamente futuro. Fecha omitida CLIENT conserva NULL; `null`, fecha sin zona, overflow y pasado se rechazan con 400.
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

### Modelo relacional persistido en Unidad A

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

## 3. API implementada en B para React

Conservar `POST /api/v1/orders` para CLIENT sin permitir `clientId` ni sobrescritura del actor.

Disponible **`POST /api/v1/orders/admin`**, solo ADMIN autenticado mediante JWT de producción y `RolesGuard`. Ni CLIENT ni DRIVER pueden invocarlo. El actor `createdById` **nunca** proviene del body.

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

Los ejemplos usan IDs simbólicos y fechas futuras; las formas de ambos cuerpos se verificaron por HTTP con IDs del fixture PostgreSQL propio, no con los IDs ilustrativos. Validar estrictamente el discriminador y prohibir campos adicionales y variantes mezcladas. Para REGISTERED_CLIENT, consultar el usuario y comprobar `role === CLIENT`, sin confiar en la identidad o nombre suministrados por el navegador. Para GUEST, prohibir `clientId`; validar nombre y teléfono con longitud acotada y normalización mínima, sin crear credenciales.

La respuesta `201` debe incluir `id`, `userId: string | null`, `createdById`, `recipientType`, `recipientName`, `recipientPhone` (solo para roles autorizados), zona, coordenadas, fecha/franja, líneas, total y `status: PENDING`. Documentar tipos anulables con OpenAPI real. La visibilidad de teléfono/nombre de invitado en consultas DRIVER debe limitarse estrictamente a su ruta propia; no incluirlos en difusiones públicas o logs.

### Fechas, ubicación y planificación

- Interpretar día operativo en `America/Guayaquil`, sin usar timezone del servidor.
- `createdAt`: instante fijado por el servidor; nunca equivale a fecha solicitada de entrega.
- `scheduledDeliveryDate`: instante de entrega acordado, requerido en ADMIN y **estrictamente futuro** al validar creación. CLIENT puede omitirlo; si lo proporciona rige la misma política.
- `deliveryWindowStart` y `deliveryWindowEnd`: instantes ISO con zona explícita; `start < end`, mismo día local y `scheduledDeliveryDate` dentro de la franja. Una ventana sin acuerdo se rechaza; no introducir "00:00" ficticio.
- Validar zona, dirección, coordenadas completas y finitas/rangos mediante utilidades #9. En ADMIN requerir punto confirmado y depósito existente para permitir despacho, o documentar expresamente que queda PENDING y no elegible; no geocodificar automáticamente ni inventar coordenadas.
- Exigir fecha y comienzo de franja estrictamente futuros tras cada espera de lock y en la comprobación final después de escribir líneas. `clock_timestamp()` PostgreSQL avanza durante la transacción. La comprobación se realiza antes de retornar el callback; permanece un pequeño intervalo hasta COMMIT, no eliminado por esta política.
- No saltarse la separación de planificar/proponer/confirmar DRAFT/asignar/iniciar de #7/#10.

## 4. Stock y atomicidad (condición de aceptación obligatoria)

La reserva de stock, la creación de `Order`, las líneas `OrderItem` y las validaciones finales deben ocurrir en **una única transacción PostgreSQL**. La existencia y stock del producto se revalidan **dentro** de ella.

Estrategia: consolidar cantidades de productos repetidos; ordenar `productId` para adquirir bloqueos de fila en secuencia estable; bloquear el registro del producto y leer `stock` vigente dentro de la misma transacción, comprobar `stock >= cantidad` y descontar usando operación segura. Considerar escrituras de otros módulos sobre Product y evitar snapshots absolutos calculados fuera de locks. Si cualquier comprobación falla, hacer rollback íntegro, sin `Order` ni `OrderItem` parciales y sin stock decrementado. Asegurar el mismo algoritmo para creación CLIENT existente y ADMIN: **no duplicar lógica de inventario**.

No aceptar operaciones de modificación de stock que puedan eludir esta política. Evitar exponer detalles del pedido o los datos de un CLIENT no autorizado en errores.

## 5. Consultas y autorización

- `GET /orders/my-orders` conserva filtro por `JWT.userId`, nunca ofrece pedidos `userId=NULL`.
- `GET /orders/:id`: ADMIN global, CLIENT solo propietario real, DRIVER solo pedidos de ruta propia; conservar las comprobaciones IDOR/BOLA de la Issue #8. Guest sin sesión no obtiene endpoints privados.
- `GET /orders` ADMIN devuelve `{items,total,page,pageSize}`. `page` por defecto 1, rango 1–1.000.000; `pageSize` por defecto 20, rango 1–100. Filtros opcionales `date=YYYY-MM-DD` (día programado America/Guayaquil, intervalo inicio inclusivo/fin exclusivo), `zoneId` y `status` (enum del pedido). Orden ascendente `scheduledDeliveryDate`, luego `id`; fechas NULL al final. Filtros vacíos/sin coincidencias devuelven envelope vacío; fecha inexistente, estado inválido, campos desconocidos o paginación fuera de rango: 400. Solo ADMIN; historial CLIENT sigue siendo arreglo.
- Cada nuevo campo PII (nombre/teléfono del destinatario) necesita proyección mínima por rol y exclusión de logs/telemetría.
- Mantener los invariantes transaccionales de Route/RouteStop/OrderClaim.

## 6. Pruebas requeridas antes del merge

Pruebas unitarias y E2E reales con PostgreSQL efímero, dos ADMIN/CLIENT y un DRIVER, JWT auténticos:

1. ADMIN crea pedido para CLIENT registrado; `userId` es el CLIENT, `createdById` es ADMIN, visibilidad correcta en `my-orders`.
2. ADMIN crea pedido GUEST; `userId=NULL`, `createdById` es ADMIN, recipientName/Phone persisten; ningún CLIENT lo obtiene por ID.
3. CLIENT sigue creando solo para sí; rechazo si intenta inyectar `clientId`, `createdById` o campos ADMIN. DRIVER/CLIENT reciben 403 en `/orders/admin`; sin JWT 401.
4. ADMIN no puede asociar otro ADMIN/DRIVER como propietario registrado, ni un ID inexistente. `recipient.type` desconocido/mezclado: 400.
5. Coordenadas omitidas/parciales/inválidas; zona inexistente, depósito no confirmado, fecha pasada, distinta zona, ventana invertida o interdiaria; sin efectos parciales.
6. Stock (verificado en C): 2 peticiones concurrentes con stock insuficiente para ambas, una tiene éxito y otra error; nunca valores negativos, ni sobreventa. Dos productos, uno insuficiente: rollback de ambos.
7. Retries y conflictos de BD no duplican stock ni crean órdenes parciales (acordar idempotencyKey solo si se implementa).
8. Migración aditiva y reversión de respaldo en bases limpias y pobladas, filas históricas con propietarios y sin autor inventado; CLI y snapshots Prisma verificados.
9. Regresión E2E de seguridad #8, geografía #9, planificación #7, ciclo #10, Newman y CI completo con umbrales originales.

Usar el flujo normal de Gentle-AI / RDD para código nuevo, sin declarar revisiones/aprobaciones no obtenidas ni evadir puertas de calidad.

## 7. Entrega y dependencias de interfaz

- Rama dedicada `feat/11-admin-guest-orders` basada en `main`.
- PR de esta rama hacia `main`, inicialmente **Draft**. No fusionar ni cerrar Issue #11 hasta código, migración, pruebas E2E, CI verde y revisión requerida.
- Frontend Issue #6: consumir **solo después de integrar** la nueva API. Las formas, inventario y fechas están implementados y verificados funcionalmente; integración y aceptación frontend/backend y revisión requerida siguen pendientes; TypeScript raíz ya PASS con la compatibilidad autorizada (§12).
- Mantener PR #25 (confirmación de rutas por día de negocio) como cambio separado; no incorporar accidentalmente su rama aquí. Reconciliar antes del merge.

## 8. Evidencia histórica y decisiones de Unidad A

Implementación limitada a persistencia, artefactos emitidos, pruebas de migración y nulabilidad del propietario en el DTO de respuesta. No cambia `OrdersService`, inventario, endpoints, filtros, paginación ni algoritmos de rutas. Esta sección registra exclusivamente evidencia de A; B se documenta debajo. Al terminar A, inventario, reglas temporales completas y aceptación integral quedaban pendientes de C–E; estado vigente en §12. No hay commits ni aprobación de revisión atribuidos a esta ejecución. El build y la comprobación independiente aprobaron; RDD no creó autoridad porque la evidencia completa supera su presupuesto nativo (`lens_context_budget_exceeded`).

### Migración real

- Paquete generado: `migrations/app/20261012T1315_admin_guest_orders`.
- Origen explícito verificado en la cadena: `15ef5b17c1444e1f37222de1c696766119c6c4494633f6c5fcb256dee13cba83`.
- Destino emitido: `e357d1aa2fdc74464e729ec7cd8bb087b979a13b22e0f88aa005b60be4c16427`.
- Identidad de migración: `d330b656b611887dfc6a0c46ac492d00d3a5bb946b84be42cee5037a499c6715`.
- `pnpm prisma contract emit`, `pnpm prisma migration plan --from <origen> --name admin_guest_orders` y `pnpm prisma migration show migrations/app/20261012T1315_admin_guest_orders` ejecutados realmente, con dotenv deshabilitado mediante `DOTENV_CONFIG_PATH=/dev/null` y sin `DATABASE_URL` heredado.
- 14 operaciones aditivas/de ampliación; sin transformaciones de datos, placeholders ni edición manual de hashes/ops. Snapshot nuevo generado en el directorio del hash destino; snapshots existentes y refs conservados. `migration plan` no avanza refs; no corresponde `--no-advance-ref` en ese comando.

### Invariantes efectivamente persistidas

- Relaciones nombradas `OrderOwner` y `OrderCreator`; `User.orders` conserva propiedad y `User.createdOrders` representa autoría. Campos históricos nuevos NULL: ningún backfill de identidad/contacto ni cuentas falsas.
- CHECK cierra el bypass SQL de NULL mediante `COALESCE(..., false)`. GUEST exige propietario NULL, creador existente y nombre/teléfono con algún carácter no blanco; REGISTERED_CLIENT exige propietario y creador existentes y nombre no blanco. Se rechaza propietario NULL sin clasificación. Filas propias sin clasificar siguen permitidas para compatibilidad CLIENT.
- FK comprueba existencia, no rol: autorización del actor y verificación de propietario CLIENT corresponden a B. Tampoco es una garantía de inmutabilidad de autoría.
- Ventana opcional: ambos extremos NULL o ambos presentes, inicio estrictamente anterior al fin, fecha programada presente y dentro del intervalo inclusivo, extremos en el mismo día `America/Guayaquil`. No se utiliza el timezone del servidor ni se reescriben fechas históricas; rechazo de fechas pasadas y reglas de entrada corresponden a D.
- Índice de propietario existente conservado; índice de creador, fecha programada y compuesto `(zoneId, status, scheduledDeliveryDate)`. `RouteStop`/`OrderClaim` y sus guards no se modifican.

### Pruebas observadas

Runner real: Jest con `test/jest-e2e.json`; pasar argumentos directamente a `pnpm run`, sin un segundo separador `--`.

- RED: `env -u DATABASE_URL DOTENV_CONFIG_PATH=/dev/null pnpm run test:e2e --runInBand --no-cache --runTestsByPath test/admin-guest-orders-migration.e2e-spec.ts --testNamePattern='adds nullable owner'`: fallo de aserción real; la BD anterior no tenía propietario nullable ni nuevas columnas. La primera invocación con separador adicional ejecutó toda la prueba y falló también; se corrigió el comando antes de implementar.
- GREEN: `env -u DATABASE_URL DOTENV_CONFIG_PATH=/dev/null pnpm run test:e2e --runInBand --no-cache --runTestsByPath test/admin-guest-orders-migration.e2e-spec.ts`: 28 pruebas aprobadas. Historia poblada baseline → punta anterior → nueva migración y BD vacía → nueva punta; propietarios/estados/fecha histórica intactos, metadata NULL, destinatarios válidos, ausencia de cuentas nuevas, FK, contactos blancos/NULL, variantes inválidas, ventanas, claims activos e integridad/unicidad de stops. `pnpm prisma db verify --db <URL propia>` real aprueba en ambas bases.
- Contenedor `postgres:16-alpine` propio con etiqueta de sesión, puerto aleatorio solo loopback y datos tmpfs sin volumen persistente. Rechaza `DATABASE_URL` heredado. Teardown comprueba etiqueta y confirma desaparición del contenedor; ninguna BD externa se utiliza.
- Regresión: `env -u DATABASE_URL DOTENV_CONFIG_PATH=/dev/null pnpm run test --runInBand --no-cache --runTestsByPath src/modules/orders/orders.service.spec.ts src/modules/orders/orders.controller.spec.ts`: 40 pruebas aprobadas.
- `pnpm run lint`: exit 0; advertencia ajena en `test/route-start.e2e-spec.ts:217` por parámetro `status` sin uso. Script no usa `--fix`.
- `pnpm exec tsc --noEmit --incremental false -p tsconfig.build.json`: exit 0 sin salidas de build.

**Verificación independiente:** `env -u DATABASE_URL DOTENV_CONFIG_PATH=/dev/null pnpm run build` aprobado; repetición de las dos suites unitarias de pedidos: 40/40; `git diff --check` sin errores. Las 28 pruebas PostgreSQL se reutilizan como evidencia del escritor, no se atribuyen al verificador independiente.

**Pendiente al terminar A:** revisión nativa (bloqueada antes de crear autoridad), B–E y suite/Newman integral. Esta evidencia histórica no atribuye aprobación a B. Las pruebas intermedias expusieron requisitos de claims de rutas DRAFT y la ubicación de tmpfs en `HostConfig.Tmpfs`; se corrigió únicamente el fixture, sin relajar guards ni omitir pruebas.

## 9. Unidad B — comportamiento y evidencia histórica

- CLIENT conserva `POST /orders` y coordenadas/fecha opcionales. Propietario y creador provienen del JWT; nombre desde perfil CLIENT comprobado en BD. ADMIN utiliza endpoint separado y destinatario discriminado; propietario registrado inexistente: 404, rol distinto de CLIENT: 400. GUEST no crea usuarios ni credenciales. Nombre se recorta en extremos y exige 1–120 caracteres; teléfono 1–40, recorte en extremos únicamente (sin inferir país ni identidad). REGISTERED_CLIENT permite omitir teléfono, no `null`; GUEST lo exige.
- ValidationPipe de producción rechaza campos extra en raíz, destinatario y líneas; discriminador desconocido, omitido, array o variantes mezcladas: 400. Ningún campo del cuerpo suministra actor, propietario digital ni rol. JWTStrategy recarga rol de BD.
- ADMIN exige par de coordenadas y depósito de zona válidos mediante utilidades geográficas existentes. Fecha con offset explícito; ventana omitida o ambos extremos presentes con offset, inicio < fin, fecha incluida y mismo día Guayaquil. Estos errores de entrada devuelven 400 antes de escrituras; no se delegan al CHECK como 500. Pasado y carrera de reloj siguen pendientes de D.
- Un único método de persistencia recibe metadata para CLIENT y ADMIN. B dejó el algoritmo previo de stock fuera de transacción; C lo reemplaza como se acredita en §10. La evidencia de B por sí sola no acredita concurrencia.
- Proyección explícita allowlist en creación/lectura/actualización del módulo orders: metadata histórica NULL, `user` solo `{id,name}` cuando incluido, sin email/password/relaciones completas. Teléfono omitido para CLIENT; ADMIN y DRIVER autorizado de ruta propia lo obtienen (NULL si no verificado/omitido). DRIVER ajeno recibe 403 sin PII. Sin expansión de historia de rutas.
- Creación 201 incluye líneas con precio congelado, sin producto expandido; lecturas incluyen producto mínimo documentado. `my-orders` sigue arreglo JWT-filtrado. OpenAPI real incluye `oneOf`/discriminator, metadata nullable, teléfono opcional por rol, errores 400/401/403/404 y envelope administrativo.
- **Compatibilidad Newman:** al terminar B, la colección aún esperaba arreglo raíz. E adaptó las aserciones a `.items` y paginación sin eliminarlas; resultado final en §12. CLIENT/historial conservan arreglo y los campos geográficos se mantienen.

### Verificación observada en B

Todos los comandos PostgreSQL usan URL de recurso propio, puerto aleatorio loopback, PostgreSQL 16-alpine, tmpfs y ningún volumen. Imports dinámicos de AppModule/Prisma ocurren después del rechazo de DATABASE_URL ambiental y la asignación de URL/JWT aleatorio propios. El accessor `ownedUrl` solo acepta base registrada y contenedor activo; guard A estricto conservado. Teardown cierra Prisma, verifica etiqueta de propiedad, detiene contenedor y confirma desaparición.

- RED: `env -u DATABASE_URL DOTENV_CONFIG_PATH=/dev/null pnpm run test:e2e --runInBand --no-cache --runTestsByPath test/admin-guest-orders-api.e2e-spec.ts`: 49/51 fallos conductuales antes de implementación, endpoint ADMIN 404 en vez de 201/400/401/403, filtros inválidos 200 en vez de 400 y esquema Swagger ausente. Primera ejecución falló por nombres SQL PascalCase del fixture; corregidos a nombres storage Prisma antes de observar RED conductual.
- GREEN y triangulación final, mismo comando: **56/56** PostgreSQL+HTTP (JWT reales, rol recargado, propiedad/autoría persistida, instantánea tras cambio de perfil, no usuarios guest, IDOR, contacto por rol/ruta, extras anidados, coordenadas/depósito, ventanas, historia NULL, filtros, límites, orden estable y OpenAPI). Sin skips ni umbrales reducidos.
- `env -u DATABASE_URL DOTENV_CONFIG_PATH=/dev/null pnpm run test --runInBand --no-cache --runTestsByPath src/modules/orders/orders.controller.spec.ts src/modules/orders/orders.service.spec.ts src/modules/orders/order-response.util.spec.ts`: **48/48**, incluyendo regresiones anteriores y allowlist independiente de mocks del ORM.
- `env -u DATABASE_URL DOTENV_CONFIG_PATH=/dev/null pnpm run test:e2e --runInBand --no-cache --runTestsByPath test/admin-guest-orders-migration.e2e-spec.ts`: **28/28** A repetidas por modificación mínima del fixture; migración/contrato/snapshot intactos.
- `env -u DATABASE_URL DOTENV_CONFIG_PATH=/dev/null pnpm run test --runInBand --no-cache --runTestsByPath test/swagger-geolocation.spec.ts`: **13/13**.
- `pnpm run lint`: exit 0; solo warning preexistente `test/route-start.e2e-spec.ts:217`.
- `pnpm exec tsc --noEmit --incremental false -p tsconfig.build.json`: exit 0.
- `pnpm run build`: exit 0; outputs generados ignorados.

Context7 no expuesto al escritor: se verificó discriminador contra README instalado de class-transformer 0.5.1 y tipos instalados de Nest Swagger (`SchemaObject`/`SchemaObjectMetadata`), además de generación OpenAPI real. No se consultó ni ejecutó RDD; revisión diferida, sin aprobación, staging, commits ni cambios de PR. C reemplazó stock en el método compartido (§10); D debe completar pasado/reloj al commit; E debe ejecutar suite/seguridad/rutas/Newman integral con umbrales originales.

## 10. Unidad C — inventario transaccional verificado

CLIENT, ADMIN/GUEST y ADMIN/REGISTERED_CLIENT comparten `persistOrder`. Cantidades individuales y agregadas deben ser enteros seguros positivos, hasta 2.147.483.647 (int4 del contrato); productos repetidos producen **una línea por producto** con cantidad consolidada. Los IDs se ordenan por codepoint, sin depender del locale ni del orden del body. Dentro de un único `client.transaction(async tx => ...)`, cada producto se bloquea mediante `SELECT id, name, price, stock FROM public.product WHERE id = $1 FOR UPDATE`, se comprueba stock vigente y se reserva; orden y líneas se insertan en ese mismo callback. Stock/precio nunca se precalculan desde una lectura global. Excepciones revierten todo; no hay retries automáticos ni hooks de producción para pruebas.

`PATCH /products/:id/stock` conserva **absolute-set**, no delta: valida entero no negativo hasta int4 y adquiere el mismo lock antes del update transaccional. Un set posterior a una reserva reemplaza intencionalmente el stock resultante; un set anterior debe ser leído por la reserva, nunca sobrescrito por un decremento precalculado. Negativo/fracción/overflow: 400; producto inexistente: 404.

### API Prisma instalada comprobada

Se leyó el skill rc.11 y sus referencias queries/queries-postgres/runtime, además del código instalado antes de elegir la API. `client.raw.sql` construye planes parameterizados; **no ejecuta consultas**. `tx.query(plan)` los ejecuta sobre la conexión del callback. `tx` no expone `raw`; no se abre pool alternativo en producción. Los writes ORM usan `tx.orm.public.*`. No casts SQL añadidos: ID/name text, price float8 y stock int4 se comprobaron en `src/prisma/contract.json`; storage `public.product` coincide con contrato y migración ejecutada.

Fuentes instaladas verificadas:
- `node_modules/@prisma/orm-postgres/dist/runtime.mjs:207–239`: transaction y binding de ORM a txCtx.
- `node_modules/@prisma/orm-postgres/dist/postgres-static-DBYpkrmX-W8VjIiiv.mjs`: construcción del raw lane.
- `node_modules/.pnpm/@prisma+orm-family-sql@8.0.0-rc.11_@prisma+cli-engine@0.4.0_@prisma+management-api-sdk@_1d32009560b008848fa65d5a858fbacd/node_modules/@prisma/orm-family-sql/dist/expression-B2Ox7zKM.mjs:61–146`: interpolaciones ParamRef y returnsRow/build.

### Evidencia RED/GREEN y triangulación

- RED real sobre B, después de corregir dos errores de carga del nuevo fixture Jest (`import.meta`/nombre `require`): comando E2E abajo, **8 fallos/61 éxitos (69 total)**. Tres variantes emitían dos líneas; stock suficiente solo para uno produjo dos 201; precio tras esperar lock quedó obsoleto (10 en vez de 23); opposite-order tomó el segundo lock primero (NOWAIT falló y PostgreSQL reportó deadlock); overflow de stock devolvió 500; reserva concurrente sobrescribió set=5 con stock=9. Rollback de inserts ya funcionaba en B, no se atribuye un RED inexistente para ese comportamiento.
- GREEN inicial E2E: 69/69. Triangulación final: **74/74**, incluyendo 18 C y 56 B intactas. Repetidos/precio/total y errores sin PII en las tres variantes; agregado fuera de int4 rechazado sin efectos; multiproducto insuficiente revierte stock ya escrito; overlaps con una/dos unidades terminan [201,400]/[201,201], stock=0 y conteos exactos; dos productos con input opuesto completan y NOWAIT prueba que nadie bloquea el segundo antes del primero.
- Barrera real: sesión externa bloquea producto, dos HTTP requests con JWT/guards reales quedan observadas en `pg_stat_activity` con `wait_event_type=Lock`; stock y precio se cambian antes de soltar. Polling por estado de BD, sin sleeps de concurrencia; límite 8s, statement_timeout 10s para sesiones propias y HTTP 12s. ADMIN set antes/después de la reserva prueba ambas serializaciones intencionales.
- Triggers solo en BD propia fuerzan fallos reales de INSERT Order/OrderItem después de UPDATE stock. Secuencia no transaccional en schema `inventory_evidence` avanza al escribir stock: confirma UPDATE ejecutado aunque stock, órdenes y líneas vuelven a sus valores/conteos previos. HTTP 500 genérico sin datos del destinatario ni detalles del trigger. Sin mocks de persistencia ni testhooks de producción.

Comandos finales observados:
- `env -u DATABASE_URL DOTENV_CONFIG_PATH=/dev/null pnpm run test --runInBand --no-cache --runTestsByPath src/modules/orders/orders.service.spec.ts src/modules/products/products.service.spec.ts src/modules/orders/order-inventory.util.spec.ts`: **63/63**, 3 suites.
- `env -u DATABASE_URL DOTENV_CONFIG_PATH=/dev/null pnpm run test:e2e --runInBand --no-cache --runTestsByPath test/admin-guest-orders-inventory.e2e-spec.ts test/admin-guest-orders-api.e2e-spec.ts`: **74/74**, 2 suites; logs de errores deliberados de triggers esperados, no fallos de tests.
- `pnpm run lint`: exit 0, único warning previo `test/route-start.e2e-spec.ts:217`.
- `pnpm exec tsc --noEmit --incremental false -p tsconfig.build.json`: exit 0.
- `pnpm run build`: exit 0; solo outputs ignorados dist/buildinfo.
- `git diff --check`: exit 0.

Recursos: reutilizado fixture API propio sin modificar fixture A/B; PostgreSQL 16-alpine, loopback aleatorio, tmpfs, sin volumen persistente; DATABASE_URL ambiental rechazada antes de imports dinámicos, JWT aleatorio. Sesiones blocker/observer y Prisma cerradas, rollback/finally en overlaps, teardown verifica propiedad y desaparición del contenedor. Schema/triggers/secuencia desaparecen con su contenedor propio; ninguna base compartida ni archivos scratch. A/contrato/artefactos/migración/snapshot intactos durante C. Sin staging, commits ni llamadas RDD.

**Handoff histórico C → D:** validar pasado y revalidar reloj después de esperas de locks, dentro del callback antes de persistencia/commit, manteniendo rollback y el algoritmo compartido. Fecha CLIENT opcional y reglas de B no se cambiaron en C. **E:** suite integral/Newman y revisión RDD permanecen diferidas; no se atribuye aceptación integral ni revisión independiente a C.

## 11. Unidad D — fechas, reloj y rollback temporal

- `order-delivery.util` concentra el parseo común: `Temporal.Instant.from` con offset explícito, sin parsear fechas de entrada mediante `Date` ni depender del TZ del host. Preserva precisión submilisegundo; calendario inválido, offset inválido, zona ausente y fecha suministrada NULL: 400. ADMIN requiere fecha; CLIENT omitida conserva NULL. DTO CLIENT ahora usa ISO estricto y el mismo requisito de offset. Es un endurecimiento intencional: fechas CLIENT pasadas o malformadas antes aceptadas dejan de ser válidas.
- Ventana ADMIN opcional y pareada: inicio < fin, fecha dentro inclusivamente y los tres instantes en un mismo día `America/Guayaquil` mediante `isSameBusinessDay`. Fecha y comienzo deben ser estrictamente posteriores al reloj, también cuando se pide un día futuro. `createdAt` permanece generado por servidor/BD y distinto del instante programado; no se introducen franjas ficticias.
- `persistOrder` conserva consolidación, locks codepoint y reserva compartida de C. Parseo estructural temprano sin reloj de aplicación; **único reloj autoritativo PostgreSQL**, comprobado al comenzar el callback antes de locks, después de **cada** lock de producto antes de su UPDATE, y al final después de líneas. Ejecuta `SELECT clock_timestamp() AS instant` mediante plan raw y `tx.query` sobre la conexión del callback. Codec real `pg/timestamptz-temporal@1`, igual al contrato emitido rc.11; verificado por HTTP real, tsc y build. No usa `now()` ni `transaction_timestamp()` congelados al inicio.
- Última comprobación después de crear todas las líneas y antes de retornar el callback: una excepción 400 revierte stock/Order/OrderItem. El pequeño intervalo entre esta comprobación y COMMIT **permanece**; no se afirma guard DB de pasado en commit ni eliminación infinitesimal de la carrera. Errores temporales no interpolan contacto, propietario, dirección ni fecha recibida.
- Geografía ADMIN y coordenadas opcionales CLIENT intactas. Pruebas reutilizan `evaluatePlanningEligibility`, `isOrderPlanningEligible` e `isSameBusinessDay` empleados por rutas: instante UTC del 15 corresponde al día Guayaquil del 14 y respeta filtros ADMIN. No se modificó planificación, asignación, estados ni Clarke–Wright; tampoco contrato, migración o snapshots.

### Evidencia D observada

Runner inspeccionado: scripts Jest reales sin separador adicional; dotenv deshabilitado, URL ambiental eliminada. Pruebas nuevas añaden fixture delivery independiente y reutilizan helpers C de sesión/observación sin modificar sus archivos.

- RED antes de código: `env -u DATABASE_URL DOTENV_CONFIG_PATH=/dev/null pnpm run test:e2e --runInBand --no-cache --runTestsByPath test/admin-guest-orders-delivery.e2e-spec.ts test/admin-guest-orders-api.e2e-spec.ts test/admin-guest-orders-inventory.e2e-spec.ts`: **13 fallos / 81 éxitos (94)**. Pasado y expiración tras locks/INSERT devolvían 201, CLIENT aceptaba overflow/sin zona/NULL. Aserciones conductuales, no errores de carga; 56 B y 18 C pasaron intactas.
- GREEN inicial mismo comando: **94/94**. Triangulación final mismo comando: **101/101** (27 D + 56 B + 18 C), sin skips. Ventanas válidas/ausentes, pares incompletos/invertidos/interdiarios/fuera de fecha/pasados, offsets, CLIENT sin fecha, errores sin PII y regresiones C.
- Barreras con **reloj PostgreSQL no simulado**: sesión externa bloquea producto, HTTP JWT real observado en `pg_stat_activity` esperando Lock; deadline propio a +2s, polling acotado hasta `clock_timestamp() >= deadline`, recién entonces desbloquea. Las tres variantes reciben 400 y conservan stock/conteos, sin UPDATE en primer lock. Lock del segundo producto prueba que ya ocurrió primera reserva (secuencia no transaccional) y todo revierte. Sin sleeps usados para decidir orden o expiración.
- Barrera AFTER INSERT de OrderItem en schema propio toma advisory lock mantenido por sesión externa. Espera observada en BD, reloj expira, unlock y 400 en CLIENT/GUEST/REGISTERED_CLIENT. Secuencias stock/item avanzan aunque stock, órdenes y líneas vuelven al estado previo: evidencia de writes reales revertidos por validación final, no un fallo de INSERT sustitutivo ni hook de producción.
- `env -u DATABASE_URL DOTENV_CONFIG_PATH=/dev/null pnpm run test --runInBand --no-cache --runTestsByPath src/modules/orders/orders.service.spec.ts src/modules/orders/order-delivery.util.spec.ts`: **71/71**. Calendario/leap, nanos, TZ host alternativos, igualdad con reloj, medianoche Guayaquil, offsets mixtos, ventanas, CLIENT omitida y helpers geográficos/de rutas. Fecha fija pasada del fixture servicio se actualizó a futura, preservando assertions; mocks distinguen planes de clock y producto.
- `env -u DATABASE_URL DOTENV_CONFIG_PATH=/dev/null pnpm run test --runInBand --no-cache --runTestsByPath src/modules/orders/orders.service.spec.ts src/modules/orders/order-delivery.util.spec.ts test/swagger-geolocation.spec.ts`: **84/84**, incluida regresión Swagger existente (13).

- `pnpm run lint`: exit 0; único warning previo `test/route-start.e2e-spec.ts:217` (parámetro `status`).
- `pnpm exec tsc --noEmit --incremental false -p tsconfig.build.json`: exit 0.
- `env -u DATABASE_URL DOTENV_CONFIG_PATH=/dev/null pnpm run build`: exit 0; solo outputs ignorados `dist`/buildinfo, configuración intacta.
- `git diff --check`: exit 0.

Recursos: PostgreSQL 16-alpine propio con loopback aleatorio/tmpfs/sin volumen; guard URL ambiental antes de imports dinámicos y JWT aleatorio. Blockers en finally hacen ROLLBACK, drenan requests y cierran sesiones; observer/app/Prisma cerrados. Teardown del fixture existente verificó propiedad y desaparición de los contenedores en los runs observados. Sin BD compartida, artefactos scratch, staging, commit, publicación ni llamadas RDD.

### Seguimiento D — eliminar rechazo por skew del reloj app

El readback independiente identificó que el rechazo temprano `toInstant(new Date())` podía rechazar una fecha todavía futura en PostgreSQL si la aplicación estaba adelantada. Se eliminó: el parseo temprano sigue intacto y la primera comprobación de futuro ahora ejecuta `deliveryClock` dentro del callback **antes de tomar locks**. Checks tras cada lock y después de líneas conservados. No se requiere sincronización app/BD para esta política; permanece el intervalo final check → COMMIT.

- RED observado antes del fix: `env -u DATABASE_URL DOTENV_CONFIG_PATH=/dev/null pnpm run test:e2e --runInBand --no-cache --runTestsByPath test/admin-guest-orders-delivery.e2e-spec.ts`: **3 fallos / 30 éxitos (33)**. CLIENT, ADMIN/GUEST y ADMIN/REGISTERED_CLIENT recibían 400 en vez de 201 con deadline DB +1 día y constructor Date app +2 días.
- GREEN mismo comando: **33/33** (27 D existentes +6 skew). Tres variantes aceptan futuro DB pese a app adelantada y rechazan expirado DB pese a app atrasada sin UPDATE ni cambios de conteos. HTTP/JWT/guard/transacción/locks y `clock_timestamp()` son reales; solamente seis tests skew controlan el constructor Date **sin argumentos**. `Date.now`, parseo con argumentos y timers permanecen reales; JWT/request y fechas del helper se preparan antes del spy, deadlines/app_now se derivan mediante consulta a la BD propia. Spies restaurados en finally. Los tests de barreras existentes no usan este control de reloj.
- `env -u DATABASE_URL DOTENV_CONFIG_PATH=/dev/null pnpm run test --runInBand --no-cache --runTestsByPath src/modules/orders/orders.service.spec.ts src/modules/orders/order-delivery.util.spec.ts`: **71/71**, pure tests intactos.
- Checks repetidos tras el fix: `pnpm run lint` exit 0 (solo warning previo route-start:217); `pnpm exec tsc --noEmit --incremental false -p tsconfig.build.json` exit 0; `env -u DATABASE_URL DOTENV_CONFIG_PATH=/dev/null pnpm run build` exit 0 (outputs ignorados); `git diff --check` exit 0.
- Recursos PostgreSQL16 loopback/tmpfs, sesiones y app/Prisma cerrados; teardown propio verificó desaparición del contenedor. B/C/Newman/suite completa no se repitieron en este seguimiento; evidencias previas no se atribuyen a un rerun nuevo. Sin RDD, staging ni commits.

**Pendientes históricos al terminar D:** suite completa/cobertura y Newman, ahora verificados en §12. E conservó aserciones, adaptó envelope/paginación y fechas futuras de creación; historia/migración puede conservar fechas pasadas porque D solo valida nuevas creaciones. No se atribuyen esos runs posteriores ni aprobación RDD a D.

## 12. Unidad E — verificación independiente final completa

Todos los checks funcionales ejecutados por el verificador final PASS, después de la compatibilidad downstream autorizada. Esta actualización documental no repite suites ni implica aprobación nativa.

| Comprobación | Resultado independiente final |
| --- | --- |
| Newman aislado | **Salida global 0**, 104 requests / 434 assertions, cero fallos; 93 requests originales conservadas + 11 de Issue #11 |
| Cobertura integral | **44 suites / 559 pruebas PASS**; umbrales originales 80 % cada uno. Statements 90.79 %, Branches 81.73 %, Functions 89.08 %, Lines 92.05 % |
| E2E aislado | **18 suites / 322 pruebas PASS**: 15 con recursos propios + 3 legacy en PostgreSQL 16 propio; migración, verify y limpieza confirmados |
| Compatibilidad enfocada | **25/25 PASS**: 17 fixtures negativos de compilación, adversarios SQL/procedencia y congelación histórica |
| TypeScript raíz | **PASS, cero diagnósticos**, con compatibilidad local no oficial; no inventa `objectType` |
| TypeScript de build / build con emisión | **PASS / PASS**; raíz comprobada por separado |
| Lint / sintaxis Bash y Node / diff | **PASS**; warning histórico `test/route-start.e2e-spec.ts:217`. ShellCheck no instalado, sin resultado atribuido |

Comandos funcionales del informe (no ejecutados por esta actualización):

```bash
env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null pnpm run test:api:report
env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null pnpm run test:cov --runInBand --coverageThreshold='{"global":{"statements":80,"branches":80,"functions":80,"lines":80}}'
env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null pnpm run test:e2e:isolated
pnpm exec tsc --noEmit --tsBuildInfoFile /dev/null
pnpm exec tsc --noEmit --incremental false -p tsconfig.build.json
```

### Aislamiento y limpieza comprobados

El runner canónico [`test/run-e2e-isolated.sh`](../test/run-e2e-isolated.sh), enlazado en [`package.json`](../package.json) y [CI](../.github/workflows/ci.yml), cubre el manifiesto completo; no usa BD ambiental/compartida ni volúmenes persistentes de Compose. Las tres bases legacy se migraron y verificaron contra `e357d1aa2fdc74464e729ec7cd8bb087b979a13b22e0f88aa005b60be4c16427`.

Newman registra ID y owner auditables; exige propiedad exacta antes de remover. La ausencia requiere status 1 y respuesta exacta para ese ID: `Error: No such object: <ID>` o LF inicial + `error: no such object: <ID>` observado en Docker 29.9. Un fallo de `rm` o inspección inesperada falla cerrado, preservando el fallo primario. El run final terminó con salida 0 y consulta por owner con cero recursos propios. Esto no convierte en PASS el run histórico con salida 1 por falso negativo de limpieza.

### Bloqueo estricto histórico y límites

Tres migraciones históricas mantienen sus bytes/hashes intactos:

- `migrations/app/20261010T0526_route_lifecycle_foundation/migration.ts:490`.
- `migrations/app/20261010T0549_route_lifecycle_integrity/migration.ts:33`.
- `migrations/app/20261010T1345_route_lifecycle_coherence_t1e/migration.ts:21`.

El baseline HEAD virtual controlado reprodujo 23 diagnósticos con las dependencias actualmente instaladas; no prueba compatibilidad con un toolchain histórico. Después de reparar tests, el árbol conservaba solo los tres TS2741 citados, sin shim ni exclusiones. Ese FAIL anterior y la cobertura de 43 suites/534 pruebas son registros históricos, supersedidos por el PASS independiente final y 44 suites/559 pruebas actuales. La compatibilidad autorizada preserva los bytes; no inventa metadata ni modifica el contrato SDK upstream. E está completa funcionalmente y verificada, **no aprobada para entrega**.

Riesgos delimitados: permanece el intervalo última comprobación de reloj BD → COMMIT; el forwarding de señales reales del sistema operativo en el runner E2E no se probó independientemente (las pruebas ejercitan cancelación durante readiness). ASSESS read-only resultó no evaluable/desconocido, no aprobación; el START inicial falló antes de crear autoridad/lineage. No se ejecutó lifecycle después de diferir RDD, que sigue bajo control del usuario. ShellCheck local no disponible: sin PASS ni fallo de análisis atribuido.

### Compatibilidad downstream autorizada — verificación independiente completa

El usuario autorizó únicamente una compatibilidad de tipos local no oficial, sus pruebas y estas dos páginas. La investigación previa acotada a los paquetes publicados rc.11/15/17 encontró el mismo contrato `rawSql` con `objectType` requerido; **no se encontró una corrección upstream ni se justifica un upgrade**. No extrapolar ese resultado a todas las versiones de Prisma. No se modificaron dependencias, tsconfig, CI, migraciones, ops, manifests, hashes, snapshots ni contrato emitido.

- [`types/prisma-legacy-rawsql-compat.d.ts`](../types/prisma-legacy-rawsql-compat.d.ts) añade un overload ambient global para las tres combinaciones exactas ID/label/nombre de target históricas, `public`/`postgres`/`additive`, `objectType?: never` y precheck/execute/postcheck no vacíos con SQL. No se emite código runtime.
- Retorna el generic `T` de entrada real: **no promete `objectType` presente ni convierte a la operación completa SDK**. Las clases históricas y `MigrationCLI` aceptan ese retorno sin enriquecer ni volver a serializar operaciones. Operaciones nuevas conservan el overload estricto original.
- [`test/prisma-legacy-rawsql-compat.spec.ts`](../test/prisma-legacy-rawsql-compat.spec.ts) usa el compilador TypeScript semántico, no `transpileModule`: raíz strict completa y tres módulos reales; baseline sin declaración reproduce los tres TS2741. 17 negativos virtuales en memoria cubren identidades/target/clase incorrectos, `objectType` suministrado incompatible, SQL/checks ausentes o vacíos, operación nueva sin metadata y lectura falsa de `objectType` como string requerido. Ningún fixture inválido se escribe en la raíz.
- **Guard separado de SQL/procedencia:** recorre llamadas reales con typechecker y declaración de la firma resuelta; solo acepta tres rutas con operación literal canónica idéntica. Rechaza adversarios virtuales con misma identidad y SQL cambiado o llamada copiada fuera de esas rutas, aunque sus tipos compilen. Congela SHA256 originales de los nueve archivos `migration.ts`/`ops.json`/`migration.json`, comprueba `migrationHash` del manifest leído y compara AST literal con ops existentes, sin ejecutar módulos/emisor/CLI. Los tipos estructurales por sí solos **no validan semántica SQL**.

Evidencia test-first histórica del escritor (GREEN reconfirmado por los checks independientes finales; RED no repetido):

| Comando | Observado |
| --- | --- |
| `env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null pnpm test --runInBand --runTestsByPath test/prisma-legacy-rawsql-compat.spec.ts` | RED real: positivo raíz falla con tres TS2741; GREEN **25/25 PASS**, 1 suite, incluidos 17 negativos y adversarios |
| `pnpm exec tsc --noEmit --tsBuildInfoFile /dev/null` | Antes: 3 TS2741; después: **salida 0**, raíz estricta real |
| `pnpm exec tsc --noEmit --incremental false -p tsconfig.build.json` | **Salida 0**, separado del chequeo raíz |

Verificación independiente final: 25/25 pruebas enfocadas y TypeScript raíz/build sin diagnósticos; cobertura, E2E, Newman, lint y build con emisión repetidos con los resultados de la tabla final. Digest agregado antes/después de los 39 artefactos de migraciones, refs, snapshots y contrato: `c81d4ab9f89f57fc1337a9c770da2c59368b73c0239887dc899307419c9f0cc9` (lista ordenada ruta/SHA256 serializada como JSON compacto), idéntico; nueve SHA históricos congelados comprobados. Sin staging ni cambio de rama/HEAD. No hubo instalación ni modificación de dependencias/lock; **no se comparó el contenido de `node_modules`**.

Riesgo aceptado: el overload es global y podría reutilizarse con identidad permitida pero otro SQL; los tests fail-closed de procedencia/SQL en Jest/CI son imprescindibles y no equivalen a una garantía runtime. Mantener congeladas las constantes originales; no actualizar goldens para acomodar cambios. La autorización de compatibilidad **no es aceptación, aprobación RDD ni autorización de entrega**. Sustituirla únicamente por una solución upstream verificada, preservando integridad y repitiendo los checks completos.

## 13. Resolución RDD y estrategia de entrega — ejecutada

El bloqueo raíz de TypeScript quedó resuelto mediante compatibilidad autorizada y la verificación independiente está completa (559 unitarias, 322 E2E, 104 Newman requests con 0 fallos).

El usuario autorizó la resolución de RDD y la entrega del PR:
- **Resolución RDD:** Al superar el presupuesto nativo de contexto del revisor por el volumen indivisible de Prisma 8 / snapshots / migraciones (`lens_context_budget_exceeded`), y conforme al precedente de Issue #9 y #10, se registró la excepción de tamaño (`size:exception`) y se desactivó RDD a nivel de clon local (`clone-local: off`).
- **Estructura de entrega (Work-Unit Commits):** Siguiendo las directrices de `work-unit-commits`, los cambios se dividen en 5 unidades atómicas y coherentes:
  1. `test(infra)`: aislamiento de runners E2E y Newman con compatibilidad legacy rawSql.
  2. `feat(db)`: contrato Prisma 8, artefactos emitidos, migración y pruebas de regresión.
  3. `feat(orders)`: DTOs, endpoint administrativo, utilidades de proyección y pruebas de seguridad/API.
  4. `feat(orders)`: reservas transaccionales de stock y validación de fechas de entrega Guayaquil con pruebas de integración.
  5. `docs(orders)`: colección Newman/Postman, README, contrato documental y tracking de tareas.
- **Pull Request:** Actualización de PR #26 con descripción completa, evidencias verificadas y paso a estado listo para revisión (Ready for review).
