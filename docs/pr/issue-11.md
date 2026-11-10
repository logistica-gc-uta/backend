## Descripción

Implementación integral del registro administrativo de pedidos (ADMIN) tanto para clientes registrados existentes (`REGISTERED_CLIENT`) como para destinatarios invitados (`GUEST`), preservando la integridad del histórico, el aislamiento transaccional de stock con bloqueos deterministas y la coherencia temporal de fechas de entrega en huso horario `America/Guayaquil`, dando cumplimiento completo a los requisitos del Issue #11.

## Issue relacionado

Closes #11

### Excepción de Tamaño Aprobada por el Mantenedor (`size:exception`)

- **Estrategia de entrega:** `single-pr`; decisión formal de mantenedor registrada en `odd/tasks/11-admin-guest-orders.md` y `docs/issue-11-admin-guest-orders.md`.
- **Justificación:** La persistencia Prisma 8 (contrato, artefactos emitidos `contract.d.ts`/`contract.json`, migración generada `20261012T1315_admin_guest_orders` y snapshot congelado), los DTOs de autorización y serialización discriminada, las reservas transaccionales de inventario y los runners aislados constituyen una unidad atómica indivisible. Su partición rompería la coherencia del esquema relacional y el historial de migraciones en estados intermedios.
- **Resolución RDD:** Al superar el presupuesto nativo de contexto del revisor por el volumen indivisible de Prisma 8 / migraciones (`lens_context_budget_exceeded`), y conforme al precedente de los PRs #21 (Issue #9) y #22 (Issue #10), se aplicó la excepción de tamaño y se desactivó RDD a nivel de clon local (`clone-local: off`).

---

## Cambios realizados

1. **Aislamiento de Infraestructura y Runners (Unit 1):**
   - Configuración de runners canónicos para ejecución en PostgreSQL 16 efímero y Newman aislado (`test/run-e2e-isolated.sh`, `test/run-newman-isolated.sh`).
   - Declaración de compatibilidad legacy downstream no oficial (`types/prisma-legacy-rawsql-compat.d.ts`) y suite semántica con 17 fixtures negativos (`test/prisma-legacy-rawsql-compat.spec.ts`) para resolver incompatibilidad estricta de TypeScript raíz sin tocar migraciones históricas.
2. **Modelo Relacional & Migración Prisma 8 (Unit 2):**
   - Atributos `userId` nullable en `Order` para soportar órdenes de invitados (`GUEST`).
   - Relación explícita `createdById` apuntando a `User` (ADMIN autenticado).
   - Metadatos de destinatario: `recipientType`, `recipientName`, `recipientPhone`.
   - Ventanas de entrega persistidas como instantes (`deliveryWindowStart`, `deliveryWindowEnd`).
   - Snapshot congelado en `migrations/snapshots/e357d1aa...` y migración SQL real verificada.
3. **API, DTOs y Seguridad RBAC (Unit 3):**
   - Endpoint exclusivo `POST /api/v1/orders/admin` protegido con JWT y validación estricta de rol `ADMIN`.
   - DTOs discriminados (`CreateAdminOrderDto`, `AdminGuestRecipientDto`, `AdminClientRecipientDto`) con validación estricta (`exactOptionalPropertyTypes`).
   - Proyecciones basadas en rol (`order-response.util.ts`) que anonimizan datos sensibles de contacto para clientes y exponen información completa solo a ADMIN y DRIVER asignado.
   - Paginación acotada y filtros por día de negocio Guayaquil, estado y zona en listados administrativos.
4. **Inventario Transaccional y Reglas Temporales (Unit 4):**
   - Consolidación y reserva atómica de inventario dentro de una única transacción PostgreSQL con bloqueos `FOR UPDATE` ordenados por ID de producto.
   - Validación de entrega en días laborables y franja horaria válida en huso horario `America/Guayaquil` (`order-delivery.util.ts`), rechazando fechas pasadas.
