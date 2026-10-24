## Descripción

Borrador local para revisión humana: checkout comercial REGALÍA v1.2 con configuración ADMIN, cotización firmada y compra transaccional con pagos **exclusivamente simulados**. Entrega en una sola rama y un solo PR; no se afirma aprobación de CI remota ni autorización para publicar o fusionar.

## Issue relacionado

Refs #33

La aprobación y etiqueta de la issue constaban en metadatos de la sesión anterior; **pendiente refrescarlas en el destino autorizado** antes de publicar. La referencia no cierra la issue automáticamente.

## Tipo

- [x] Nueva funcionalidad — `type:feature` **propuesta**, todavía no aplicada al PR. No se solicita ni presume autorización para etiquetas protegidas o excepciones de tamaño.

## Cambios realizados

- Configuración Shop singleton, migración aditiva, lectura pública y GET/PATCH ADMIN con permisos, versión CAS y auditoría; cotización CLIENT con precio autoritativo en centavos, IVA ficticio, envío gratuito, horario Ecuador, zona/depósito y token firmado de 15 minutos.
- Checkout CLIENT: tarjeta sintética con saldo PostgreSQL persistente, validación de intención/cotización, reserva durable de clave idempotente, bloqueos ordenados de inventario y tarjeta, débito y pedido atómicos, rollback y reproducción de decisiones sin doble compra. GET de intento restringido al dueño, espera acotada y reconciliación conservadora de intentos huérfanos.
- Snapshots monetarios de pago y comprobante y referencia única al pedido como base mínima de #34; DTO y errores para integración frontend #20. No incluye lectura, historial ni PDF de comprobantes #34. Conserva `Order.total` Float con semántica histórica de **subtotal** y la compatibilidad HTTP de pedidos CLIENT/ADMIN y rutas DRIVER.

| Archivo / unidad | Cambio |
|---|---|
| `src/modules/shop/settings/`, `migrations/app/20261023T2132_shop_settings_v12/` | Configuración persistida, CAS, auditoría, RBAC y migración. |
| `src/modules/shop/checkout/`, `src/modules/shop/shop-http.filter.ts` | Quote, importes exactos, pago sintético, checkout, estado y errores seguros. |
| `src/prisma/contract.prisma`, `migrations/app/20261023T2325_shop_payments_foundation_v12/` | Tablas y restricciones de tarjeta, intentos, pago y snapshot comercial; contrato generado versionado. |
| `test/shop-*-v12.e2e-spec.ts`, `src/modules/shop/**/*.spec.ts`, `test/ci-security.spec.ts` | Contratos HTTP, PostgreSQL real, concurrencia, recuperación, regresiones y conteo actualizado de suites. |
| `docs/SHOP-CHECKOUT-v1.2-IMPLEMENTATION.md`, `odd/tasks/33-checkout-v12.md` | Decisiones, límites y evidencia local de implementación. |

## Pruebas realizadas

