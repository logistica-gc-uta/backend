# Issue #47 — Motor vial abierto (OSRM) y gestión de indisponibilidad

## Resumen

El planificador sigue siendo del backend REGALÍA (Clarke & Wright, capacidad de 4, reglas comerciales). OSRM solo entrega **distancias, duraciones estimadas y trazado por calles**. Con `ROAD_ENGINE=OSRM` las propuestas se calculan sobre la red vial; sin esa variable todo funciona como antes (línea recta). **Si el motor falla, la operación falla con un error tipado**: no hay respaldo silencioso a línea recta ni a otro motor.

## 1. Validación local con calles reales (antes de fijar la configuración)

Hecha el 12-nov-2026 en un equipo de desarrollo (Windows 11, Docker con 16 GB de RAM y 32 CPU). **No es una medición de producción**: sirve para decidir si el motor es viable y con qué configuración empezar.

| Elemento | Valor medido |
|---|---|
| Datos | `ecuador-latest.osm.pbf` de Geofabrik, 126 033 484 bytes (publicado el 11-nov-2026): 18 301 233 nodos, 1 993 844 vías, 2 960 restricciones |
| Motor | imagen `osrm/osrm-backend` (151 MB, `sha256:af5d4a83…ee409`), algoritmo MLD, perfil `car` |
| Preparación (una vez por actualización de mapas) | extract 57 s + partition 11 s + customize 5 s = **73 s**; pico de RAM durante el extract: 827 MB |
| Disco | ~1,1 GB de datos procesados (más los 126 MB del `.pbf`) |
| Servidor en marcha | ~540 MB de RAM al arrancar y ~880 MB tras la prueba; 0 % de CPU en reposo |
| Latencia de la matriz (5 repeticiones) | 25 puntos: p50 56 ms · 64 puntos: p50 128 ms · 100 puntos: p50 124 ms (máx. 142 ms) |
| Matriz grande por bloques | 200 puntos = 16 solicitudes de 50×50, concurrencia 4: **~0,5 s** |

Calidad de los datos en la zona de Ambato (cuadrícula de 100 puntos sobre la ciudad y su entorno, `benchmarks/osrm/validate.ts`):

| Observación | Resultado |
|---|---|
| Puntos a ≤ 100 m de una calle | 83 de 100 (el resto cae en zonas sin vías cercanas) |
| Tienda de demostración | se ajusta a la red a 19,8 m (calle «Galapagos») |
| Rodeo vial frente a la línea recta (129 pares a 0,6–1,5 km) | mediana **1,58×**; los mayores llegan a 11× |
| **Asimetría** | 2 125 de 3 403 pares difieren más de 200 m según el sentido (máx. 6,95 km): las distancias **no son simétricas** |
| Visita de 4 paradas | 12,48 km en línea recta frente a 23,9 km por la matriz (24,6 km por el servicio de ruta) |
| Punto sin conexión (océano) | el adaptador lo rechaza con `ROAD_POINT_OFF_NETWORK` |
| Motor inalcanzable | el adaptador responde `ROAD_ENGINE_UNAVAILABLE` (503) |

**Ejemplo del río/puente (evidencia con OSRM real, de punta a punta):** dos pedidos separados por un obstáculo a 1,0 km en línea recta (`-1.245,-78.606` y `-1.245,-78.597`). OSRM los une por **11,2 km** pasando por el Paso Lateral de Ambato. La propuesta real devolvió `totalDistanceKm = 20,915` frente a `straightLineKm = 4,521`, `totalDurationSeconds = 2170` (estimado, sin tráfico) y un trazado de 739 puntos con `distanceMethod = OSRM_ROAD_NETWORK`. No se verificó en el mapa si el obstáculo es el río, una quebrada o un sentido único; el trazado (`includeGeometry=true`) permite revisarlo. Resultado completo: `docs/osrm/validation-results.json`.

**Conclusión de viabilidad:** OSRM es viable en esta máquina con la región de Ecuador completa (< 1 GB de RAM en marcha y respuestas de ~0,1 s por 100 puntos). **No se midió** un servidor de producción, ni con carga concurrente de varios ADMIN, ni con un recorte menor (p. ej. solo Tungurahua) que reduciría la memoria. Gratuito en licencia no significa sin costo: hace falta alojarlo (memoria, disco, actualización de mapas).

