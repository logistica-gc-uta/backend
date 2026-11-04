## Descripción

Escenarios reproducibles de volumen, carga y estrés con reporte no funcional: seeder de 100/500/2000 pedidos con semilla fija y limpieza verificable, plan JMeter en modo no GUI, monitor de recursos, orquestador aislado y generador del reporte con gráficos. Incluye la corrida real y sus hallazgos.

## Issue relacionado

Closes #15

## Cambios realizados

- `benchmarks/load/`: dataset puro (semilla fija, huella SHA-256), seeder idempotente y limpieza que verifica cero filas marcadas, plan JMeter (`api-load.jmx`), monitor de CPU/memoria de la API y PostgreSQL, etapas de carga (25/50/100/200) y estrés escalonado con límites seguros, orquestador aislado y generador de reporte (tablas + SVG).
- `docs/perf/REPORT.md`, gráficos y datos crudos de la corrida real y del experimento de control.
- Comandos `pnpm perf:seed | perf:cleanup | perf:status | perf:run | perf:report`.
- Se niega a correr si `DATABASE_URL` no es local; el orquestador solo usa una base desechable propia.

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | PASS | `pnpm lint`, `tsc --noEmit` |
| Pruebas unitarias | PASS (33 nuevas) | percentiles, JTL, dataset, monitor, etapas, gráficos y reporte |
| Pruebas de integración | PASS (5 nuevas) | `test/perf-seed.e2e-spec.ts`: siembra, idempotencia, 2000 pedidos y limpieza en PostgreSQL real |
| Compilación | PASS | `pnpm build` |
| Pruebas funcionales | Corrida real ejecutada | `docs/perf/REPORT.md` (commit `52dbc95`): 8 etapas, 0 % de errores, limpieza verificada |

## Evidencias

`docs/perf/REPORT.md`, `docs/perf/charts/*.svg` y `docs/perf/data/*.json` (sin tokens ni credenciales). Resultado clave: el rendimiento se estanca en ~14–17 req/s desde 25 usuarios; sin la propuesta de rutas sube a ~107 req/s (experimento de control).

## Impacto técnico

**API / Contratos:** sin cambios.

**Base de datos / Migraciones:** sin cambios.

**Seguridad y permisos:** los tokens JWT se firman con un secreto aleatorio por corrida y viven solo en `test-results/` (ignorado). Los usuarios de prueba no tienen contraseña utilizable. No se toca el VPS ni datos reales.

**Compatibilidad con otros componentes:** `ci-security.spec.ts` ahora espera 33 suites e2e; se incluye el arreglo de `pnpm` en Windows de los fixtures de base propia.

**Limitaciones conocidas:** API, PostgreSQL y JMeter comparten una laptop; una corrida por escenario; el escalón de 400 usuarios no corrió porque el límite seguro (p95 > 30 s) se activó en 300; no se aplicaron correcciones (solo recomendaciones), por lo que el re-test queda para cuando se apliquen.

## Checklist de entrega

- [x] Cumplí los criterios de aceptación del Issue.
- [x] Implementé únicamente los cambios necesarios.
- [x] Ejecuté las pruebas correspondientes.
- [x] Verifiqué que el código compile correctamente.
- [x] Comprobé los posibles errores y excepciones.
- [x] Actualicé la documentación cuando fue necesario.
- [x] No incluí credenciales ni información sensible.
- [x] Adjunté evidencia de los resultados.
- [ ] Solicité revisión a otro integrante.

## Observaciones para el revisor

JMeter no se versiona ni se instala con el script; el reporte indica la versión usada (5.6.3). Revisar la sección de hallazgos P-1..P-3: son las decisiones que conviene tomar con el equipo de backend.
