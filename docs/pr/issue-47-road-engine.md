## Descripción

Integración del motor vial abierto OSRM para medir distancias, duraciones estimadas y trazado por calles en las propuestas de rutas, conservando el planificador y las reglas del backend. Con `ROAD_ENGINE=OSRM` las propuestas usan la red vial; si el motor falla, la operación falla con un error tipado y no se genera nada (sin respaldo silencioso a línea recta). Sin esa variable todo funciona como antes. Incluye la validación del motor con calles reales.

## Issue relacionado

Closes #47

## Cambios realizados

- Adaptador OSRM (`src/modules/routes/road/`): matriz de distancias y duraciones por bloques, trazado y comprobación de disponibilidad; unidades y procedencia explícitas; matriz **direccional** (no asume simetría); respuestas incompletas o pares sin recorrido nunca se convierten en cero.
- Planificador: Clarke & Wright acepta una matriz vial y distancias asimétricas (agrupa con el promedio de ambos sentidos y mide/orienta cada visita con el sentido real). La matriz viaja al worker y entra en la clave de caché. Sin matriz, el resultado es idéntico al anterior.
- `GET /route-proposals`: con el motor vial agrega `roadMetrics` (procedencia, `trafficAware: false`, `estimate: true`), distancia y duración por tramo, `straightLineKm` para contrastar y, con `includeGeometry=true`, el trazado para el mapa.
- `GET /route-proposals/road-engine` (ADMIN): estado del motor sin exponer la URL.
- Urgencias: se miden por calles; si el motor falla quedan `BLOCKED` con el código del error.
- Errores tipados: `ROAD_ENGINE_UNAVAILABLE` (503), `ROAD_ENGINE_BAD_RESPONSE` (502), `ROAD_ROUTE_NOT_FOUND`, `ROAD_POINT_OFF_NETWORK` y `ROAD_MATRIX_TOO_LARGE` (422), con los pedidos afectados.
- Configuración solo en el backend (`ROAD_ENGINE`, `OSRM_BASE_URL`, …); documentada en `.env.example`.
- `docker-compose.yml`: servicio `osrm` opt-in (perfil `road`), solo en loopback y con tope de memoria, según lo decidido por el líder: contenedor Docker en la VPS junto al backend (la VPS aún no existe: mientras tanto sirve cualquier máquina con Docker). `docker compose up` normal no lo arranca.
- Validación con OSRM real: `benchmarks/osrm/validate.ts`, resultados en `docs/osrm/validation-results.json`, runbook en `docs/osrm/README.md` y análisis en `docs/issue-47-road-engine.md`.

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | PASS | `pnpm lint`, `tsc --noEmit` |
| Pruebas unitarias | PASS (nuevas) | `osrm.client.spec.ts`, `road-planning.spec.ts` |
| Pruebas de integración | PASS (17 nuevas) | `test/road-engine.e2e-spec.ts` sobre PostgreSQL 16 real y un OSRM simulado en loopback |
| Validación con OSRM real | PASS (manual) | `test/road-engine-real.e2e-spec.ts` y `benchmarks/osrm/validate.ts`; no corre en el CI |
| Regresión | PASS | suites e2e de rutas, despacho, pedidos y Shop |
| Compilación | PASS | `pnpm build` |

Ejemplos del issue: dos pedidos a 1,0 km en línea recta pero separados por un obstáculo se unen con OSRM real por 11,2 km (propuesta: 20,9 km por calles frente a 4,5 km en línea recta). Con OSRM caído, incompleto o un par sin ruta, la respuesta es un error tipado, no se persiste nada, los pedidos siguen pendientes y las rutas ya generadas no se cancelan.

## Evidencias

`docs/issue-47-road-engine.md`: datos OSM, recursos medidos (preparación en 73 s, ~0,9 GB de RAM en marcha, 0,12 s por matriz de 100 puntos), asimetría de las calles (2 125 de 3 403 pares difieren más de 200 m) y decisiones.

## Impacto técnico

**API / Contratos:** campos opcionales nuevos en las propuestas (solo con el motor vial), parámetro `includeGeometry`, un endpoint de estado y los errores tipados; sin cambios cuando el motor vial está apagado. Hay que acordar el contrato con `frontend-web-logistica#37` (trazado) y con #48 (matriz).

**Base de datos / Migraciones:** sin cambios.

**Seguridad y permisos:** solo ADMIN; la URL y las credenciales del motor viven en el backend y no se exponen; el validador solo acepta instancias locales.

**Compatibilidad con otros componentes:** el motor vial está apagado por defecto. `ci-security.spec.ts` espera 39 suites e2e.

**Limitaciones conocidas:** no hay tráfico en vivo (las duraciones son estimadas); una propuesta de más de 300 puntos se rechaza (no se puede planificar por calles una zona de 2000 pedidos todavía); OSRM se aloja como contenedor Docker en la VPS (decisión del líder), pero la VPS aún no existe y no se probó en ella; el trazado puede ser ~3 % más largo que la suma de tramos de la matriz; no se midió carga concurrente ni un servidor de producción; no hay caché ni respaldo (fuera de alcance).

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

Alojamiento decidido por el líder: contenedor Docker en la VPS junto al backend (servicio `osrm` del compose, perfil `road`). Siguen pendientes de confirmar: que la VPS tenga ~1,5 GB de RAM y de disco libres, el perfil `car`, la región (Ecuador completo o un recorte), el límite de 300 puntos por propuesta, que la ausencia de respaldo sea definitiva para esta etapa y quién actualiza los mapas. Los mapas y datos procesados no se versionan.
