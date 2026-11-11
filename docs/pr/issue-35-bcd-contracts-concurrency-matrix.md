## Descripción

Segunda parte de #35 (apilada sobre el PR del seeder de 200 regalos): pruebas de contrato y de concurrencia sobre PostgreSQL real para los casos de la matriz CI-SHOP-001 §15 que no tenían cobertura de punta a punta, y la matriz de evidencia con resultados ejecutados.

## Issue relacionado

Refs #35

## Cambios realizados

- `shop-contract-matrix-v12`: catálogo público de 200 regalos (CT-001..005), permisos y datos manipulados (CT-007, 013), reversión total y límites (CT-016, 037) y ajustes versionados del ADMIN (CT-035, 036, 038, 040, 041).
- `shop-concurrency-matrix-v12`: 12 compradores por 5 unidades, 10 compras contra la tarjeta limitada, 8 reintentos con la misma clave, y cambios de precio y de ajustes mientras la compra espera un bloqueo.
- Validación del OpenAPI candidato: `shop-openapi-document.spec.ts` (documento válido y coherente) y `shop-openapi-contract.e2e-spec.ts` (las respuestas reales cumplen los esquemas). Nuevas dependencias de desarrollo: `yaml` y `ajv`. Hallazgo D-4: `GET /shop/orders` devuelve `primaryProductId`, que el contrato no declara.
- Subcasos que faltaban: CT-009 (fecha que vence durante la espera de un bloqueo), CT-040 (cambio de horario seguido de compra) y CT-042 (auditoría de importes con más de dos decimales y rollback).
- Matriz de evidencia CT-001..043 con PASS / PASS (parcial) / BLOCKED en `docs/issue-35-evidence-matrix.md`.
- Correcciones de las pruebas existentes: fechas de entrega fijas de 2026-11-15 (fallarían desde esa fecha) y el conteo de suites e2e en `ci-security.spec.ts`.

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | PASS | `pnpm lint`, `tsc --noEmit` |
| Pruebas unitarias | PASS en CI; en Windows 41 fallos preexistentes | cobertura líneas 89,3 % · ramas 80,3 % |
| Pruebas de integración | 517/520 PASS | e2e autónomos con PostgreSQL 16 real, tras reintegrar sobre `main`. Las 3 fallas son de `realtime.e2e-spec` (ajena a #35), que pasa 9/9 al repetirla sola; ver H-4 de la matriz |
| Compilación | PASS | `nest build` |
| Pruebas funcionales | PASS | 37 CT PASS, 3 parciales, 3 BLOCKED, 0 FAIL |

## Evidencias

`docs/issue-35-evidence-matrix.md`. El resultado en GitHub Actions se adjunta al correr el CI.

## Impacto técnico

**API / Contratos:** sin cambios en la API; se agrega validación contra `docs/REGALIA-SHOP-OPENAPI-v1.2.yaml`.

**Base de datos / Migraciones:** sin cambios. Dependencias de desarrollo nuevas: `yaml` y `ajv`.

**Seguridad y permisos:** sin cambios; las pruebas no usan credenciales reales.

**Compatibilidad con otros componentes:** CT-028 y CT-031 dependen de Flutter y React y quedan BLOCKED.

**Limitaciones conocidas:** los CP-SHOP-001..034 no se mapearon porque su definición no está en el repositorio; D-4 queda abierto (`it.failing`) hasta que backend alinee el contrato; las secciones de compra ADMIN, cobertura, rutas con motor vial, retiro y pérdida de la guía dependen de los issues #41–#52 y no se declaran aprobadas.

## Checklist de entrega

- [x] Cumplí los criterios de aceptación del Issue (partes B, C y matriz; D parcial: sin Flutter/React).
- [x] Implementé únicamente los cambios necesarios.
- [x] Ejecuté las pruebas correspondientes.
- [x] Verifiqué que el código compile correctamente.
- [x] Comprobé los posibles errores y excepciones.
- [x] Actualicé la documentación cuando fue necesario.
- [x] No incluí credenciales ni información sensible.
- [x] Adjunté evidencia de los resultados.
- [ ] Solicité revisión a otro integrante.

## Observaciones para el revisor

Revisar D-1 (fechas fijas): se movieron a 2030; lo ideal es generarlas dinámicamente. El PR depende del PR de #35-A (seeder), que sus pruebas reutilizan.
