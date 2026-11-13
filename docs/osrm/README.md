# OSRM local para el issue #47

Guía para levantar el motor vial y validarlo. El líder decidió alojarlo como **contenedor Docker en la VPS del backend** (sección 7); los pasos 1 a 6 sirven igual en una máquina de desarrollo. La VPS no se ha probado: comprueba antes sus recursos (ver `docs/issue-47-road-engine.md`).

> Los mapas (`.osm.pbf`) y los datos procesados (`.osrm*`, ~1,1 GB) **no se versionan**: guárdalos fuera del repositorio.

## 1. Descargas (autorizar antes de ejecutar)

| Recurso | Fuente | Tamaño |
|---|---|---|
| Mapa de Ecuador | `https://download.geofabrik.de/south-america/ecuador-latest.osm.pbf` (datos abiertos de OpenStreetMap, ODbL) | 126 MB |
| Imagen del motor | `docker pull osrm/osrm-backend` | 151 MB |

## 2. Preparar los datos (una vez por actualización de mapas)

Con `DATA` apuntando a una carpeta fuera del repositorio que contiene `ecuador-latest.osm.pbf`:

```bash
docker run --rm -v "$DATA:/data" osrm/osrm-backend osrm-extract -p /opt/car.lua /data/ecuador-latest.osm.pbf
docker run --rm -v "$DATA:/data" osrm/osrm-backend osrm-partition /data/ecuador-latest.osrm
docker run --rm -v "$DATA:/data" osrm/osrm-backend osrm-customize /data/ecuador-latest.osrm
```

Medido: 57 s + 11 s + 5 s, pico de 827 MB de RAM durante el extract.

## 3. Levantar el servidor (solo en loopback)

```bash
docker run -d --name regalia-osrm -p 127.0.0.1:5001:5000 -v "$DATA:/data" \
  osrm/osrm-backend osrm-routed --algorithm mld --max-table-size 100 /data/ecuador-latest.osrm
```

`--max-table-size 100` es el límite de coordenadas por solicitud; el backend pide matrices grandes por bloques de 50×50 (`OSRM_TILE_SIZE`).

## 4. Usarlo desde el backend

```bash
ROAD_ENGINE=OSRM OSRM_BASE_URL=http://127.0.0.1:5001 pnpm start:dev
```

Comprobación: `GET /api/v1/route-proposals/road-engine` (ADMIN).

## 5. Validar

```bash
OSRM_BASE_URL=http://127.0.0.1:5001 pnpm tsx benchmarks/osrm/validate.ts docs/osrm/validation-results.json
OSRM_REAL_URL=http://127.0.0.1:5001 pnpm test:e2e -- test/road-engine-real
```

El script rechaza cualquier URL que no sea `127.0.0.1` o `localhost`: nunca se valida contra un servicio público.

## 6. Apagar

```bash
docker rm -f regalia-osrm
```

## 7. En la VPS (contenedor Docker junto al backend)

El servicio `osrm` está en `docker-compose.yml` bajo el perfil opt-in `road`: `docker compose up` normal NO lo arranca.

1. Comprueba en la VPS al menos ~1,5 GB de RAM libres y ~1,5 GB de disco (medidos con Ecuador completo; no se midieron en la VPS).
2. Descarga el mapa y prepara los datos (pasos 1 y 2) en una carpeta fuera del repositorio, por ejemplo `/opt/regalia/osrm-data`.
3. Arranca el motor (solo escucha en loopback y tiene tope de memoria):

   ```bash
   OSRM_DATA_DIR=/opt/regalia/osrm-data docker compose --profile road up -d osrm
   ```

   Variables opcionales: `OSRM_PORT` (5001), `OSRM_REGION_FILE` (`ecuador-latest`), `OSRM_MEM_LIMIT` (`2g`).
4. Configura el backend en su `.env` (el motor sigue apagado hasta este paso):

   ```bash
   ROAD_ENGINE=OSRM
   OSRM_BASE_URL=http://127.0.0.1:5001   # o http://osrm:5000 si el backend corre en la misma red de Docker
   ```

5. Comprueba con `GET /api/v1/route-proposals/road-engine` (ADMIN): debe decir `available: true`.
6. Para apagarlo: quita `ROAD_ENGINE` del `.env` y `docker compose --profile road stop osrm`. Las propuestas vuelven a la línea recta.

**Actualizar mapas:** repite los pasos 1 y 2 con el archivo nuevo y reinicia con `docker compose --profile road restart osrm`. Mientras el motor se reinicia, las propuestas fallan con `ROAD_ENGINE_UNAVAILABLE`; no hay respaldo.
