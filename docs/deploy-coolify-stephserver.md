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
| [`docker-compose.coolify.yml`](../docker-compose.coolify.yml) | Stack de despliegue (`postgres`, job one-shot `migrate`, `backend` y servicio opt-in `osrm` bajo el perfil `road`). Falla cerrado si faltan variables obligatorias o si falla la migración. |

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
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME` | Bootstrap opcional e idempotente del `ADMIN` inicial en producción (si `SEED_ADMIN_EMAIL` o `SEED_ADMIN_PASSWORD` están definidas, `migrate` ejecuta `pnpm run seed:prod` tras verificar las migraciones; `SEED_ADMIN_NAME` es opcional). |

## 4. Preparación previa de OSRM en el host (opcional)

Seguir [`docs/osrm/README.md`](./osrm/README.md) en `stephserver` antes de activar `COMPOSE_PROFILES=road`:

1. Preparar `/opt/regalia/osrm-data` con permisos de lectura para Docker y procesar `ecuador-latest.osm.pbf` (`osrm-extract`, `osrm-partition`, `osrm-customize`).
2. Verificar en `docker-compose.coolify.yml` que el volumen se monta como solo lectura (`:ro`) y con `mem_limit: 2g`.

## 5. Migraciones Prisma 8 y carga inicial

La imagen de runtime (`production`) excluye `devDependencies` (`prisma`, `tsx`) y archivos de migración. Para automatizar cada despliegue sin incluir Prisma CLI en producción, `docker-compose.coolify.yml` ejecuta el servicio one-shot **`migrate`** (target `migrations`, `restart: "no"`) **antes** de arrancar `backend`:

1. Espera a que `postgres` esté saludable (`condition: service_healthy`).
2. Ejecuta `pnpm prisma db migrate --db "$DATABASE_URL"` (idempotente: si la base está vacía aplica toda la cadena hasta el contrato emitido en `src/prisma/contract.json`; si ya está al día no realiza cambios) y `pnpm prisma db verify --db "$DATABASE_URL"`.
3. Si `SEED_ADMIN_EMAIL` o `SEED_ADMIN_PASSWORD` están definidas, ejecuta `pnpm run seed:prod` para crear **únicamente el `ADMIN` inicial** (el rol `CLIENT` se registra desde la app y `DRIVER` lo crea el `ADMIN` desde `POST /api/v1/drivers`). Es idempotente: si ya existe un `ADMIN`, no modifica usuarios ni contraseñas; si falta alguna de las dos variables o hay conflicto de rol, falla cerrado antes de arrancar `backend`. Tras el primer despliegue podés retirar `SEED_ADMIN_PASSWORD` de Coolify si lo preferís.
4. `backend` solo arranca si `migrate` termina con código `0` (`condition: service_completed_successfully`). Si la migración o el bootstrap fallan, el despliegue se detiene antes de levantar el backend nuevo.

> Hacer un respaldo lógico (`pg_dump`) antes de desplegar cambios de esquema sobre datos existentes. Para ejecutar el bootstrap de producción manualmente desde la terminal de `backend` en Coolify (sin datos falsos de demo):
>
> ```bash
> SEED_ADMIN_EMAIL="admin@tudominio.com" SEED_ADMIN_PASSWORD="<clave-segura>" node dist/prisma/seed-prod.js
> ```
>
> Si querés cargar datos de demostración completos en un entorno de pruebas/demo (zonas, productos y usuarios de prueba), usá el target `migrations`:

```bash
docker build --target migrations -t regalia-backend-migrations .

docker run --rm --network <red_compose_coolify> \
  -e DATABASE_URL="$DATABASE_URL" \
  regalia-backend-migrations \
  pnpm run seed
```

## 6. Verificación posterior al arranque y respaldos

1. **Salud del servicio:** confirmar internamente `GET http://backend:3000/api/v1/health` → HTTP `200` `{"status":"ok","database":"up"}`, y externamente vía el subdominio de Cloudflare Tunnel sin publicar Swagger (`SWAGGER_ENABLED=false` debe devolver `404` en `/api/docs`).
2. **Integración con respaldo diario de `stephserver`:** añadir el volcado lógico de PostgreSQL (`docker exec <postgres-container> pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"`) a la rutina previa al respaldo diario `restic` (`/usr/local/bin/stephserver-backup.sh`, cron `04:00`) y probar periódicamente una restauración con `pg_restore` en una base aislada.
