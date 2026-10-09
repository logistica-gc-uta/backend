# Arquitectura de seguridad, autorización y ciclo de vida de pedidos (#8)

Este documento describe el modelo de seguridad, autorización basada en identidad autenticada (JWT) y gobierno del ciclo de vida para el módulo de pedidos (`Orders`). Su propósito es erradicar vulnerabilidades de acceso directo a objetos (IDOR/BOLA) y prevenir transiciones de estado no autorizadas o inconsistentes.

## 1. Resumen ejecutivo

| Aspecto | Decisión de diseño |
|---|---|
| **Identidad** | Se extrae estrictamente del JWT validado (`sub`) y verificado contra PostgreSQL; no se aceptan identidades inyectadas por el cliente. |
| **Autorización primero** | La verificación de rol y pertenencia del recurso se ejecuta de forma prioritaria antes de cualquier validación del grafo de estados, evitando oráculos o fuga de estado a usuarios no autorizados. |
| **Ciclo de vida** | Grafo centralizado y unívoco en `order-status.policy.ts` con transiciones finitas controladas y protección estricta de estados terminales (`DELIVERED`, `CANCELLED`). |
| **Concurrencia** | Actualización condicional atómica a nivel de ORM/SQL (`.where({ id, status })`) para mitigar carreras de estado (*stale updates*). |
| **Migraciones de BD** | Cero cambios de esquema DDL; el modelo existente en `contract.prisma` cubre íntegramente las relaciones necesarias. |
| **Dependencia #10** | Escrituras por repartidor deshabilitadas *fail-closed* con `403 Forbidden` tras resolución de pertenencia, hasta que se implemente la verificación de ruta en progreso (`Route.IN_PROGRESS`). |

---

## 2. Matriz de permisos y autorización por rol

| Rol | Endpoint | Método | Regla de autorización | Código HTTP éxito | Códigos de error |
|---|---|---|---|---|---|
| **Público** | Todos | Cualquier | Requiere token Bearer JWT válido y firmado | — | `401 Unauthorized` |
| **CLIENT** | `/orders` | `POST` | Crea pedidos propios (asigna `userId` del token) | `201 Created` | `400`, `401`, `404` |
| **CLIENT** | `/orders/my-orders` | `GET` | Consulta exclusivamente los pedidos propios del cliente | `200 OK` | `401` |
| **CLIENT** | `/orders/:id` | `GET` | Solo permite lectura si `order.userId === token.userId` | `200 OK` | `401`, `403 Forbidden`, `404` |
| **CLIENT** | `/orders` | `GET` | Prohibido (requiere `ADMIN`) | — | `403 Forbidden` |
| **CLIENT** | `/orders/:id/status` | `PATCH` | Prohibido: rechaza con `403 Forbidden` por rol antes de evaluar el grafo de estados | — | `403 Forbidden` |
| **DRIVER** | `/orders/:id` | `GET` | Resuelve `User -> Driver -> Route -> Order`. Solo puede leer pedidos asignados a su ruta activa | `200 OK` | `401`, `403 Forbidden` (pedido sin ruta o ruta de otro chofer), `404` |
| **DRIVER** | `/orders` | `GET` | Prohibido (requiere `ADMIN`) | — | `403 Forbidden` |
| **DRIVER** | `/orders/my-orders` | `GET` | Prohibido (requiere `CLIENT`) | — | `403 Forbidden` |
| **DRIVER** | `/orders/:id/status` | `PATCH` | **Fail-closed**: Rechaza todas las mutaciones con `403 Forbidden` tras resolución de pertenencia (incluso transiciones terminales o inválidas), hasta que se implemente verificación de ruta en progreso en Issue #10 | — | `403 Forbidden` |
| **ADMIN** | `/orders` | `GET` | Lectura global de todos los pedidos del sistema | `200 OK` | `401`, `403` |
| **ADMIN** | `/orders/:id` | `GET` | Lectura global de cualquier pedido por ID | `200 OK` | `401`, `404` |
| **ADMIN** | `/orders/:id/status` | `PATCH` | Solo permite cancelar pedidos no terminales (`CANCELLED`). Rechaza `ASSIGNED` (reservado para `/routes/assign`) y rechaza transiciones operativas | `200 OK` | `400 Bad Request`, `401`, `404`, `409 Conflict` |

---

## 3. Grafo centralizado de ciclo de vida

El ciclo de vida del pedido se gobierna formalmente en [`src/modules/orders/order-status.policy.ts`](../src/modules/orders/order-status.policy.ts):

