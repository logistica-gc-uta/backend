# Benchmark reproducible: Haversine + Clarke & Wright frente a una línea base (#14)

Experimento independiente que mide cuánta distancia ahorra la heurística de Clarke & Wright ([clarke-wright.md](./clarke-wright.md)) respecto a hacer un viaje por pedido, con datasets reproducibles de 4 a 2 000 pedidos. No usa la base de datos ni la API: llama directamente a `planRoutes()`.

## Cómo ejecutarlo

Requiere Node 26 y `pnpm install` (ver README). Desde la raíz del backend:

```bash
pnpm run benchmark:routing            # corrida completa (~1-2 min), artefactos en reports/benchmark/
pnpm run benchmark:routing --quick    # corrida rápida (~3 s): tamaños 4, 5, 20 y 100
pnpm run benchmark:routing --out docs/benchmarks   # escribir en otra carpeta
```

Opciones: `--out <carpeta>`, `--runs <n>` (corridas cronometradas por dataset, 5 por defecto), `--sizes 4,5,20`, `--seeds 1,2,3`. El comando termina con código 1 si alguna invariante o caso de borde falla.

Artefactos generados (la corrida de referencia está publicada en [`docs/benchmarks/`](./benchmarks)):

| Archivo | Contenido |
| --- | --- |
| `routing-benchmark.json` | Todo: metadatos (comando, commit, Node, CPU, semillas, parámetros), resultados por dataset, casos de borde, brecha exacta y checksum |
| `routing-benchmark.csv` | Una fila por dataset: km, ahorro, rutas, utilización, tiempo, memoria, invariantes |
| `routing-edge-cases.csv` | Los 12 casos de borde con lo esperado y lo observado |
| `routing-optimality.csv` | Brecha frente a la solución exacta en instancias pequeñas |
| `routing-benchmark-console.txt` | Salida de consola de la corrida de referencia (sin rutas locales ni secretos) |

Las pruebas del propio experimento (46 pruebas, un `*.spec.ts` por módulo en `benchmarks/routing/`) corren con `pnpm test`.

## Diseño del experimento

**Datasets.** Un depósito (centro de Ambato, dato DEMO/TEST), una zona y una fecha, con 4, 5, 20, 100, 500 y 2 000 pedidos y 3 semillas por tamaño, en dos distribuciones:

- `uniform`: puntos uniformes en una caja de ±0,05° (~5,5 km) alrededor del depósito.
- `clustered`: ~1 clúster por cada 25 pedidos, con dispersión gaussiana de 0,004° (~440 m).

Las coordenadas se redondean a 6 decimales, como en la base de datos. Un generador pseudoaleatorio propio (mulberry32) hace que la misma semilla dé siempre los mismos pedidos.

**Línea base.** Un viaje independiente depósito → pedido → depósito por cada pedido. La línea base, la heurística y todas las verificaciones usan **la misma función de distancia** (`haversineKm`, radio terrestre 6 371 km), por lo que comparan exactamente las mismas distancias.

**Métricas por dataset.**

| Métrica | Definición |
| --- | --- |
| `baselineKm` | Suma de `2 × d(depósito, pedido)` de todos los pedidos |
| `plannedKm` | Suma de las distancias de las rutas propuestas (ida y vuelta al depósito) |
| `savingsKm`, `savingsPercent` | `baselineKm − plannedKm` y su porcentaje sobre la línea base. Si la línea base es 0 el ahorro es 0, nunca se divide entre 0 |
| `routes`, `minimumRoutes` | Rutas propuestas y mínimo teórico `⌈pedidos / 4⌉` |
| `utilization` | `pedidos / (rutas × 4)` |
| `averageStopsPerRoute` | `pedidos / rutas` |
| tiempo | Mediana, mínimo y máximo de las corridas cronometradas (promedio de repeticiones internas en tamaños pequeños) |
| `heapDeltaMb` | Memoria de heap reservada durante una corrida. Es **reserva, no memoria retenida**, y varía con el recolector de basura |

**Invariantes verificadas de forma independiente en cada dataset** (`verifyProposal`): cada pedido aparece exactamente una vez, ninguna ruta supera 4 paradas ni está vacía, ninguna ruta mezcla zona o fecha, y la distancia informada coincide con el recálculo desde las coordenadas. Además se comprueba que el resultado se repite al ejecutar de nuevo y que **no depende del orden de entrada**.

