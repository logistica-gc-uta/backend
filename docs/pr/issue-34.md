## Descripción

Historial, detalle y comprobante académico de compras REGALÍA para CLIENT, reutilizando los recibos y snapshots atómicos de la Issue #33. Preparación local verificada; este borrador no está aprobado por una persona ni publicado.

## Issue relacionado

Refs #34

Referencia no cerrante en este borrador; confirmar el cierre de la issue antes de publicar.

## Cambios realizados

- Consultas aditivas `GET /api/v1/shop/orders`, `/:id` y `/:id/receipt`, con identidad JWT, rol CLIENT y protección de ownership.
- Importes, productos, comprador, destinatario e información comercial históricos desde `PurchaseReceipt`; imágenes no capturadas como `null`, sin reconstrucción desde catálogo actual.
- Estado logístico vigente y timeline únicamente desde eventos persistidos; DTOs explícitos y Swagger/OpenAPI v1.2.
- Pruebas unitarias y PostgreSQL descartable propio. Sin entidades, migraciones, lógica de pago ni cambios de semántica en `Order.total`.

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | PASS; incidente de entorno contenido y documentado | Oxlint ejecutó el análisis completo con 13 warnings existentes. Las invocaciones de pnpm también reinstalaron dependencias inesperadamente; no se presenta como un entorno intacto. |
| Pruebas unitarias | PASS: 948 pruebas / 81 suites | Gate global observado antes del incidente: statements 87.42 %, branches 80.26 %, functions 84.61 %, lines 89.28 %. Umbral 80 % sin cambios; job-5, 68.041 s. |
| Pruebas de integración | PASS: manifest completo de 32 suites / 549 casos | Reemplazo autorizado job-7: 29 suites autogestionadas / 490 casos y 3 legacy / 59 casos. Limpieza de PostgreSQL confirmada; manifiestos, política y metadatos de dependencias sin cambios. El intento anterior falló por el incidente de reinstalación y queda documentado en el ledger. |
| Compilación | PASS (exit 0; 5 s) | `env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null NODE_OPTIONS=--max-old-space-size=4096 pnpm run build`; job-4. |
| Pruebas funcionales | PASS local e independiente; aceptación de entrega pendiente | IVA 15 % / 12 % HALF_UP / desactivado, configuración ADMIN pública, catálogo mediante fixture, idempotencia y ciclo DRIVER real observados. El reemplazo del chequeo independiente pasó 20/20 casos en 11.451 s, dentro de una copia física con almacén privado; hashes originales/copiados intactos y limpieza confirmada. |

## Evidencias

Contrato y registro: `odd/tasks/34-shop-receipts-v12.md` (T1–T5, S1–S12).
Guía: `docs/SHOP-RECEIPTS-v1.2-IMPLEMENTATION.md`.
Commit funcional: `7ef9300e159a96cc4db613cf9ebfe3b3c7c829a9` (`feat(shop-orders): expose own historical purchases and receipts`).

Comandos principales observados:
- Unitarias/cobertura: `pnpm run test:cov --runInBand --coverageThreshold='{"global":{"statements":80,"branches":80,"functions":80,"lines":80}}'`, con DATABASE_URL/JWT_SECRET ausentes y DOTENV_CONFIG_PATH=/dev/null.
- Regresión completa: `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=error node test/run-e2e-isolated.mjs`, con entorno limpio y heap de 4 GB; 32 suites / 549 casos.
- Prueba independiente: `pnpm run test:e2e --runInBand --runTestsByPath test/shop-orders-v12.e2e-spec.ts`, en copia física con almacén privado y guard contra auto-install; 20/20, exit 0.
- Build y TypeScript sin errores; lint sin errores y con 13 warnings existentes; diff sin errores de whitespace.

No hay ejecución remota de GitHub Actions asociada a este borrador ni revisión humana obtenida.

## Impacto técnico

**API / Contratos:** nuevos endpoints Shop; paginación 1/10, tamaño máximo 50, estados logísticos existentes, errores Shop y proyecciones explícitas. No sustituye `/orders`.

**Base de datos / Migraciones:** reutiliza `Order`, `PurchaseReceipt`, `PaymentAttempt` e historial operativo. Sin modificaciones de contrato Prisma ni migraciones nuevas.

**Seguridad y permisos:** CLIENT dueño; anónimo/JWT inválido 401; roles ajenos 403; recursos ajenos/inexistentes 404. No exponer PAN, CVV, saldo, hashes, contexto privado del conductor ni datos de otras cuentas. Inspección independiente GPT de fuentes favorable y ejecución pública PostgreSQL independiente 20/20 aprobada. El resultado corresponde a los escenarios ejercitados, no a seguridad exhaustiva ni aprobación humana.

**Compatibilidad con otros componentes:** preservar `/orders`, planificación ADMIN, ejecución DRIVER y `Order.total` histórico. Regresión completa de 32 suites aprobada en el reemplazo controlado, sin cambios de dependencias. Entrega/acuerdo con frontend #20 y revisión humana todavía no realizados.

**Limitaciones conocidas:** PDF no obligatorio y no implementado; sin API ADMIN transversal sobre rutas CLIENT. Imágenes históricas ausentes se representan como `null`. La cobertura global local y los gates técnicos fueron observados; no se afirma CI remoto verde, acuerdo frontend, revisión humana ni merge-ready.

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

## Observaciones para el revisor

Priorizar ownership/IDOR, ausencia de datos de pago sensibles, importes congelados y procedencia de los eventos logísticos. Estado actual: recuperación y regresión completa verificadas. El primer aislamiento del verificador enlazaba `node_modules` compartido; pnpm lo modificó y afectó controles concurrentes. El reemplazo autorizado pasó con protección contra auto-install y hashes sin cambios. La ejecución independiente de reemplazo aprobó 20/20 casos con copia física y almacén privado. El intento normal de commit falló porque GGA no encuentra `AGENTS.md`. El usuario autorizó omitir hooks/GGA sólo en los dos commits locales de #34; se utilizó `git -c core.hooksPath=/dev/null commit`, sin modificar el hook, `.gga` ni la configuración permanente. No se presenta GGA como aprobado. No se afirma aprobación humana, acuerdo frontend ni CI remoto. Push, creación del PR, etiquetas protegidas y merge no ejecutados.


Evaluación nativa `assess`: no pudo formar candidato por archivos sin seguimiento que requieren declaración, incluso solicitando rango comprometido. RDD permanece desactivado. Se siguió su plan de riesgo alto (item 2) con auto-verificación, revisión GPT independiente y ejecución aislada aprobadas; no se inició otro ciclo de revisión ni se incluyeron archivos ajenos para resolver el aviso.

Carga de revisión: el commit funcional contiene 17 archivos y 2.807 líneas añadidas/eliminadas, principalmente módulo nuevo, DTOs y pruebas/fixtures. Se conserva como una unidad funcional coherente; no se separaron pruebas de comportamiento ni se redujo el código artificialmente para cumplir una guía de tamaño.