```
             ┌─────────────────────────┐
             │         PENDING         │
             └────────────┬────────────┘
                          │ (Asignación vía /routes/assign)
                          ▼
             ┌─────────────────────────┐
      ┌─────►│        ASSIGNED         ├─────┐
      │      └────────────┬────────────┘     │
      │                   │                  │
(Admin cancela)           ▼            (Admin cancela)
      │      ┌─────────────────────────┐     │
      │      │       IN_TRANSIT        │     │
      │      └────────────┬────────────┘     │
      │                   │                  │
      │                   ▼                  │
      │      ┌─────────────────────────┐     │
      │      │   DELIVERED (Terminal)  │     │
      │      └─────────────────────────┘     │
      │                                      │
      └──────────────► ┌───────────────────┐ ◄┘
                       │CANCELLED(Terminal)│
                       └───────────────────┘
```

### Reglas de transición

1. **Válidas:**
   - `PENDING` $\rightarrow$ `ASSIGNED`, `CANCELLED`
   - `ASSIGNED` $\rightarrow$ `IN_TRANSIT`, `CANCELLED`
   - `IN_TRANSIT` $\rightarrow$ `DELIVERED`, `CANCELLED`
2. **Estados terminales:**
   - `DELIVERED` y `CANCELLED` son terminales: no tienen transiciones salientes. Cualquier intento de cambio administrativo retorna `400 Bad Request`.
3. **Restricción de canal para `ASSIGNED`:**
   - La transición `PENDING` $\rightarrow$ `ASSIGNED` no se admite en `PATCH /orders/:id/status` para evitar asignaciones manuales sin control de capacidad de 4 pedidos por repartidor; debe realizarse exclusivamente mediante el endpoint transaccional `POST /routes/assign`.

---

## 4. Orden de evaluación en mutaciones (`updateStatus`)

Para evitar oráculos de información (donde un usuario no autorizado descubre el estado de un recurso ajeno a través de errores de transición como `400 Bad Request`), el flujo en `OrdersService.updateStatus` aplica estrictamente:

1. **Existencia del recurso:** Se busca la orden en base de datos. Si no existe, retorna `404 Not Found`.
2. **Autorización y pertenencia:**
   - Si el rol es `CLIENT`, se rechaza de inmediato con `403 Forbidden`.
   - Si el rol es `DRIVER`, se resuelve la cadena `User -> Driver -> Route -> Order`. Si no tiene perfil, el pedido no tiene ruta o la ruta pertenece a otro chofer, se rechaza con `403 Forbidden`. Si la ruta coincide, se deniega fail-closed con `403 Forbidden` debido a la dependencia de Issue #10. En ningún caso se evalúa el grafo para el chofer ni se retorna 400.
3. **Validación del ciclo de vida (exclusivo para `ADMIN`):**
   - Se valida `validateOrderTransition(order.status, dto.status)` arrojando `400 Bad Request` si la transición es inválida o el estado es terminal.
   - Se asegura que los administradores solo cancelen pedidos no terminales.
4. **Mutación atómica condicional:**
   - Actualización mediante `.where({ id, status: order.status })`, detectando carreras de concurrencia y retornando `409 Conflict` si el estado cambió previamente.

---

## 5. Prevención de concurrencia: escritura condicional atómica

En `OrdersService.updateStatus`, la mutación se realiza verificando el estado leído en la misma cláusula WHERE:

```typescript
const updated = await this.prisma.order
  .where({ id, status: order.status })
  .update({ status: dto.status });

if (!updated) {
  throw new ConflictException(
    'El pedido fue modificado concurrentemente y ya no se encuentra en el estado esperado',
  );
}
```

En PostgreSQL y Prisma 8, si dos transacciones concurrentes intentan actualizar el mismo pedido, la segunda encontrará que el estado ya no coincide con `order.status`. La consulta afecta 0 filas y retorna `null`, disparando un `409 ConflictException` sin corromper el estado de la base de datos.

---

## 6. Riesgos preexistentes identificados

Durante la auditoría y diseño de pruebas de integración, se identificó el siguiente aspecto fuera del alcance actual:

- **Visibilidad en endpoints de rutas (`RoutesController`):**
  - Los endpoints `GET /routes` y `GET /routes/:id` exigen estrictamente rol `ADMIN` (`@Roles(Role.ADMIN)`).
  - *Impacto:* Los repartidores actualmente no disponen de un endpoint para listar su propia ruta asignada de forma agrupada, dependiendo de consultar pedidos individuales (`GET /orders/:id`). Esto deberá ser abordado dentro del alcance del Issue #10.

---

