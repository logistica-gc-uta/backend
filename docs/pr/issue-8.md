## Descripción

Este Pull Request implementa y valida de forma integral la autorización basada en identidad autenticada (JWT) y el gobierno del ciclo de vida para los pedidos (`Orders`), mitigando vulnerabilidades críticas de control de acceso directo a objetos (IDOR / BOLA) identificadas en el Issue #8. 

Asegura que los clientes únicamente accedan a sus propios pedidos, que los repartidores resuelvan pertenencia a través de su ruta asignada (`User -> Driver -> Route -> Order`), que la autorización de rol y pertenencia se ejecute de forma prioritaria antes de cualquier validación del ciclo de vida (evitando oráculos que revelen el estado de recursos ajenos mediante respuestas 400), que las mutaciones de repartidores permanezcan protegidas bajo una política estricta *fail-closed* hasta la integración del Issue #10, y que las transiciones de estado respeten un grafo finito unívoco con escrituras condicionales atómicas frente a modificaciones concurrentes.

## Issue relacionado

Refs #8

> *Nota sobre cierre automático:* Se utiliza `Refs #8` de forma deliberada en lugar del marcador de cierre del template (`Closes #NUMERO`) porque la aceptación del trabajo es parcial: la funcionalidad de avance de pedidos por repartidor depende de la verificación de ruta en progreso del Issue #10, y restan pendientes la ejecución en pipelines de integración continua (CI) y la aprobación del PR integrado.

## Cambios realizados

