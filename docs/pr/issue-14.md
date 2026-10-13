## Descripción

Agrega un experimento independiente y reproducible que compara la heurística de Clarke & Wright con una línea base de viajes independientes, usando la misma distancia Haversine para ambas. Genera datasets de 4 a 2 000 pedidos, verifica las invariantes de cada propuesta, prueba 12 casos de borde y publica los resultados (CSV/JSON) y un informe técnico para la sustentación.

## Issue relacionado

Closes #14

## Cambios realizados

- `pnpm run benchmark:routing` (`--quick`, `--out`, `--runs`, `--sizes`, `--seeds`): corre el experimento completo en ~1-2 minutos y termina con código 1 si falla alguna invariante o caso de borde.
- Datasets con semilla (`uniform` y `clustered`) de 4, 5, 20, 100, 500 y 2 000 pedidos, 3 semillas por tamaño.
- Métricas: km de la línea base y de las rutas propuestas, ahorro %, número de rutas, utilización, tiempo (mediana/mín./máx.), memoria, semillas y parámetros. El ahorro nunca divide entre 0.
- Verificación independiente por dataset: sin duplicados, máximo 4 paradas, sin mezclar zona ni fecha, distancia informada igual al recálculo, resultado repetible e independiente del orden de entrada.
- 12 casos de borde con resultado esperado (sin pedidos, coordenadas duplicadas, capacidad 4/5, zonas y fechas distintas, zona sin depósito, línea base de 0 km, etc.).
- Extra: brecha frente a la solución exacta (programación dinámica, validada contra fuerza bruta) solo para instancias de hasta 10 pedidos.
- `deterministicChecksum` (SHA-256 de lo que no depende de la máquina) y una prueba que lo compara con una referencia para detectar cambios accidentales.
- `pnpm run lint` ahora también analiza `benchmarks/`.
- Informe `docs/benchmark-routing.md` y corrida de referencia en `docs/benchmarks/` (JSON y 3 CSV).

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | Aprobado | `pnpm run lint` (ahora incluye `benchmarks/`): sin avisos nuevos; queda 1 aviso previo en `test/route-start.e2e-spec.ts:217` |
| Pruebas unitarias | Aprobado | 46 pruebas nuevas en verde, una suite por módulo (generador, datasets, métricas, invariantes, solver exacto contra fuerza bruta, runner, casos de borde, brecha exacta, checksum, salida CSV/JSON y checksum de referencia) |
| Pruebas de integración | N/A | El experimento no usa base de datos ni API: llama directamente a `planRoutes()` |
| Compilación | Aprobado | `pnpm run build`, exit 0 |
| Pruebas funcionales | Aprobado | Corrida completa: 36 datasets sin violaciones, 12/12 casos de borde, checksum `ccb8d6bd…83ff1d` idéntico en dos corridas y con Node 26.10.0 y 26.11.1 |

Suite completa local (Windows, Node 26, Docker encendido): 571 de 609 pruebas, cobertura global 90,8 % (el CI exige 80 %). Los 38 fallos son de tres suites que dependen de `/bin/bash`, permisos `0600`, symlinks y de la resolución de TypeScript en Linux: `test/geolocation-migration.fixtures.spec.ts`, `test/run-newman-isolated.spec.ts` y `test/prisma-legacy-rawsql-compat.spec.ts` (esta última falla igual sobre `origin/main` sin estos cambios). El CI de `main` está en verde (último push, `c740ad4`); el resultado de este PR queda a cargo de su CI.

## Evidencias

Informe con metodología, resultados y límites en [`docs/benchmark-routing.md`](../benchmark-routing.md). Artefactos de la corrida de referencia en [`docs/benchmarks/`](../benchmarks) (JSON compacto de 113 líneas, 3 CSV y la salida de consola `routing-benchmark-console.txt`). Resultado resumido para 2 000 pedidos: ahorro de ~73,6 % frente a la línea base, 500 rutas llenas y ~1,2 s de cálculo. Para 8-10 pedidos la heurística queda en promedio a 1-2 % de la solución exacta.

## Impacto técnico

**API / Contratos:** Sin cambios.

**Base de datos / Migraciones:** Sin cambios.

**Seguridad y permisos:** Sin datos reales ni secretos. Usa coordenadas DEMO/TEST generadas con semilla.

**Compatibilidad con otros componentes:** Código nuevo en `benchmarks/` (fuera de `src/`, no entra al build ni a la cobertura del backend). Nuevo script `benchmark:routing` y `lint` ampliado a `benchmarks/`. Para Kerly: la API ya devuelve `totalDistanceKm` y `distanceMethod` por propuesta; la línea base y el ahorro no están en la API y se pueden añadir al `summary` si la interfaz los necesita. Para Saimol: la distancia estimada ya se retorna como `totalDistanceKm`.

**Limitaciones conocidas:**
- Haversine es distancia en línea recta, sin calles, tráfico ni tiempos de viaje.
- Es una heurística: no garantiza el óptimo. La brecha solo se midió hasta 10 pedidos; para 20 o más no hay referencia exacta y no se afirma ninguna.
- La línea base es deliberadamente simple, por lo que el ahorro no equivale al ahorro frente a una operación real.
- Datos sintéticos de un depósito, una zona y una fecha; tiempo y memoria dependen de la máquina y se excluyen del checksum.
- Falta confirmar el mapeo contra RF-DEC-03/04, RNF-DEC-07 y CP-GEO-003, CP-RUT-002/011 en los documentos del Drive.

## Checklist de entrega

- [ ] Cumplí los criterios de aceptación del Issue (queda por confirmar «CI satisfactoria» y la revisión cruzada en este PR).
- [x] Implementé únicamente los cambios necesarios.
- [x] Ejecuté las pruebas correspondientes.
- [x] Verifiqué que el código compile correctamente.