### Diferencia entre la matriz y el trazado

`totalDistanceKm` y las duraciones salen de la **matriz**, tramo a tramo, y son lo que usa el planificador. El trazado del mapa sale del servicio de **ruta**, que conduce la visita como un solo viaje continuo con giros restringidos en cada parada. Por eso el trazado puede ser algo más largo que la suma de tramos (en la visita de prueba, +3 %, 728 m). Se muestran distintos a propósito: el mapa dibuja, el planificador mide.

## 2. Configuración (solo en el backend)

Los consumidores (web, Flutter) **no ven ni dependen** de la URL ni de credenciales: solo del contrato HTTP del backend.

| Variable | Defecto | Descripción |
|---|---|---|
| `ROAD_ENGINE` | (vacío) | `OSRM` activa el motor vial. Cualquier otro valor conserva la línea recta |
| `OSRM_BASE_URL` | — | URL de la instancia (obligatoria con `ROAD_ENGINE=OSRM`) |
| `OSRM_PROFILE` | `car` | Perfil de desplazamiento |
| `OSRM_TIMEOUT_MS` | 5000 | Tiempo máximo por solicitud al motor |
| `OSRM_MAX_POINTS` | 300 | Puntos máximos por propuesta (depósitos + destinos únicos) |
| `OSRM_TILE_SIZE` | 50 (máx. 50) | Bloque de la matriz; con `--max-table-size 100` del servidor |
| `OSRM_CONCURRENCY` | 4 | Solicitudes simultáneas al motor por matriz |
| `OSRM_MAX_SNAP_DISTANCE_M` | 500 | Un punto más lejos de la red se rechaza |

El servidor debe arrancar con `--max-table-size` ≥ 100 (ver `docs/osrm/README.md`). Se recomienda **no usar el servidor demo público** de OSRM como servicio de producción.

## 3. Contrato

### Qué recibe el planificador y qué recibe el mapa

| Consumidor | Recibe | Campos |
|---|---|---|
| Planificador (backend) | la matriz vial entre depósitos y destinos, **direccional**, en km | `distanceKm[i][j]`; agrupa con el promedio de ambos sentidos y mide/orienta cada visita con el sentido real |
| Mapa (web, `includeGeometry=true`) | el trazado por calles de cada propuesta | `geometry` (GeoJSON `LineString`, `[lng, lat]`, depósito → paradas → depósito) |
| ADMIN / paneles | distancias, duraciones estimadas y procedencia | ver abajo |

### `GET /api/v1/route-proposals?date=&zoneId=&includeGeometry=` (ADMIN)

Con el motor vial, **además** de los campos de siempre:

| Campo | Contenido |
|---|---|
| `distanceMethod` | `OSRM_ROAD_NETWORK` (o `HAVERSINE_STRAIGHT_LINE` sin motor) |
| `roadMetrics` | `{provider:'OSRM', profile, distanceUnit:'km', durationUnit:'s', directional:true, trafficAware:false, estimate:true, maxSnapDistanceM}` |
| `proposals[].totalDistanceKm` | distancia **vial** de la visita, medida en el sentido real de cada tramo |
| `proposals[].straightLineKm` | la misma visita en línea recta, para contrastar |
| `proposals[].totalDurationSeconds` | duración **estimada** (sin tráfico en vivo; no es una hora de llegada garantizada) |
| `proposals[].stops[].legDistanceKm / legDurationSeconds` | tramo desde el punto anterior (el depósito para la primera parada) |
| `proposals[].returnLegDistanceKm / returnLegDurationSeconds` | tramo de vuelta al depósito |
| `proposals[].geometry` | solo con `includeGeometry=true` |

`baselineKm`, el ahorro y el total diario usan las mismas distancias viales.

### `GET /api/v1/route-proposals/road-engine` (ADMIN)

Estado del motor: `{engine, configured, available, profile, latencyMs, checkedAt, message}`. Sirve para avisar al ADMIN antes de intentar planificar. No expone la URL.

### Urgencias (`GET /dispatch/orders/:id/proposal`)

Se miden también con el motor vial (`distanceMethod`). Si el motor falla, la urgencia queda **`BLOCKED`** con `reasons: ['ROAD_ENGINE_UNAVAILABLE']` (o el código que corresponda): no se propone una salida nueva con datos inexistentes y el pedido sigue pendiente.