## 7. Evidencia de verificación

Ejecución verificada en entorno local con PostgreSQL real:

- **Análisis estático:** `pnpm lint` $\rightarrow$ 0 errores, 0 advertencias (`oxlint --type-aware src/ test/`).
- **Compilación:** `pnpm build` $\rightarrow$ exitoso (`nest build`).
- **Pruebas unitarias:** `pnpm test --runInBand` $\rightarrow$ 19 suites pasadas, 141 pruebas pasadas.
- **Pruebas de integración E2E:** `pnpm test:e2e --runInBand` $\rightarrow$ 2 suites pasadas, 31 pruebas pasadas (30 pruebas de seguridad en `test/orders-security.e2e-spec.ts`).
- **Contrato de seguridad del ejecutor:** `pnpm test test/run-newman-isolated.spec.ts --runInBand` $\rightarrow$ 1 suite pasada, 4 pruebas pasadas verificando spawn efímero, cleanup en éxito/fallo y rechazo estricto de base de datos compartida o externa.
- **Suite de API Newman aislada:** `pnpm run test:api:isolated` / `pnpm run test:api:report` $\rightarrow$ 59 requests ejecutados, 242 aserciones pasadas (0 fallos) contra contenedor PostgreSQL efímero e independiente.

---

## 8. Arquitectura del ejecutor aislado de API (Newman) y pruebas de regresión

Para garantizar la reproducibilidad y prevenir la corrupción o reinicio indiscriminado de la base de datos de desarrollo (`DATABASE_URL`), las pruebas de API se ejecutan mediante `test/run-newman-isolated.sh`:

1. **Aislamiento absoluto de infraestructura:**
   - Cada ejecución levanta un contenedor PostgreSQL 16 efímero dedicado (`--rm`, sin volúmenes persistentes montados en el host).
   - El puerto es asignado dinámicamente por el kernel en loopback (`127.0.0.1::5432`), evitando colisiones con instancias existentes en el puerto 5432.
   - Credenciales desechables (`isolated_test`), sin exponer secretos en logs.
   - Se prohíbe terminantemente la reutilización o reseteo de bases de datos externas arbitrarias suministradas en el entorno (`DATABASE_URL`).
2. **Ciclo de vida y limpieza garantizada (`trap`):**
   - Una trampa POSIX (`trap cleanup EXIT INT TERM HUP`) asegura la terminación del proceso backend dedicado (`kill -TERM` al PID propio) y la eliminación forzada únicamente del contenedor propio (`docker rm -f $CONTAINER_ID`), tanto en caso de éxito como en fallo (`exit status` preservado).
   - Se eliminó el comando `seed:reset-drivers` de los scripts de ejecución de pruebas de API (`test:api` y `test:api:report`), erradicando mutaciones destructivas sobre bases de datos compartidas.
3. **Cobertura de seguridad en Newman (`delivery-api.postman_collection.json`):**
   - **Progresión de chofer fail-closed:** Las transiciones `IN_TRANSIT` y `DELIVERED` ejecutadas por el repartidor se evalúan como negativas con `403 Forbidden` preservando invariancia en base de datos, documentando formalmente que la progresión positiva queda pendiente de la implementación de `Route.IN_PROGRESS` (Issue #10).
   - **Autorización precede al grafo:** Intentos de mutación sobre pedidos `PENDING` por choferes sin asignación retornan `403 Forbidden` sin filtrar el estado del pedido.
   - **Validación DTO:** Valores de enumeración inválidos (`VOLANDO`) retornan `400 Bad Request` disparados por `ValidationPipe`.
   - **Validación cruzada de identidad (2 choferes / 2 clientes):** Pruebas cruzadas de lectura y escritura (`GET /orders/:id` y `PATCH /orders/:id/status`) verifican que el Cliente 2 y el Chofer 2 reciben `403 Forbidden` al intentar acceder o mutar pedidos del Cliente 1 o rutas del Chofer 1.
   - **Operaciones de administrador:** Validación de que el administrador puede cancelar pedidos no terminales (`200 OK` $\rightarrow$ `CANCELLED`), pero se le deniega forzar `ASSIGNED` (`400 Bad Request`) o ejecutar transiciones operativas (`IN_TRANSIT`, `400 Bad Request`).
   - **Protección de estados terminales e invariancia:** Intentos de mutación sobre pedidos cancelados retornan `400 Bad Request`, acompañados de consultas administrativas `GET` completas que verifican la invariancia de todos los campos estables (`id`, `userId`, `zoneId`, `routeId`, `total`, `deliveryAddress`, `items`).
