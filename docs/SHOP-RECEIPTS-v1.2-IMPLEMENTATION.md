# Guía de Implementación — Shop Receipts & Consultas CLIENT v1.2 (Issue #34)

## 1. Visión General
Implementación modular y aditiva de los endpoints de lectura para compras CLIENT en REGALÍA Shop v1.2 (`src/modules/shop/orders`), cubriendo las tareas T2 y T3 de la Issue #34:
- `GET /api/v1/shop/orders`: Historial propio paginado con filtros y metadatos ordenados de forma determinista (`createdAt desc, id desc`).
- `GET /api/v1/shop/orders/:id`: Detalle completo con datos congelados y línea de tiempo logística verificada.
- `GET /api/v1/shop/orders/:id/receipt`: Comprobante simulado único e inmutable, seguro para renderizado o impresión HTML.

## 2. Campos Congelados vs. Campos Vivos
Para cumplir con S4 e inmutabilidad estricta:
- **Campos congelados** (persistidos en `PurchaseReceipt` y su `snapshot` JSON inmutable):
  - Montos monetarios exactos: `subtotalCents`, `taxAmountCents`, `taxRateBps`, `taxEnabled`, `shippingAmountCents: 0`, `totalCents`.
  - Tasa de impuesto simulado: `tax.ratePercent = taxRateBps / 100`, `tax.enabled` inmutable al momento de aprobación.
  - Ítems comprados: `name`, `sku`, `quantity`, `unitPriceCents`, `lineTotalCents`, e `imageUrl` histórica.
  - Snapshot de comprador y destinatario: nombre, correo, teléfono y dirección de entrega.
  - Datos de pago: `reference` y `cardLast4`.
  - Modificaciones posteriores de ADMIN en productos (nombre, SKU, precio), categorías o tasas de IVA en `ShopBusinessSettings` **NO** alteran compras previas.
- **Campos vivos** (consultados de la entidad `Order`):
  - `status`: Estado actual del pedido (`PENDING | ASSIGNED | IN_TRANSIT | DELIVERED | CANCELLED`).
  - `routeId`: Identificador de la ruta logística asignada o `null`.

## 3. Seguridad y Control de Acceso
- **Autenticación y Rol**: Resguardado con `JwtAuthGuard` y `RolesGuard` restringido a `@Roles(Role.CLIENT)`.
  - Peticiones anónimas o con JWT inválido devuelven `401 UNAUTHENTICATED`.
  - Peticiones de roles ajenos (`ADMIN`, `DRIVER`) devuelven `403 FORBIDDEN`.
- **Prevención IDOR / BOLA**:
  - Las consultas SQL filtran estrictamente por `o."userId" = ${buyerUserId} AND r."buyerId" = ${buyerUserId}`.
  - Peticiones de pedidos ajenos o inexistentes devuelven idéntico `404 ORDER_NOT_FOUND` sin filtrar información.
  - Parámetros `userId` forjados en query son rechazados con `400 VALIDATION_ERROR` vía `ValidationPipe({ forbidNonWhitelisted: true })`.
- **Proyección Segura**:
  - Nunca se exponen números completos de tarjeta (PAN), CVVs, saldo, hashes ni secretos internos.
  - El comprobante proyecta únicamente `reference` y `cardLast4`.
  - `disclaimer` obligatorio literal: `COMPROBANTE DE COMPRA SIMULADO — SIN VALIDEZ TRIBUTARIA`.

## 4. Imágenes Históricas Nullables
- En `SoldItem` y `OrderSummary`, `imageUrl` y `primaryImageUrl` proyectan la URL almacenada en el snapshot al momento de compra, o `null` si no existía.
- No se realiza join con el catálogo actual (`ProductImage`) ni backfill para evitar mutaciones de datos históricos.

## 5. Eventos y Línea de Tiempo Logística (S7)
- La línea de tiempo (`timeline`) refleja **únicamente marcas de tiempo persistidas y verificables**:
  - `PENDING`: Fecha de registro del pedido (`order.createdAt`).
  - `ASSIGNED` / `CLAIM_RELEASED`: Asignación y desasignación verificada desde `OrderClaim` (`claimedAt`, `releasedAt`).
  - `IN_TRANSIT`: Inicio de recorrido de la ruta (`route.startedAt`).
  - `DELIVERED` / `ATTEMPT_FAILED`: Intentos de entrega reales desde `DeliveryAttempt` (`recordedAt`), reportando el motivo de fallo (`RECIPIENT_ABSENT`, `RECIPIENT_REFUSED`) sin exponer PII del chofer ni datos de telemetría inventados.
- Eventos ordenados cronológicamente con desempate estable por identidad persistida de la entidad. Se preservan intentos distintos que comparten fecha y código; no se deduplican por esos campos.