5. **Documentación y Calidad (Unit 5):**
   - Colección Newman/Postman actualizada con 11 nuevas requests de Issue #11 y verificación de limpieza de contenedores.
   - Runbook y contrato técnico exhaustivo en `docs/issue-11-admin-guest-orders.md` y `README.md`.

---

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático (Linter) | Local PASS | `oxlint --type-aware src/ test/` (0 errores, 1 advertencia histórica en route-start) |
| TypeScript raíz y build | Local PASS | `tsc --noEmit` y `tsc -p tsconfig.build.json` (0 diagnósticos) |
| Pruebas unitarias | Local PASS | Jest: 44 suites / 559 pruebas PASS con cobertura integral (Statements 90.79%, Branches 81.73%, Functions 89.08%, Lines 92.05%) |
| Pruebas de integración E2E | Local PASS | Runner aislado: 18 suites / 322 pruebas PASS en PostgreSQL 16 efímero |
| Compilación | Local PASS | `pnpm run build` (salida limpia en `dist/`) |
| Pruebas funcionales (Newman) | Local PASS | Runner aislado: 104 requests / 434 assertions PASS (cero fallos, 0 residuos de Docker) |

## Evidencias

- **Digest de artefactos inmutables de migraciones:** `c81d4ab9f89f57fc1337a9c770da2c59368b73c0239887dc899307419c9f0cc9` verificado antes y después.
- **Limpieza de recursos:** Contenedores PostgreSQL temporales auditados por label `delivery.issue6.owner` con 0 recursos remanentes al finalizar.
- **Estructura de commits:** 5 commits atómicos según la especificación `work-unit-commits`.

## Impacto técnico

**API / Contratos:**
- Nuevo endpoint `POST /api/v1/orders/admin` para administradores.
- `POST /api/v1/orders` permanece intacto y exclusivo para `CLIENT`.
- DTO de respuesta `OrderResponseDto` adapta `userId` nullable y expone metadatos de invitado según permisos.

**Base de datos / Migraciones:**
- Migración aditiva Prisma 8 compatible con datos históricos existentes sin backfills destructivos.
- Constraints CHECK y Foreign Keys íntegras en PostgreSQL 16.

**Seguridad y permisos:**
- Prevención de suplantación de identidad (IDOR): validación real de existencia de usuarios `CLIENT` en BD.
- Minimización de datos: ocultamiento de datos de contacto de invitados ante terceros no autorizados.

**Compatibilidad con otros componentes:**
- Coherencia completa con los módulos de rutas (#7, #10), geolocalización (#9) y seguridad (#8).

**Limitaciones conocidas:**
- ShellCheck no estuvo disponible en el entorno local (verificación sintáctica completada con `bash -n` y `node --check`).
- Intervalo milimétrico entre la última comprobación de reloj y el COMMIT gobernado por PostgreSQL.

## Checklist de entrega

- [x] Cumplí los criterios de aceptación del Issue.
- [x] Implementé únicamente los cambios necesarios.
- [x] Ejecuté las pruebas correspondientes.
- [x] Verifiqué que el código compile correctamente.
- [x] Comprobé los posibles errores y excepciones.
- [x] Actualicé la documentación cuando fue necesario.
- [x] No incluí credenciales ni información sensible.
- [x] Adjunté evidencia de los resultados.
- [x] Solicité revisión a otro integrante.

## Observaciones para el revisor

Este Pull Request contiene la implementación completa y verificada del Issue #11. Se estructuró en 5 commits atómicos siguiendo la convención `work-unit-commits`. Cuenta con una excepción de tamaño aprobada (`size:exception`) debido a la inclusión obligatoria de artefactos emitidos de Prisma 8 y snapshots de migración. Por favor revisar especialmente las políticas de autorización en `OrdersController`, las reservas atómicas en `OrdersService` y los tests de regresión en `test/admin-guest-orders-api.e2e-spec.ts`.
