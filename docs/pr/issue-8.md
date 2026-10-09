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
- **Ejecutor aislado y seguro de pruebas de API (`test/run-newman-isolated.sh` y `test/run-newman-isolated.spec.ts`):** Contenedor efímero dedicado en puerto dinámico loopback, inicialización y seed exclusivamente en BD propia, rechazo estricto de `DATABASE_URL` externa/heredada, backend dedicado, captura de señales (SIGINT 130, SIGTERM 143), preservación de códigos de error y limpieza atómica al salir.
- **Integración y contrato en CI (`.github/workflows/ci.yml` y `test/ci-security.spec.ts`):** Verificación de sintaxis shell (`bash -n`) y `shellcheck`, ejecución de E2E (31 pruebas) contra servicio PostgreSQL temporal antes de Newman, e invocación segura `env -u DATABASE_URL pnpm run test:api:report` para preservar la autonomía del runner aislado sin colisiones.
- **Documentación de seguridad (`docs/order-security.md`):** Matriz de permisos, orden de evaluación, ciclo de vida, códigos de error HTTP, arquitectura del runner y análisis de visibilidad de rutas.

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | APROBADO | `pnpm lint` (`oxlint --type-aware src/ test/`) ejecutado con 0 errores y 0 advertencias. |
| Validación de scripts shell | APROBADO | `bash -n test/run-newman-isolated.sh` (exit 0) y validación estática con contenedor `docker run --rm -i koalaman/shellcheck:v0.10.0 - < test/run-newman-isolated.sh` (exit 0 sin advertencias). Configurado en CI como control obligatorio. |
| Compilación | APROBADO | `pnpm build` (`nest build`) compiló exitosamente sin errores de compilación TypeScript. |
| Pruebas unitarias y contrato | APROBADO | `pnpm test --runInBand` ejecutado con 21 suites aprobadas y 156 pruebas aprobadas. |
| Cobertura de código (CI >= 80 %) | APROBADO | `pnpm run test:cov` superó el umbral del 80 %: Statements 98.08 %, Branches 87.82 %, Functions 92.68 %, Lines 98.10 %. |
| Pruebas de integración E2E | APROBADO | `pnpm test:e2e --runInBand` ejecutado contra PostgreSQL efímero con 2 suites aprobadas y 31 pruebas aprobadas. |
| Pruebas de API (Newman aislado) | APROBADO | `env -u DATABASE_URL pnpm run test:api:report` con 59 requests y 242 aserciones aprobadas (0 fallos). |

## Evidencias

### 1. Análisis estático (`pnpm lint`)
```text
$ oxlint --type-aware src/ test/
```

### 2. Validación de scripts shell
```text
$ bash -n test/run-newman-isolated.sh
# exit 0
$ docker run --rm -i koalaman/shellcheck:v0.10.0 - < test/run-newman-isolated.sh
# exit 0
```

### 3. Compilación (`pnpm build`)
```text
$ nest build
```

### 4. Pruebas unitarias y contratos (`pnpm test --runInBand`)
```text
Test Suites: 21 passed, 21 total
Tests:       156 passed, 156 total
Snapshots:   0 total
Time:        17.601 s
Ran all test suites.
```

### 5. Cobertura de código (`pnpm run test:cov`)
```text
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
-------------------|---------|----------|---------|---------|-------------------
All files          |   98.08 |    87.82 |   92.68 |    98.1 |
-------------------|---------|----------|---------|---------|-------------------
Test Suites: 21 passed, 21 total
Tests:       156 passed, 156 total
```

### 6. Pruebas de integración E2E (`pnpm test:e2e --runInBand`)
```text
Test Suites: 2 passed, 2 total
Tests:       31 passed, 31 total
Snapshots:   0 total
Time:        2.439 s
Ran all test suites.
```

### 7. Pruebas de API Newman (`env -u DATABASE_URL pnpm run test:api:report`)
```text
┌─────────────────────────┬──────────────────┬──────────────────┐
│                         │         executed │           failed │
├─────────────────────────┼──────────────────┼──────────────────┤
│              iterations │                1 │                0 │
├─────────────────────────┼──────────────────┼──────────────────┤
│                requests │               59 │                0 │
├─────────────────────────┼──────────────────┼──────────────────┤
│              assertions │              242 │                0 │
└─────────────────────────┴──────────────────┴──────────────────┘
Reporte HTML: reports/newman/informe-api.html
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
- *Aceptación parcial y dependencia de Issue #10:* Las transiciones operativas del repartidor (`IN_TRANSIT`, `DELIVERED`) están configuradas de forma fail-closed con `403 Forbidden` tras resolver la pertenencia del pedido a la ruta. No se omiten estas pruebas en la colección de Newman ni en E2E; se ejecutan y validan como peticiones negativas con código 403. La progresión operativa positiva (`ASSIGNED` $\rightarrow$ `IN_TRANSIT` $\rightarrow$ `DELIVERED`) requiere la comprobación de `Route.IN_PROGRESS` y queda formalmente delegada al Issue #10.
- *Validación DTO de esquemas:* Todo valor de estado inválido suministrado en la petición (ej. `VOLANDO`) es rechazado con `400 Bad Request` por `ValidationPipe` antes de procesar reglas de negocio.
- *Aislamiento estricto del ejecutor y rechazo de variables externas:* `test/run-newman-isolated.sh` gestiona exclusivamente un contenedor PostgreSQL efímero y un proceso backend dedicado en loopback con puertos dinámicos. Rechaza incondicionalmente cualquier `DATABASE_URL` heredada en el entorno (exit 1). En CI y ejecución local se invoca con `env -u DATABASE_URL pnpm run test:api:report`.
- *Visibilidad de rutas para repartidores:* Los repartidores no cuentan actualmente con un endpoint propio para consultar el listado de pedidos de su ruta asignada en `RoutesController`, dado que dichos endpoints están restringidos a `ADMIN`.
- *Pipeline de CI remoto pendiente:* La integración automatizada en GitHub Actions está configurada en `.github/workflows/ci.yml` (con jobs de calidad y E2E + Newman aislado sin `continue-on-error`), pero su ejecución remota real queda sujeta a la publicación y ejecución del pipeline en GitHub.

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