- **Resolución de identidad autenticada:** Se vinculó el contexto autenticado de NestJS (`@CurrentUser()`) y la estrategia JWT con la persistencia en PostgreSQL, ignorando identificadores inyectados arbitrariamente por el cliente.
- **Prioridad estricta de autorización sobre el ciclo de vida:**
  - Se reordenó `OrdersService.updateStatus` para evaluar rol y pertenencia antes de invocar la validación del grafo de transiciones.
  - `CLIENT`: Denegación inmediata con `403 Forbidden` por rol tanto en intentos de lectura no autorizados como en cualquier mutación de estado (incluso sobre estados terminales).
  - `DRIVER`: Verificación de la cadena `User -> Driver -> Route -> Order`. Lectura permitida exclusivamente sobre pedidos de su ruta asignada. Denegación consistente con `403 Forbidden` en todas las mutaciones tras resolver pertenencia (fail-closed dependiente de #10), sin exponer errores de validación de grafo (`400 Bad Request`) a repartidores.
  - `ADMIN`: Lectura global habilitada y facultad de cancelación de pedidos no terminales. Rechazo con `400 Bad Request` ante transiciones inválidas del grafo o intentos de asignación operativa en este endpoint.
- **Grafo centralizado de ciclo de vida (`order-status.policy.ts`):** Definición formal de transiciones válidas (`PENDING` -> `ASSIGNED`/`CANCELLED`, `ASSIGNED` -> `IN_TRANSIT`/`CANCELLED`, `IN_TRANSIT` -> `DELIVERED`/`CANCELLED`), inmutabilidad de estados terminales (`DELIVERED`, `CANCELLED`) y rechazo con `400 Bad Request` ante transiciones inválidas para administradores.
- **Escritura condicional atómica:** Implementación de filtro `.where({ id, status })` en la mutación para detectar colisiones de concurrencia y responder `409 Conflict`.
- **Suite de pruebas de integración E2E con PostgreSQL real (`orders-security.e2e-spec.ts` y `orders-security.fixtures.ts`):** 30 casos de prueba de seguridad con JWT real, guards de producción, aislamiento estricto de fixtures por IDs creados y limpieza garantizada en `try/finally` sin reinicio de datos ni migraciones destructivas.
- **Documentación de seguridad (`docs/order-security.md`):** Matriz de permisos, orden de evaluación, ciclo de vida, códigos de error HTTP y análisis de visibilidad de rutas.

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | APROBADO | `pnpm lint` (`oxlint --type-aware src/ test/`) ejecutado con 0 errores y 0 advertencias. |
| Pruebas unitarias | APROBADO | `pnpm test --runInBand` ejecutado con 19 suites aprobadas y 141 pruebas unitarias aprobadas. |
| Pruebas de integración | APROBADO | `pnpm test:e2e --runInBand` ejecutado contra PostgreSQL real con 2 suites aprobadas y 31 pruebas aprobadas (30 pruebas de seguridad en `test/orders-security.e2e-spec.ts`). |
| Compilación | APROBADO | `pnpm build` (`nest build`) compiló exitosamente sin errores de compilación TypeScript. |
| Pruebas funcionales | N/A | Las pruebas funcionales integrales de extremo a extremo con herramientas de API externas corresponden a etapas posteriores de despliegue y no forman parte del cambio de autorización en backend. |

## Evidencias

### 1. Análisis estático (`pnpm lint`)
```text
$ oxlint --type-aware src/ test/
```

### 2. Compilación (`pnpm build`)
```text
$ nest build
```

### 3. Pruebas unitarias (`pnpm test --runInBand`)
```text
Test Suites: 19 passed, 19 total
Tests:       141 passed, 141 total
Snapshots:   0 total
Time:        6.97 s
Ran all test suites.
```

### 4. Pruebas de integración E2E (`pnpm test:e2e --runInBand`)
```text
Test Suites: 2 passed, 2 total
Tests:       31 passed, 31 total
Snapshots:   0 total
Time:        2.461 s
Ran all test suites.
```

## Impacto técnico

**API / Contratos:**
- Se mantiene retrocompatibilidad con la firma de los endpoints en Swagger.
- `GET /orders/:id`: Responde `403 Forbidden` si un `CLIENT` consulta un pedido ajeno o si un `DRIVER` consulta un pedido de otra ruta o sin ruta.
- `PATCH /orders/:id/status`: Exige rol `DRIVER` o `ADMIN`. Para `ADMIN` valida el grafo y solo permite cancelación (`CANCELLED`). Para `DRIVER`, responde `403 Forbidden` (*fail-closed*) tras validar pertenencia, detallando la restricción de Issue #10. Las transiciones no permitidas por el grafo intentadas por `ADMIN` responden `400 Bad Request`.

**Base de datos / Migraciones:**
- Cero migraciones de esquema requeridas. El modelo relacional existente en Prisma 8 (`contract.prisma`) soporta todas las consultas y relaciones requeridas (`User`, `Driver`, `Route`, `Order`).
- No se ejecutan operaciones destructivas (`TRUNCATE`, `DROP` ni reinicios de datos existentes).

**Seguridad y permisos:**
- Erradicación de vulnerabilidades de acceso directo a objetos (IDOR/BOLA) en `/orders/:id`.
- Autenticación obligatoria mediante JWT válido en todos los endpoints de pedidos (`JwtAuthGuard`).
- Control de acceso basado en roles (`RolesGuard`) y verificación contextual de propiedad por recurso.
- Mitigación de oráculos de estado: la autorización precede a la validación de transiciones de ciclo de vida.
- Mitigación de condiciones de carrera (*stale mutations*) con escritura condicional atómica a nivel de BD.

**Compatibilidad con otros componentes:**
- El servicio de rutas (`RoutesService.assignRoute`) continúa operando de forma compatible, asignando pedidos en estado `PENDING` a rutas y actualizándolos a `ASSIGNED` de forma atómica dentro de su transacción.

**Limitaciones conocidas:**
- *Aceptación parcial y dependencia de Issue #10:* Las actualizaciones de estado operativas por parte del repartidor (`IN_TRANSIT`, `DELIVERED`) están bloqueadas preventivamente (*fail-closed*) hasta que el Issue #10 provea la lógica de verificación de ruta en progreso (`Route.IN_PROGRESS`).
- *Visibilidad de rutas para repartidores:* Los repartidores no cuentan actualmente con un endpoint propio para consultar el listado de pedidos de su ruta asignada en `RoutesController`, dado que dichos endpoints están restringidos a `ADMIN`.

## Checklist de entrega

- [ ] Cumplí los criterios de aceptación del Issue.
- [x] Implementé únicamente los cambios necesarios.
- [x] Ejecuté las pruebas correspondientes.
- [x] Verifiqué que el código compile correctamente.
- [x] Comprobé los posibles errores y excepciones.
- [x] Actualicé la documentación cuando fue necesario.
- [x] No incluí credenciales ni información sensible.
- [x] Adjunté evidencia de los resultados.
- [ ] Solicité revisión a otro integrante.

> *Nota del checklist:* El ítem "Cumplí los criterios de aceptación del Issue" permanece desmarcado intencionalmente debido a que el trabajo es parcial: la aceptación completa del flujo de entrega requiere la implementación de la ruta en progreso dependiente del Issue #10, la validación en el pipeline de CI del repositorio y la integración del PR en develop/main.

## Observaciones para el revisor

- Prestar atención al orden de evaluación en `OrdersService.updateStatus`: la pertenencia y el rol se validan antes de la política de estados, garantizando que usuarios no autorizados no reciban información sobre la validez de transiciones en recursos que no les pertenecen.
- Revisar la suite de pruebas E2E en `test/orders-security.e2e-spec.ts` y sus fixtures en `test/orders-security.fixtures.ts`, las cuales corren contra una base de datos PostgreSQL real y garantizan aislamiento absoluto mediante limpieza de IDs específicos vía `try/finally`.
