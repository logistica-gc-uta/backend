# Despliegue del Backend en `stephserver` (Coolify + Cloudflare Tunnel + OSRM)

Guía operativa para desplegar el backend con Docker Compose en Coolify sobre `stephserver`, alineada con la validación de configuración de producción (`src/config/runtime-config.ts`, Issue #53) y la guía base [`docs/issue-53-production-config.md`](./issue-53-production-config.md).

## 1. Arquitectura de red y resiliencia

- **Exposición sin puertos públicos (CGNAT):** `postgres` y `osrm` no publican puertos en el host; se comunican únicamente por la red interna de Docker Compose. `backend` expone el puerto interno `3000` (`expose: ["3000"]`) hacia el proxy de Coolify o hacia `cloudflared` (Cloudflare Tunnel bajo el dominio asignado, p. ej. `sjproyects.me`).
- **Base de imagen Debian slim (`node:26-bookworm-slim`):** obligatoria por la API `Temporal` que requiere Prisma 8 en Node 26 y compatibilidad nativa glibc de `sharp` (evitar Alpine).
- **Resiliencia ante cortes de energía:** todos los servicios definen `restart: unless-stopped` y `HEALTHCHECK` HTTP en `GET /api/v1/health` (consulta real a PostgreSQL con timeout acotado de 3 s; responde `200 { "status": "ok", "database": "up" }` o `503 { "status": "error", "database": "down" }` sin exponer credenciales ni trazas).

## 2. Artefactos incluidos

| Archivo | Propósito |
|---|---|
| [`Dockerfile`](../Dockerfile) | Construcción multi-stage (`base`, `deps`, `builder`, `migrations`, `prod-deps`, `production`) con `pnpm@12.4.1`, usuario no-root `node` y `HEALTHCHECK` sobre `/api/v1/health`. |
| [`.dockerignore`](../.dockerignore) | Excluye `.env*`, `.git`, `node_modules`, `dist`, pruebas, reportes, `osrm-data`, `odd/`, `design/` y directorios de agentes del contexto de build. |
| [`docker-compose.coolify.yml`](../docker-compose.coolify.yml) | Stack de despliegue (`postgres`, `backend` y servicio opt-in `osrm` bajo el perfil `road`). Falla cerrado si faltan variables obligatorias. |

## 3. Variables de entorno en Coolify (sin valores de ejemplo reales)

Configurar todas las variables como secretos/entorno protegidos dentro del recurso Docker Compose en Coolify. Nunca reutilizar la contraseña de desarrollo local (`docker-compose.yml`).

### Base de datos y seguridad (obligatorias en `production` / `demo`)

| Variable | Uso |
|---|---|
| `POSTGRES_USER` | Usuario dedicado para la base de PostgreSQL de la aplicación. |
| `POSTGRES_PASSWORD` | Contraseña aleatoria generada en gestor de secretos. |
| `POSTGRES_DB` | Nombre de la base de datos de producción/demo. |
| `DATABASE_URL` | `postgresql://<POSTGRES_USER>:<POSTGRES_PASSWORD>@postgres:5432/<POSTGRES_DB>?sslmode=disable` (dentro de la red interna de Docker; usar `sslmode=require` si apunta a una BD externa). |
| `NODE_ENV` | `production` (o `demo` solo para entorno de demostración). |
| `PORT` | `3000`. |
| `JWT_SECRET` | Secreto aleatorio de al menos 32 caracteres (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`). |
| `JWT_EXPIRES_IN` | Vigencia de tokens JWT (por defecto `24h`). |
| `CORS_ALLOWED_ORIGINS` | Lista separada por comas de orígenes HTTPS exactos del frontend web (sin comodines ni rutas). |
| `REALTIME_ALLOWED_ORIGINS` | Lista separada por comas para Socket.IO; mantener exactamente alineada con `CORS_ALLOWED_ORIGINS`. |
| `SWAGGER_ENABLED` | `false` en producción (`true` solo si se autoriza explícitamente publicar `/api/docs`). |
| `SIMULATED_PAYMENTS_ENABLED` | `false` en producción (el simulador de pagos solo se habilita si `NODE_ENV=demo|test` y `SIMULATED_PAYMENTS_ENABLED=true`). |

### Integraciones opcionales

| Variable | Uso |
|---|---|
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Requeridas si se habilita carga de imágenes de productos en catálogo. |
| `COMPOSE_PROFILES` | Definir `road` únicamente después de preparar los datos OSRM en el host. |
| `ROAD_ENGINE`, `OSRM_BASE_URL` | `OSRM` y `http://osrm:5000` cuando el perfil `road` está activo. |
| `OSRM_DATA_DIR`, `OSRM_REGION_FILE`, `OSRM_MEM_LIMIT` | Ruta en host con `.osrm*` (p. ej. `/opt/regalia/osrm-data`), prefijo `ecuador-latest` y límite `2g`. |

## 4. Preparación previa de OSRM en el host (opcional)

Seguir [`docs/osrm/README.md`](./osrm/README.md) en `stephserver` antes de activar `COMPOSE_PROFILES=road`:

1. Preparar `/opt/regalia/osrm-data` con permisos de lectura para Docker y procesar `ecuador-latest.osm.pbf` (`osrm-extract`, `osrm-partition`, `osrm-customize`).
2. Verificar en `docker-compose.coolify.yml` que el volumen se monta como solo lectura (`:ro`) y con `mem_limit: 2g`.

## 5. Migraciones Prisma 8 y carga inicial

La imagen de runtime (`production`) excluye `devDependencies` (`prisma`, `tsx`) y archivos de migración. Para inicializar, migrar o verificar el esquema contra la red del stack en Coolify, usar el target `migrations`:

```bash
# Construir imagen de migraciones
docker build --target migrations -t regalia-backend-migrations .

# Solo en una base completamente vacía (revisar el snapshot objetivo en migrations/snapshots/):
docker run --rm --network <red_compose_coolify> \
  -e DATABASE_URL="$DATABASE_URL" \
  regalia-backend-migrations \
  pnpm prisma db migrate --db "$DATABASE_URL" --to defd240814f2524f7af9bf379253487edc9887ac231ea845a81baa9c7f768009

# Verificar consistencia del contrato contra la base desplegada:
docker run --rm --network <red_compose_coolify> \
  -e DATABASE_URL="$DATABASE_URL" \
  regalia-backend-migrations \
  pnpm prisma db verify --db "$DATABASE_URL"
```

> Hacer un respaldo lógico (`pg_dump`) antes de aplicar cualquier migración nueva. Si se requiere seed inicial en un entorno limpio de demo, ejecutar `pnpm run seed` usando el mismo target `migrations`.

## 6. Verificación posterior al arranque y respaldos

1. **Salud del servicio:** confirmar internamente `GET http://backend:3000/api/v1/health` → HTTP `200` `{"status":"ok","database":"up"}`, y externamente vía el subdominio de Cloudflare Tunnel sin publicar Swagger (`SWAGGER_ENABLED=false` debe devolver `404` en `/api/docs`).
2. **Integración con respaldo diario de `stephserver`:** añadir el volcado lógico de PostgreSQL (`docker exec <postgres-container> pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"`) a la rutina previa al respaldo diario `restic` (`/usr/local/bin/stephserver-backup.sh`, cron `04:00`) y probar periódicamente una restauración con `pg_restore` en una base aislada.