### Errores (todos con el sobre `{statusCode, error, code, message, details}`)

| Código | HTTP | Cuándo | Qué se persiste |
|---|---|---|---|
| `ROAD_ENGINE_UNAVAILABLE` | 503 | no conecta, agota el tiempo o responde 5xx | nada |
| `ROAD_ENGINE_BAD_RESPONSE` | 502 | respuesta incompleta, no JSON o con valores inválidos | nada |
| `ROAD_ROUTE_NOT_FOUND` | 422 | algún par sin recorrido; `details.orderIds` nombra los pedidos | nada |
| `ROAD_POINT_OFF_NETWORK` | 422 | punto a más de `OSRM_MAX_SNAP_DISTANCE_M` de la red; `details.orderIds` | nada |
| `ROAD_MATRIX_TOO_LARGE` | 422 | más de `OSRM_MAX_POINTS` puntos (acota fecha o zona) | nada |

Una respuesta incompleta **nunca** se convierte en ceros. Las propuestas son de solo lectura: ante cualquier error los pedidos siguen `PENDING`, los borradores y rutas existentes no se tocan y no se genera ninguna ruta nueva.

## 4. Decisiones de diseño

| Tema | Decisión |
|---|---|
| Perfil | `car` (vehículo motorizado). Una moto o bicicleta pediría otro perfil y otros datos |
| Región de mapas | Ecuador completo (126 MB). Un recorte de Tungurahua con `osmium` reduciría memoria; no medido |
| Modalidad | contenedor `osrm-routed` junto al backend. **Decisión de alojamiento abierta** (misma máquina, otra VM o servicio): pendiente del líder |
| Asimetría | la matriz es direccional; la agrupación usa el promedio de ambos sentidos y la visita se mide y se orienta con el sentido real |
| Respuestas parciales | no se aceptan: ante una celda sin recorrido o una respuesta incompleta se falla la propuesta entera |
| Límite por propuesta | 300 puntos (la matriz de 300 puntos son 36 solicitudes por bloques). Una zona con 2000 pedidos **no** se puede planificar por calles todavía: hay que acotar o decidir otra estrategia |
| Caché y vigencia | **evaluado y no implementado**: una matriz de 100 puntos tarda ~0,12 s y la propuesta es de solo lectura; se reconsidera si se mide carga real |
| Control de solicitudes | tiempo máximo por solicitud, concurrencia limitada y límite de puntos; no hay cola ni reintentos |
| Respaldo | ninguno (fuera de alcance): si OSRM no responde, no se planifica |

## 5. Riesgos y limitaciones

- **No hay tráfico en vivo**: las duraciones son estimaciones del perfil, no una hora de llegada.
- Las propuestas de más de 300 puntos se rechazan con `ROAD_MATRIX_TOO_LARGE`; el reporte de rendimiento del #15 (2000 pedidos) corresponde al modo línea recta.
- Con el motor activo cada `GET /route-proposals` consulta a OSRM; el worker de planificación sigue fuera del hilo principal, pero la matriz se pide en el hilo principal (E/S asíncrona).
- La calidad depende de OpenStreetMap: 17 de 100 puntos de la cuadrícula quedaron a más de 100 m de una calle.
- Las actualizaciones de mapas exigen repetir extract/partition/customize (~73 s para Ecuador).
- Falta el trazado con `includeGeometry` en la propuesta confirmada (DRAFT): hoy solo está en la propuesta.

## 6. Pruebas

- Unitarias: `osrm.client.spec.ts` (cliente, bloques, errores, configuración), `road-planning.spec.ts` (matriz, algoritmo direccional, planificador, servicio vial y modo vial de las propuestas).
- E2E en PostgreSQL real con un OSRM **simulado** en loopback (`test/fake-osrm.ts`, no es un servicio de producción): `test/road-engine.e2e-spec.ts` (17 pruebas): estado del motor y permisos; procedencia, tramos y trazado; el ejemplo del río; y las fallas (503, 502, 422, tiempo agotado) sin cambios persistidos, con una ruta ya generada intacta, y urgencias bloqueadas.
- E2E con OSRM **real** (manual, no corre en CI): `test/road-engine-real.e2e-spec.ts` con `OSRM_REAL_URL=http://127.0.0.1:5001`.
- Validación del motor: `benchmarks/osrm/validate.ts` → `docs/osrm/validation-results.json`.
