# Sistema de Logística y Entrega de Pedidos — UTA 📦🚚

Backend modular de alto rendimiento para la gestión logística de despachos, pedidos, catálogo de productos y asignación de rutas de entrega, desarrollado para la asignatura de **Gestión, Pruebas e Implementación de Software** de la **Universidad Técnica de Ambato (UTA)**.

---

## 1. Tecnologías y Arquitectura

- **Framework:** [NestJS 12](https://nestjs.com/) (ESM-first, arquitectura modular, inyección de dependencias).
- **ORM / Base de Datos:** [Prisma 8](https://www.prisma.io/) (`@prisma/orm-postgres`) con PostgreSQL 16.
- **Autenticación & Autorización:** JWT con Passport (`@nestjs/jwt`, `passport-jwt`) y Guards por Roles (`ADMIN`, `DRIVER`, `CLIENT`).
- **Validación de Datos:** `class-validator` y `class-transformer` con `ValidationPipe` global.
- **Documentación Interactiva:** OpenAPI / Swagger (`@nestjs/swagger`) en `/api/docs`.
- **Linter & Análisis Estático:** [oxlint](https://oxc.rs/) con reglas type-aware.
- **Testing:** [Jest](https://jestjs.io/) con suites automatizadas y cobertura al 100% de reglas de negocio.
- **Contenedores:** Docker & Docker Compose.

```
src/
├── app.controller.ts
├── app.module.ts
├── database/
│   ├── prisma.module.ts          # Módulo global de acceso a datos
│   └── prisma.service.ts         # Servicio con bindings a lanes ORM y SQL de Prisma 8
├── modules/
│   ├── auth/                     # Registro, login JWT, JwtStrategy, RolesGuard
│   ├── zones/                    # Coberturas y zonas geográficas
│   ├── products/                 # Catálogo y control de inventario
│   ├── orders/                   # Creación atómica de pedidos y estados
│   └── routes/                   # Asignación de pedidos a rutas (Regla <= 4 pedidos)
├── prisma/
│   ├── contract.prisma           # Contrato de datos Prisma 8
│   ├── db.ts                     # Instancia del cliente PostgreSQL
│   └── seed.ts                   # Seeder de datos iniciales
└── main.ts                       # Bootstrap, prefijo /api/v1, Swagger y CORS
```

---

## 2. Reglas de Negocio Clave

1. **Restricción Crítica de Negocio (Máximo 4 pedidos por Ruta/Repartidor):**
   - Un repartidor o ruta **NO puede tener más de 4 pedidos asignados simultáneamente**.
   - Si se intenta asignar 5 o más pedidos en una sola petición (`POST /api/v1/routes/assign`), el sistema rechaza la operación inmediatamente arrojando un error `400 Bad Request`:
     ```json
     {
       "message": "No se pueden asignar más de 4 pedidos a una ruta/repartidor",
       "error": "Bad Request",
       "statusCode": 400
     }
     ```
2. **Disponibilidad del Repartidor:**
   - Solo se pueden asignar pedidos a repartidores que tengan `isAvailable: true`.
3. **Consistencia de Zona:**
   - Todos los pedidos asignados a una ruta deben pertenecer a la misma zona geográfica (`zoneId`).
4. **Ciclo de Vida de Pedidos:**
   - `PENDING`: Estado inicial al ser creado por el cliente (reserva inventario).
   - `ASSIGNED`: Asignado a una ruta por el Administrador.
   - `IN_TRANSIT`: El repartidor inicia el traslado hacia el destino.
   - `DELIVERED`: Entrega finalizada con éxito.
   - `CANCELLED`: Cancelación del pedido.

---

## 3. Requisitos Previos

Asegúrate de tener instaladas estas herramientas en tu entorno:
- **Node.js:** versión `>= 26` (el cliente Prisma 8 usa la API global `Temporal`, que solo viene incluida desde Node 26; con versiones anteriores el seed y las consultas con fechas fallan con `RUNTIME.TEMPORAL_UNAVAILABLE`).
- **pnpm:** versión `>= 12.0.0`.
- **Docker & Docker Compose:** para levantar PostgreSQL localmente.
- **Git:** para clonar el repositorio.

> El proyecto ya incluye el archivo `docker-compose.yml` con la configuración de la base de datos local. La URL de conexión debe coincidir exactamente con esos valores para que el backend pueda arrancar correctamente.

---

## 4. Instalación y Puesta en Marcha (Paso a Paso)

### Paso 1: Clonar el repositorio y entrar al directorio del backend
```bash
git clone <url-del-repositorio>
cd backend
```

Si ya clonaste el proyecto y te encuentras en la carpeta raíz del repositorio, solo usa:
```bash
cd backend
```

### Paso 2: Instalar dependencias con pnpm
```bash
pnpm install
```

### Paso 3: Configurar variables de entorno
Copia el archivo de ejemplo `.env.example` a `.env`:
```bash
cp .env.example .env
```
Asegúrate de que el contenido del archivo sea exactamente este:
```env
DATABASE_URL="postgresql://logistica_user:logistica_password123@localhost:5432/logistica_db?schema=public"
JWT_SECRET="uta_logistica_jwt_secret_key_2026_super_secure"
JWT_EXPIRES_IN="24h"
PORT=3000
```

Estos valores coinciden con la configuración definida en `docker-compose.yml`:
- Usuario: `logistica_user`
- Contraseña: `logistica_password123`
- Base de datos: `logistica_db`
- Puerto local: `5432`

### Paso 4: Levantar la base de datos PostgreSQL en Docker
```bash
docker compose up -d
```
> Verifica que el contenedor esté corriendo con `docker compose ps`.

### Paso 5: Inicializar la base de datos con Prisma 8
Este comando crea la estructura de datos según el contrato del proyecto y la marca como sincronizada:
```bash
pnpm prisma db init
```

### Paso 6: Ejecutar la semilla de datos iniciales (Seeder)
```bash
pnpm run seed
```
Este comando creará automáticamente los usuarios, choferes, zonas y productos necesarios para pruebas. Las coordenadas de depósitos son datos DEMO/TEST solo para zonas nuevas; no actualiza coordenadas de zonas existentes ni completa registros históricos.

### Paso 7: Iniciar el servidor en modo desarrollo
```bash
pnpm run start:dev
```
El backend estará escuchando en `http://localhost:3000/api/v1`.

### Paso 8: Abrir la documentación Swagger
Visita:
```text
http://localhost:3000/api/docs
```

---
---

## 5. Credenciales por Defecto (Seed)

| Rol | Nombre | Correo Electrónico | Contraseña | Detalles |
| :--- | :--- | :--- | :--- | :--- |
| `ADMIN` | Administrador General | `admin@delivery.com` | `admin123` | Control total del sistema |
| `DRIVER` | Carlos Chofer | `driver1@delivery.com` | `driver123` | Camión Isuzu ABC-123 (`isAvailable: true`) |
| `DRIVER` | Luis Transportista | `driver2@delivery.com` | `driver123` | Furgoneta Renault XYZ-789 (`isAvailable: true`) |
| `CLIENT` | Ana Cliente | `client1@delivery.com` | `client123` | Cliente estándar |
| `CLIENT` | Pedro Comprador | `client2@delivery.com` | `client123` | Cliente estándar |

---

## 6. URLs y Documentación

- **API Base:** `http://localhost:3000/api/v1`
- **Swagger / OpenAPI interactivo:** [http://localhost:3000/api/docs](http://localhost:3000/api/docs)
  > Puedes autenticarte directamente en Swagger haciendo clic en el botón **Authorize** e ingresando el token Bearer devuelto por `/api/v1/auth/login`.
- **Seguridad y Ciclo de Vida de Pedidos (#8):** [`docs/order-security.md`](./docs/order-security.md) (Matriz de permisos, mitigación IDOR/BOLA, gobierno de estados y concurrencia).
- **Contrato geográfico (#9):** [`docs/geolocation-contract.md`](./docs/geolocation-contract.md) (pares opcionales, lectura, preparación geográfica y responsabilidad del mapa).
- **Migración y recuperación geográfica:** [`docs/geolocation-migration.md`](./docs/geolocation-migration.md).
- **Diseño de Armado de Rutas (Clarke & Wright):** [`docs/clarke-wright.md`](./docs/clarke-wright.md).

---

## 7. Colección de Pruebas (Postman / Insomnia / Bruno / Newman)

El archivo [`delivery-api.postman_collection.json`](./delivery-api.postman_collection.json) está en la raíz del proyecto, listo para importar. Es una colección **autocontenida y ejecutable de punta a punta**:
- Crea sus propios datos (zona, producto y 4 pedidos con códigos únicos), por lo que no depende de IDs fijos de la base de datos.
- Encadena variables entre requests (`adminToken`, `clientToken`, `driverToken`, `zoneId`, `productId`, `orderId1..4`, `driverId`, `routeId`).
- Valida en cada request el código HTTP y el tiempo de respuesta (< 500 ms), y en los casos de negocio la estructura JSON: máximo 4 pedidos por ruta, zona única por ruta, repartidor no disponible, `stopOrder` secuencial, permisos por rol (401/403) y ciclo de vida del pedido.
- Las credenciales y la URL base se definen en [`test/postman/logistica_env.json`](./test/postman/logistica_env.json) (cambie `baseUrl` para apuntar a otro ambiente).

### Ejecutar con Newman (CLI y Ejecutor Aislado)

Para aislar las pruebas y proteger la base de datos de desarrollo, el proyecto incluye un ejecutor dedicado (`test/run-newman-isolated.sh`):

- **Aprovisionamiento efímero:** Levanta automáticamente un contenedor PostgreSQL 16 dedicado en un puerto loopback aleatorio (`127.0.0.1::5432`), aplica la cadena real de migraciones Prisma 8, verifica el contrato y ejecuta la semilla dos veces solo en esa base y levanta el backend en un puerto libre.
- **Protección de base externa:** El script rechaza incondicionalmente cualquier variable `DATABASE_URL` heredada en el entorno (`exit 1`), garantizando que jamás se conecte ni mute bases de datos compartidas o locales.
- **Limpieza y señales:** Captura `EXIT`, `INT`, `TERM` y `HUP`, gestionando la detención del backend dedicado y la eliminación del contenedor efímero; SIGKILL o fallos de Docker pueden requerir limpieza manual de recursos cuya propiedad se haya verificado. Preserva códigos de salida no nulos (ej. 42 de Newman o 130 de SIGINT).
- **Cobertura funcional y de seguridad (64 requests, 268 assertions en la ejecución local T3):**
  - Evalúa intentos de mutación de chofer a `IN_TRANSIT` y `DELIVERED` como pruebas negativas `403 Forbidden` (*fail-closed*, no omitidas); la progresión positiva `ASSIGNED -> IN_TRANSIT -> DELIVERED` con `Route.IN_PROGRESS` queda formalmente pendiente del Issue #10.
  - Valores de estado no permitidos en el DTO son rechazados con `400 Bad Request`.
  - Bloqueo de IDOR/BOLA entre choferes y clientes verificado con `403 Forbidden`.
  - Invarianza de pedidos en base de datos tras intentos de mutación denegados.

**Comandos seguros de ejecución:**

```bash
# Ejecución en consola
env -u DATABASE_URL pnpm run test:api

# Ejecución con generación de reporte HTML (reports/newman/informe-api.html)
env -u DATABASE_URL pnpm run test:api:report
```

---

## 8. Comandos de Verificación y Calidad

### Ejecutar Pruebas Unitarias y Contratos
```bash
pnpm test --runInBand
```
Ejecuta 156 pruebas automatizadas en 21 suites Jest, cubriendo autenticación, ciclo de vida de pedidos, políticas de autorización, algoritmo de rutas y contratos de CI.

### Ejecutar Cobertura de Código (Umbral CI >= 80 %)
```bash
pnpm run test:cov --coverageThreshold='{"global":{"statements":80,"branches":80,"functions":80,"lines":80}}'
```
Métricas reales alcanzadas: Statements 98.08 %, Branches 87.82 %, Functions 92.68 %, Lines 98.10 %.

### Ejecutar Pruebas de Integración y Seguridad (E2E)
```bash
pnpm run test:e2e --runInBand
```
Ejecuta 31 pruebas E2E contra PostgreSQL real (`test/orders-security.e2e-spec.ts` y `test/app.e2e-spec.ts`), validando autorización JWT, matriz de roles, prevención IDOR/BOLA, grafo de estados e invariancia de datos sin colisiones ni reseteos globales.

### Validar Scripts Shell
```bash
# Validación sintáctica
bash -n test/run-newman-isolated.sh

# Análisis estático con ShellCheck (vía Docker)
docker run --rm -i koalaman/shellcheck:v0.10.0 - < test/run-newman-isolated.sh
```

### Ejecutar Linter
```bash
pnpm run lint
```
Ejecuta oxlint (`oxlint --type-aware src/ test/`) sin advertencias ni errores.

### Compilar para Producción
```bash
pnpm run build
```
Genera los archivos compilados en `dist/`.

### Iniciar en Producción
```bash
pnpm run start:prod
```

---

## 9. Pipeline de Integración Continua (CI)

El flujo de trabajo automatizado en [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) implementa una estrategia de dos etapas que garantiza que ningún cambio defectuoso o inseguro se integre:

1. **Job `quality` (Lint, build y pruebas unitarias):**
   - Checkout y configuración de Node.js 26.
   - Validación sintáctica de scripts con `bash -n` y análisis estático de shell con `shellcheck` (con instalación automática vía apt si no está preinstalado en el runner).
   - Análisis estático estricto con `oxlint`.
   - Compilación con `nest build`.
   - Pruebas unitarias con verificación estricta de cobertura $\ge 80\,\%$ en todas las métricas.
   - Publicación del artefacto de cobertura (`cobertura`).

2. **Job `api-tests` (Pruebas de integración E2E y API con PostgreSQL y Newman):**
   - Servicio temporal PostgreSQL 16 (`postgres:16-alpine`) en puerto 5432 con health check.
   - Creación de esquema relacional con `pnpm prisma db init`.
   - Ejecución de la suite E2E (`pnpm run test:e2e --runInBand`, 31 pruebas) contra el servicio de PostgreSQL.
   - Ejecución de la suite de API Newman mediante `env -u DATABASE_URL pnpm run test:api:report`, permitiendo al runner levantar de forma autónoma su propio entorno efímero y generar el reporte HTML.
   - Publicación del reporte HTML de Newman (`informe-newman`).
   - Propagación estricta de fallos: no se utiliza `continue-on-error`, por lo que cualquier fallo en pruebas o verificación detiene el pipeline.

> *Nota de estado remoto:* La ejecución en los runners remotos de GitHub Actions se activará automáticamente al enviar el branch y abrir el Pull Request correspondiente (referenciando `Refs #8`).
