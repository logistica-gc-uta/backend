## Descripción

Escenarios reproducibles de volumen, carga y estrés con reporte no funcional: seeder de 100/500/2000 pedidos con semilla fija y limpieza verificable, plan JMeter en modo no GUI, monitor de recursos, orquestador aislado y generador del reporte con gráficos. Incluye la corrida real, sus hallazgos, la corrección del principal (P-1) y el re-test.

## Issue relacionado

Closes #15

## Cambios realizados

- `benchmarks/load/`: dataset puro (semilla fija, huella SHA-256), seeder idempotente y limpieza que verifica cero filas marcadas, plan JMeter (`api-load.jmx`), monitor de CPU/memoria de la API y PostgreSQL, etapas de carga (25/50/100/200) y estrés escalonado con límites seguros, orquestador aislado y generador de reporte (tablas + SVG).
- `docs/perf/REPORT.md`, gráficos y datos crudos de la corrida real y del experimento de control.
- Comandos `pnpm perf:seed | perf:cleanup | perf:status | perf:run | perf:report`.
- Se niega a correr si `DATABASE_URL` no es local; el orquestador solo usa una base desechable propia.
- **Corrección de P-1** (`src/modules/routes/route-planner.ts` y `algorithms/plan-routes.worker.ts`): Clarke & Wright corre en un worker thread cuando hay build compilado, se memoiza por contenido y las peticiones idénticas concurrentes comparten un solo cálculo. Misma API y mismos resultados; en tests y desarrollo calcula en línea.
- Re-test con el mismo plan: `docs/perf/REPORT.md` sección 10 y `docs/perf/retest/`.

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | PASS | `pnpm lint`, `tsc --noEmit` |
| Pruebas unitarias | PASS (33 + 8 nuevas del planificador; 23 suites de `routes` en verde) | percentiles, JTL, dataset, monitor, etapas, gráficos, reporte y planificador |
| Pruebas de integración | PASS (5 nuevas) | `test/perf-seed.e2e-spec.ts`: siembra, idempotencia, 2000 pedidos y limpieza en PostgreSQL real |
| Compilación | PASS | `pnpm build` |
| Pruebas de carga y estrés | Corrida real y re-test ejecutados | `docs/perf/REPORT.md` (commit `52dbc95`, 8 etapas) y sección 10 (re-test tras la corrección, 9 etapas): 0 % de errores, limpieza verificada |

## Evidencias

`docs/perf/REPORT.md`, `docs/perf/charts/*.svg` y `docs/perf/data/*.json` (sin tokens ni credenciales). Resultado clave: antes de la corrección el rendimiento se estancaba en ~14–17 req/s desde 25 usuarios (sin la propuesta de rutas, ~107 req/s en el experimento de control). Tras corregir P-1, el re-test da ~46–50 req/s y p95 ~3,5 veces menor, con 0 % de errores; el escalón de 400 usuarios ya corre.

## Impacto técnico

**API / Contratos:** sin cambios (`GET /route-proposals` devuelve lo mismo; solo cambia dónde se calcula).

**Base de datos / Migraciones:** sin cambios.

**Seguridad y permisos:** los tokens JWT se firman con un secreto aleatorio por corrida y viven solo en `test-results/` (ignorado). Los usuarios de prueba no tienen contraseña utilizable. No se toca el VPS ni datos reales.

**Compatibilidad con otros componentes:** `ci-security.spec.ts` ahora espera 33 suites e2e; se incluye el arreglo de `pnpm` en Windows de los fixtures de base propia.

**Limitaciones conocidas:** API, PostgreSQL y JMeter comparten una laptop; una corrida por escenario; la carga repite la misma fecha, así que el re-test se beneficia de la memoización y no aísla el costo del primer cálculo; la API sigue en ~1,1 núcleos (P-2 y P-3 siguen abiertos, solo se corrigió P-1).

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

JMeter no se versiona ni se instala con el script; el reporte indica la versión usada (5.6.3). Este PR toca código de producción (módulo `routes`) además de las pruebas; la corrección está aislada en el commit `53d6ed9`, por si el equipo prefiere separarla en otro PR. P-2 y P-3 siguen siendo decisiones para el equipo de backend.