**Casos de borde** (12, cada uno con resultado esperado): sin pedidos, un pedido, coordenadas duplicadas, límite de capacidad con 4 y con 5 pedidos, 3 zonas × 2 fechas, zona sin depósito, pedidos en el depósito (línea base de 0 km), pedidos en lados opuestos del depósito, orden de entrada distinto, capacidad inválida y ids duplicados.

**Extra: brecha frente a la solución exacta.** Para instancias de hasta 10 pedidos se calcula el óptimo por programación dinámica sobre subconjuntos (validado en las pruebas contra fuerza bruta). Mide cuánto se aleja la heurística del mejor resultado posible **solo en esos tamaños**; no se extrapola a tamaños grandes.

## Resultados de referencia

Corrida completa generada sobre `main` (`aa17ba4`) con los cambios de este PR (Node 26, Windows x64, Intel Core i9-14900HX), 3 semillas por tamaño; los porcentajes son la media de las 3 semillas. Datos completos en [`docs/benchmarks/`](./benchmarks).

| Distribución | Pedidos | Ahorro medio (mín.–máx.) | Rutas | Utilización | Tiempo mediano | Heap reservado |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| uniform | 4 | 39,94 % (30,06–54,39) | 1 | 100 % | < 0,01 ms | ~0 MB |
| uniform | 5 | 42,45 % (37,78–46,99) | 2 | 62,5 % | < 0,01 ms | ~0 MB |
| uniform | 20 | 58,07 % (57,37–58,53) | 5–6 | 88,9 % | 0,03 ms | 0,1 MB |
| uniform | 100 | 68,62 % (68,52–68,77) | 25 | 100 % | 0,98 ms | 1,9 MB |
| uniform | 500 | 72,09 % (72,05–72,14) | 125 | 100 % | 44 ms | 17 MB |
| uniform | 2 000 | 73,56 % (73,54–73,58) | 500 | 100 % | 1,19 s | 215 MB |
| clustered | 4 | 71,85 % (71,47–72,34) | 1 | 100 % | < 0,01 ms | ~0 MB |
| clustered | 5 | 58,64 % (57,93–59,24) | 2 | 62,5 % | < 0,01 ms | ~0 MB |
| clustered | 20 | 72,41 % (71,06–73,10) | 5 | 100 % | 0,03 ms | 0,1 MB |
| clustered | 100 | 71,93 % (70,57–73,02) | 25–26 | 98,7 % | 0,96 ms | 2,0 MB |
| clustered | 500 | 72,96 % (72,91–73,00) | 125 | 100 % | 45 ms | 17 MB |
| clustered | 2 000 | 73,65 % (73,59–73,70) | 500 | 100 % | 1,15 s | 215 MB |

- Los 36 datasets cumplen todas las invariantes, se reproducen y no dependen del orden de entrada; los 12 casos de borde cumplen lo esperado.
- El pico de memoria del proceso (RSS) de toda la corrida fue de ~886 MB, incluyendo los datasets de 2 000 pedidos y la solución exacta.

**Brecha de la heurística frente a la solución exacta** (50 instancias por tamaño y distribución):

| Pedidos | uniform: brecha media / máx. / óptimas | clustered: brecha media / máx. / óptimas |
| ---: | --- | --- |
| 4 | 0,01 % / 0,59 % / 49 de 50 | 0,30 % / 7,65 % / 45 de 50 |
| 5 | 0,00 % / 0,00 % / 50 de 50 | 0,21 % / 4,80 % / 45 de 50 |
| 6 | 0,28 % / 5,64 % / 42 de 50 | 1,04 % / 7,38 % / 27 de 50 |
| 8 | 1,85 % / 14,22 % / 26 de 50 | 1,57 % / 8,47 % / 17 de 50 |
| 10 | 1,51 % / 9,86 % / 27 de 50 | 1,15 % / 7,94 % / 17 de 50 |

## Cómo leer los resultados

- **El ahorro grande es esperable por la línea base.** La línea base es deliberadamente simple (un viaje por pedido); cualquier agrupación razonable la supera. Con capacidad 4 y rutas llenas se evitan 3 de cada 4 viajes de ida y vuelta, por eso el ahorro se acerca al 75 % cuando los pedidos están agrupados (el caso EDGE-03, con 8 pedidos en el mismo punto, da exactamente 75 %). El número no equivale al ahorro frente a una operación real, que ya agrupa pedidos a mano.
- **Con pocos pedidos la heurística casi siempre es óptima**, y en instancias de 8 a 10 pedidos se aleja en promedio entre 1 % y 2 %, con casos puntuales de hasta ~14 %.
- **La utilización de 62,5 % con 5 pedidos** no es un defecto: 5 pedidos con capacidad 4 obligan a 2 rutas (4 + 1).
- **El tiempo crece de forma cuadrática** (44 ms con 500 pedidos, ~1,2 s con 2 000), coherente con el límite de 2 000 pedidos por zona de `GET /route-proposals`.