## 6. Estado de Verificación
- **Pruebas Unitarias y Cobertura Medida**: 17 pruebas pasando (3 suites: controller, service y module bootstrap DI).
  - Comando: `env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null NODE_OPTIONS=--max-old-space-size=4096 pnpm run test --runInBand --testPathPatterns=src/modules/shop/orders --coverage --collectCoverageFrom='src/modules/shop/orders/orders.{service,controller}.ts'`
  - Cobertura enfocada del módulo (no global del proyecto): `Stmts: 92.07% | Branch: 83.42% | Funcs: 100% | Lines: 91.66%` (service: 90.78% stmts, 84.43% branch, 100% funcs, 90.37% lines; controller: 100% stmts, 75% branch, 100% funcs, 100% lines).
  - Resultado: `3 passed, 3 total, 17 passed, 17 total`.
- **Chequeo de Tipos TypeScript**:
  - Comando: `env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null pnpm exec tsc --noEmit --pretty false`
  - Resultado: `0 errores` (salida limpia).
- **Linter Oxlint**:
  - Comando: `pnpm exec oxlint --type-aware src/modules/shop/orders test/shop-orders-v12.e2e-spec.ts test/shop-orders-v12.fixtures.ts`
  - Resultado: `0 advertencias, 0 errores` (salida limpia).
- **Suite de Integración PostgreSQL (E2E verificada en contenedor desechable)**:
  - Archivos: `test/shop-orders-v12.e2e-spec.ts` y `test/shop-orders-v12.fixtures.ts`.
  - Comando: `env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null NODE_OPTIONS=--max-old-space-size=4096 pnpm run test:e2e --runInBand --runTestsByPath test/shop-orders-v12.e2e-spec.ts`
  - Resultado: `1 passed, 1 total, 20 passed, 20 total` en ~10.4s.
  - Validación de ciclo logístico real: Planificación de ruta con fecha comercial válida en zona horaria de Guayaquil, asignación a perfil `Driver`, inicio de ruta por chofer (`IN_TRANSIT`), registro de intento fallido (`RECIPIENT_ABSENT`) con retención administrativa de pedido 1, y entrega exitosa (`DELIVERED`) en pedido 2 con cronología verificada.
  - Validación de inmutabilidad y cálculo tributario: Mutación administrativa de configuración pública vía `PATCH /api/v1/admin/shop-settings` y persistencia verificada; compras evaluadas con IVA ficticio desactivado (0%), tasa del 12% con redondeo `HALF_UP` y tasa original del 15% congelada; verificación de idempotencia y conteo exacto de recibos en base de datos.
  - Contenedor desechable gestionado con registro explícito de recibo y limpieza (`TEST-CONTAINER-RECEIPT` / `TEST-CONTAINER-CLEANUP`).


## 7. Gates del proyecto e incidente de verificación

- Build de producción: PASS, exit 0 (5 s).
- Gate unitario global: PASS, 948 pruebas / 81 suites; statements 87.42 %, branches 80.26 %, functions 84.61 %, lines 89.28 % (umbral original de 80 % en todas las métricas). No confundirlo con la cobertura enfocada del módulo de la sección anterior.
- Comprobación PostgreSQL propia del coordinador: 20/20 PASS (11.206 s), antes del incidente de dependencias.
- Lint completo: exit 0 con 13 warnings existentes. La invocación de TypeScript terminó con exit 0. Ambas invocaciones pnpm mostraron reinstalación/postinstall inesperados, registrados como incidente, no como estado de entorno intacto.
- Manifest completo de 32 suites: PASS en el reemplazo autorizado (job-7, 9 min 42 s): 29 suites autogestionadas / 490 casos y 3 legacy / 59 casos, total 549. Limpieza confirmada; hashes de manifiestos, política y metadatos de dependencias iguales antes/después. El intento anterior falló durante reinstalaciones concurrentes; su evidencia se conserva en el ledger.
- Revisión independiente GPT: inspección de código favorable, sin nuevo bloqueante grave. El reemplazo autorizado en copia física con almacén propio pasó: 20/20 pruebas, exit 0, 11.451 s. El verificador confirmó la eliminación del contenedor y hashes originales/copiados intactos. La primera ejecución fallida por symlink/auto-install se conserva en el ledger, no se presenta como aprobada.
- No se ejecutó reparación, reinstalación adicional ni reintento tras identificar el incidente. Manifiestos y lockfile no cambiaron. No hay contenedores con etiqueta geo-owner-token pendientes según la consulta de cierre.
- Estado técnico local: implementación, regresión completa y reemplazo de ejecución independiente aprobados. La copia usa dependencias físicas con almacén privado y PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=error; no cambió el proyecto original. La aceptación global de entrega no se infiere de estas pruebas: publicación del PR, CI remoto, acuerdo frontend y revisión humana siguen pendientes.