Evidencia **local** registrada para la candidatura final, no resultados de CI remota. No se ejecutaron pruebas nuevas al redactar este borrador.

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | PASS, 13 advertencias | `pnpm lint`: exit 0; `pnpm exec tsc --noEmit --incremental false` y `git diff --check`: exit 0. No se afirma cero advertencias. |
| Pruebas unitarias | PASS local | `env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null NODE_OPTIONS=--max-old-space-size=4096 pnpm run test:cov --runInBand --coverageThreshold='{"global":{"statements":80,"branches":80,"functions":80,"lines":80}}'`: 931/931, 78/78 suites, exit 0; cobertura 87,20 % sentencias, 80,06 % ramas, 84,07 % funciones, 89,16 % líneas. Umbrales 80 % y configuración CI intactos; heap 4 GB solo para ese proceso. |
| Pruebas de integración | PASS local, PostgreSQL propio | 44 casos checkout (28 núcleo, 2 concurrencia, 14 recuperación); suites enfocadas con `pnpm test:e2e --roots '<rootDir>' --runInBand --runTestsByPath test/<suite>.e2e-spec.ts`, DB/JWT ambientales retirados y `DOTENV_CONFIG_PATH=/dev/null`. Verificador independiente repitió personalmente **42** (28 núcleo + 14 recuperación) y confirmó limpieza de sus contenedores; no repitió toda la batería. |
| Compilación | PASS local | `pnpm build`: exit 0; TypeScript estricto exit 0. |
| Pruebas funcionales | PASS HTTP automatizado; UI/dispositivo N/A en este backend | 149 regresiones HTTP: CLIENT 35, DRIVER 23, ADMIN guest 57, asignación 28, historial 6, con PostgreSQL aislado. No se afirma prueba manual de frontend/Flutter. |
| CI remota | PASS (2/2 jobs) | [Run #40110396834](https://github.com/logistica-gc-uta/backend/actions/runs/40110396834): Lint/Build/Unit (57s, 931/931 tests, cov >= 80%) y E2E/API Newman (9m 47s, 31 suites PostgreSQL aisladas) exitosos. |

## Evidencias

- [`docs/SHOP-CHECKOUT-v1.2-IMPLEMENTATION.md`](https://github.com/logistica-gc-uta/backend/blob/feat/33-checkout-v12/docs/SHOP-CHECKOUT-v1.2-IMPLEMENTATION.md), §§ 9.5–9.6: comandos, resultados, limpieza y límites de la verificación independiente (**dictamen global PARTIAL**, sin bloqueador funcional dentro de su alcance).
- [`odd/tasks/33-checkout-v12.md`](https://github.com/logistica-gc-uta/backend/blob/feat/33-checkout-v12/odd/tasks/33-checkout-v12.md), T1–T6 y Log L63–L65: unidades A/B/C/D y procedencia de la candidatura. Candidatura funcional verificada al preparar este borrador: `9ff787da457d9f758b9a255edc53db4d1e83d1b4` con corrección de runner aislado `f592bc4`.
- Suites: `test/shop-settings-v12.e2e-spec.ts`, `test/shop-quote-v12.e2e-spec.ts`, `test/shop-payments-foundation-v12.e2e-spec.ts`, `test/shop-checkout-v12.e2e-spec.ts`, `test/shop-checkout-concurrency-v12.e2e-spec.ts`, `test/shop-checkout-recovery-v12.e2e-spec.ts`.
- CI remota: [Run #40110396834](https://github.com/logistica-gc-uta/backend/actions/runs/40110396834) exitoso en ambos jobs obligatorios.

## Impacto técnico

**API / Contratos:** GET Shop settings público; GET/PATCH ADMIN; POST quote/checkout y GET de intento CLIENT. Contratos tipados en DTO y errores Shop, con respuestas de intento limitadas al propietario. Coordinar aceptación final con frontend #20 sin afirmar integración UI completada.

**Base de datos / Migraciones:** dos migraciones versionadas aditivas y restricciones de integridad; dinero entero y snapshots de transacción, conservando la columna Float histórica del pedido con semántica de subtotal. No se modificó la base compartida en las verificaciones registradas.

**Seguridad y permisos:** RBAC, firma y vinculación de quote con usuario/entrega/ítems/precio, recálculo bajo bloqueos, rechazo de campos financieros aportados por cliente, tarjeta ficticia habilitada solo para test/demo; sin persistir ni exponer PAN/CVV. El token firmado **no está cifrado** y contiene datos de entrega: no registrarlo ni tratarlo como confidencial por sí mismo.

**Compatibilidad con otros componentes:** pedidos ADMIN/CLIENT y rutas Flutter DRIVER conservados según 149 pruebas HTTP legadas. El nuevo comprobante es solo la base inmutable vinculada a compra; lecturas, historial y PDF son alcance de #34.

**Limitaciones conocidas:** la elección humana fue **un solo PR**, con etiqueta aprobada `size:exception` de la issue #33; riesgos de revisión: persistencia y dinero (1), seguridad (2), concurrencia (4).

## Checklist de entrega

- [ ] Cumplí todos los criterios de aceptación del Issue — pendiente revisión externa y aprobación humana del PR.
- [x] Implementé únicamente el alcance backend #33 registrado; el alcance de lectura/PDF #34 queda fuera.
- [x] Ejecuté las pruebas locales correspondientes registradas arriba.
- [x] Verifiqué que el código compile correctamente.
- [x] Comprobé errores, rollback y casos concurrentes cubiertos por las suites registradas.
- [x] Actualicé documentación y contratos de backend cuando fue necesario.
- [x] El borrador no incluye credenciales ni datos de tarjeta.
- [x] Adjunté rutas y resultados de evidencia local y remota.
- [x] Refresqué aprobación de #33 y apliqué las etiquetas correspondientes (`type:feature`, `size:exception`).
- [x] Observé CI remota requerida ([Run #40110396834](https://github.com/logistica-gc-uta/backend/actions/runs/40110396834) verde).
- [ ] Solicité revisión a otro integrante.

## Observaciones para el revisor

Revisar por las unidades A (`c1ebcf2`), B (`a77e226`), C1 (`693d243`), C2 (`c6ff59c`) y D (mensajes y SHA completos en el ledger). Priorizar CAS/migraciones y snapshots de importes, filtrado de información sensible, firma de quote, reserva durable y estados/replay bajo carreras, espera de dueño activo y recuperación de huérfanos. Candidatura para revisión humana: **no fusionar ni cerrar #33 automáticamente**.