## Reproducibilidad

El campo `deterministicChecksum` es un SHA-256 de todo lo que **no** depende de la máquina: km, rutas, invariantes, casos de borde y brecha exacta, con 6 decimales. **El tiempo y la memoria se excluyen** a propósito, porque dependen del equipo.

Verificado en esta entrega: el checksum de la corrida completa (`ccb8d6bd…83ff1d`) es idéntico en dos corridas consecutivas, con Node 26.10.0 y con Node 26.11.1, y las métricas coinciden en los 36 datasets. El checksum también coincide tras dividir el código en módulos y en una corrida con el equipo limitado por la batería. Además, `benchmarks/routing/reference-checksum.spec.ts` compara la configuración rápida con un checksum de referencia, lo que protege contra cambios accidentales en el algoritmo, la distancia o los datasets, y se ejecuta en el CI de Linux.

Si un cambio legítimo altera los resultados, regenere la referencia con `pnpm run benchmark:routing --quick` y copie el checksum a esa prueba.

## Límites y riesgos conocidos

- **Haversine es distancia en línea recta.** No modela calles, sentidos, tráfico, cierres ni tiempos de viaje. Los km del informe no son kilómetros recorridos por carretera.
- **Es una heurística.** No garantiza el óptimo. La brecha solo se midió hasta 10 pedidos; para 20 o más **no hay referencia exacta**, así que no se afirma qué tan cerca del óptimo está.
- **Datos sintéticos.** Un solo depósito, una zona y una fecha por dataset, con coordenadas generadas, no pedidos reales. Los resultados dependen de la distribución elegida.
- **Tiempo y memoria son de esta máquina.** El heap es memoria reservada, no retenida, y el RSS es el pico del proceso completo. Los tiempos publicados se midieron con el equipo en reposo. Otras tareas en paralelo, o un portátil con batería y plan de energía equilibrado, los multiplican: con el mismo código, 2 000 pedidos tardaron entre 2,4 y 2,7 s en esas condiciones frente a ~1,2 s en reposo, con exactamente las mismas métricas deterministas.
- **Capacidad fija de 4**, sin ventanas horarias ni prioridades.

## Trazabilidad con el issue #14

| Criterio de aceptación | Evidencia |
| --- | --- |
| Experimento ejecutable con un comando documentado | `pnpm run benchmark:routing` (sección «Cómo ejecutarlo») |
| Métricas reproducibles; el ahorro no divide entre 0 | Checksum idéntico entre corridas y versiones de Node; `savingsPercent` devuelve 0 sin línea base (EDGE-01, EDGE-08 y pruebas unitarias) |
| Ninguna ruta supera 4 ni mezcla fecha/zona; sin duplicación | `verifyProposal` en los 36 datasets y EDGE-04/05/06/12 |
| Informe y evidencia aptos para sustentación | Este documento y `docs/benchmarks/` |

El issue referencia RF-DEC-03/04, RNF-DEC-07, CP-GEO-003 y CP-RUT-002/011 (Plan Maestro, SRS, PPF y Plan ISO 29119-3 del Drive del equipo). Este informe no reproduce su texto; el mapeo exacto de cada caso a esta evidencia debe confirmarse contra esos documentos.

## Coordinación con el resto del equipo

- **Kerly (interfaz):** `GET /route-proposals` ya devuelve por ruta `totalDistanceKm` y la nota `distanceMethod = HAVERSINE_STRAIGHT_LINE`. **No** devuelve la línea base ni el ahorro. Si la interfaz necesita mostrarlos, se pueden añadir al `summary` de la propuesta (`baselineKm`, `plannedKm`, `savingsPercent`) reutilizando las funciones de este benchmark; hay que acordarlo antes porque cambia el contrato de la API.
- **Saimol (backend):** la distancia estimada ya se entrega como `totalDistanceKm` (ida y vuelta, 3 decimales) y debe presentarse siempre como estimación en línea recta.
