# Sistema de Logística y Entrega de Pedidos — UTA 📦🚚

Backend modular de alto rendimiento para la gestión logística de despachos, pedidos, catálogo de productos y asignación de rutas de entrega, desarrollado para la asignatura de **Gestión, Pruebas e Implementación de Software** de la **Universidad Técnica de Ambato (UTA)**.

---

## 1. Tecnologías y Arquitectura

- **Framework:** [NestJS 12](https://nestjs.com/) (ESM-first, arquitectura modular, inyección de dependencias).
- **ORM / Base de Datos:** [Prisma 8](https://www.prisma.io/) (`@prisma/orm-postgres`) con PostgreSQL 16.
- **Tiempo real:** Socket.IO con JWT, salas por recurso y resincronización REST tras reconectar.
- **Autenticación & Autorización:** JWT con Passport (`@nestjs/jwt`, `passport-jwt`) y Guards por Roles (`ADMIN`, `DRIVER`, `CLIENT`).
- **Validación de Datos:** `class-validator` y `class-transformer` con `ValidationPipe` global.
- **Documentación Interactiva:** OpenAPI / Swagger (`@nestjs/swagger`) en `/api/docs`.
- **Linter & Análisis Estático:** [oxlint](https://oxc.rs/) con reglas type-aware.
- **Testing:** [Jest](https://jestjs.io/) con suites automatizadas y umbral CI del 80 % en cada métrica de cobertura.
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
│   ├── routes/                   # Asignación de pedidos a rutas (Regla <= 4 pedidos)
│   └── realtime/                 # Gateway Socket.IO, autorización y eventos mínimos v1
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
- **Pedidos administrativos e invitados (#11):** [`docs/issue-11-admin-guest-orders.md`](./docs/issue-11-admin-guest-orders.md) (API y verificación independiente A–E completa con compatibilidad TypeScript downstream no oficial; revisión y entrega aún pendientes).
- **Seguridad y Ciclo de Vida de Pedidos (#8):** [`docs/order-security.md`](./docs/order-security.md) (Matriz de permisos, mitigación IDOR/BOLA, gobierno de estados y concurrencia).
- **Contrato geográfico (#9):** [`docs/geolocation-contract.md`](./docs/geolocation-contract.md) (pares opcionales, lectura, preparación geográfica y responsabilidad del mapa).
- **Migración y recuperación geográfica:** [`docs/geolocation-migration.md`](./docs/geolocation-migration.md).
- **Diseño de Armado de Rutas (Clarke & Wright):** [`docs/clarke-wright.md`](./docs/clarke-wright.md).
- **Propuestas de rutas (#7):** [`docs/route-planning.md`](./docs/route-planning.md) (`GET /api/v1/route-proposals`, solo lectura, solo ADMIN).
- **Socket.IO y resincronización (#13):** [`docs/realtime.md`](./docs/realtime.md) (JWT, `REALTIME_ALLOWED_ORIGINS`, salas autorizadas, eventos v1, React/Flutter y Cloudflare Tunnel); [`docs/realtime-transactions.md`](./docs/realtime-transactions.md) (publicación solo después del commit); [`docs/issue-13-verification.md`](./docs/issue-13-verification.md) (matriz y evidencia real). REST GET sigue siendo autoritativo; sin replay/offline garantizado, GPS ni ETA. Los ejemplos frontend/tunnel no equivalen a integración ejecutada.
- **Urgencias e intervención ADMIN (#12):** [`docs/urgent-dispatch.md`](./docs/urgent-dispatch.md) (propuestas sin escrituras, decisiones auditadas, acuerdo explícito y reintentos con historial intacto; verificación local e independiente PASS; commit E y PR autorizados; CI remoto se informa por separado, sin aprobación RDD).

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
- **Evidencia final #11:** 104 requests y 434 assertions, cero fallos y salida global 0; conserva las 93 requests anteriores y agrega 11 de pedidos administrativos/invitados. Comprueba permisos, IDOR/BOLA, estados, inventario y destinatarios; listado ADMIN con `{items,total,page,pageSize}`.
- **Limpieza verificable:** registra ID/owner y comprueba propiedad antes de eliminar. Solo acepta ausencia del ID exacto con status 1 y las dos formas conocidas de Docker (mayúsculas o variante minúscula de Docker 29.9 con LF inicial). Error de remoción o inspección inesperada falla cerrado; preserva el fallo primario. Consulta final por owner: cero contenedores propios.

**Comandos seguros de ejecución:**

```bash
# Ejecución en consola
env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null pnpm run test:api

# Ejecución con generación de reporte HTML (reports/newman/informe-api.html)
env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null pnpm run test:api:report
```

---

## 8. Comandos de Verificación y Calidad

### Ejecutar Pruebas Unitarias y Contratos
```bash
pnpm test --runInBand
```
La regresión local de #13 ejecutó **662 pruebas en 49 suites PASS**, incluida la compatibilidad downstream y Socket.IO; cubre autenticación, pedidos, autorización, rutas y contratos de CI. La prueba independiente y sus límites se registran por separado en [`docs/issue-13-verification.md`](./docs/issue-13-verification.md).

### Ejecutar Cobertura de Código (Umbral CI >= 80 %)
```bash
env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null pnpm run test:cov --runInBand --coverageThreshold='{"global":{"statements":80,"branches":80,"functions":80,"lines":80}}'
```
Regresión local #13: **49 suites / 662 pruebas PASS**, con umbrales originales del 80 % cada uno. Statements 91.46 %, Branches 84.07 %, Functions 89.75 %, Lines 93.13 %.

### Ejecutar Pruebas de Integración y Seguridad (E2E)
```bash
env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null pnpm run test:e2e:isolated
```
Runner canónico, regresión local #13: **21 suites / 351 pruebas PASS**. Ejecuta 18 suites con recursos propios y 3 legacy en bases PostgreSQL 16 propias, migradas/verificadas y con limpieza confirmada. La suite Socket.IO final conserva esos siete casos y agrega dos probes independientes: **9/9 PASS** en un recheck del archivo afectado. Cubre persistencia, rollback, aislamiento, reconexión e intervenciones; el recheck no se presenta como otra ejecución completa del manifiesto. Sin BD ambiental/compartida ni volúmenes persistentes de Compose. `test:e2e` sigue disponible como runner Jest directo, pero no sustituye este aislamiento integral.

### Validar Scripts Shell
```bash
# Validación sintáctica
bash -n test/run-newman-isolated.sh test/run-e2e-isolated.sh
node --check test/run-e2e-isolated.mjs

# Análisis estático cuando ShellCheck esté instalado
shellcheck test/run-newman-isolated.sh test/run-e2e-isolated.sh
```
Bash y Node PASS en la verificación final; ShellCheck no estaba instalado localmente (sin PASS atribuido).

### Ejecutar Linter
```bash
pnpm run lint
```
Ejecuta oxlint (`oxlint --type-aware src/ test/`). Verificación final PASS con advertencia histórica en `test/route-start.e2e-spec.ts:217`.

### TypeScript: compatibilidad downstream acotada (#11)
```bash
pnpm exec tsc --noEmit --tsBuildInfoFile /dev/null
```
**PASS independiente final: salida 0, cero diagnósticos.** El fallo anterior de tres TS2741 históricos queda supersedido por una compatibilidad downstream explícitamente autorizada, **no oficial de Prisma**, sin alterar migraciones. [Declaración sin emisión runtime](types/prisma-legacy-rawsql-compat.d.ts): solo tres identidades legacy, retorno del input real sin inventar `objectType`; el overload estricto SDK sigue vigente para operaciones nuevas. [Pruebas y límites](docs/issue-11-admin-guest-orders.md#compatibilidad-downstream-autorizada--verificación-independiente-completa) congelan bytes/SQL y limitan usos a las tres rutas históricas. La declaración global no comprueba SQL ni procedencia por sí sola: esas garantías dependen del guard separado en Jest/CI. A–E están completas funcionalmente y verificadas; esto no es aprobación RDD ni autorización de entrega.

```bash
env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null pnpm test --runInBand --runTestsByPath test/prisma-legacy-rawsql-compat.spec.ts
```
25/25 pruebas PASS independientes: compilación semántica, 17 fixtures negativos y adversarios de SQL/procedencia con hashes históricos congelados. La investigación acotada a rc.11/15/17 no encontró corrección upstream; no implica que todas las versiones estén afectadas. Sin instalación ni cambios de dependencias/lock por esta compatibilidad; migraciones y artefactos intactos. Sustituirla solo por una solución upstream verificada y repetir los checks.

```bash
pnpm exec tsc --noEmit --incremental false -p tsconfig.build.json
```
El chequeo separado de build también PASS; el PASS raíz se verificó con su propio comando, no se infiere del build.

### Compilar para Producción
```bash
pnpm run build
```
Genera los archivos compilados en `dist/`; build con emisión PASS en la verificación independiente final.

### Iniciar en Producción
```bash
pnpm run start:prod
```

---

## 9. Pipeline de Integración Continua (CI)

El flujo en [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) conecta dos etapas de calidad. Su build no reemplaza el chequeo TypeScript raíz ni la revisión requerida:

1. **Job `quality` (Lint, build y pruebas unitarias):**
   - Checkout y configuración de Node.js 26.
   - Validación sintáctica de scripts con `bash -n` y análisis estático de shell con `shellcheck` (con instalación automática vía apt si no está preinstalado en el runner).
   - Análisis estático estricto con `oxlint`.
   - Compilación con `nest build`.
   - Pruebas unitarias con verificación estricta de cobertura $\ge 80\,\%$ en todas las métricas.
   - Publicación del artefacto de cobertura (`cobertura`).

2. **Job `api-tests` (Pruebas de integración E2E y API con PostgreSQL y Newman):**
   - Preparación de `postgres:16-alpine`, sin servicio compartido ni `db init` global.
   - Manifiesto E2E completo mediante `env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null pnpm run test:e2e:isolated`; cada runner gestiona sus recursos y migraciones.
   - Build y Newman mediante `env -u DATABASE_URL DOTENV_CONFIG_PATH=/dev/null pnpm run test:api:report`; genera su propio JWT y entorno efímero, con reporte HTML.
   - Publicación del reporte HTML de Newman (`informe-newman`).
   - Propagación estricta de fallos: no se utiliza `continue-on-error`, por lo que cualquier fallo en pruebas o verificación detiene el pipeline.

> A–E completas funcionalmente y verificadas de forma independiente, no CI remota ni aprobación nativa. Rama `feat/11-admin-guest-orders`, HEAD `57208e9` y Draft PR #26 intactos; sin staging, commits, push, merge ni cierre de Issue #11. RDD sigue diferida por el usuario. Próximo paso: coordinar nueva autorización de commits/RDD; publicación, CI, revisión, merge y cierre son decisiones separadas.
>
> Límites: intervalo reloj BD final → COMMIT; forwarding de señales OS reales del runner E2E no probado independientemente; ShellCheck local no disponible. No son fallos atribuidos a los checks funcionales ejecutados.

## Consulta de rutas del repartidor

`GET /api/v1/drivers/me/routes?date=YYYY-MM-DD` permite a un usuario `DRIVER` consultar únicamente sus rutas asignadas, con zona y pedidos ordenados por parada. Sin rutas o perfil de repartidor devuelve `[]`. La identidad proviene exclusivamente del JWT; los campos de consulta no admiten IDs de usuario, repartidor ni ruta.

El filtro opcional se aplica a `Route.date` durante el día local de `America/Guayaquil` (inicio inclusivo, siguiente medianoche exclusiva), no a la fecha programada de cada pedido. Fechas inexistentes, valores repetidos o campos desconocidos devuelven `400`; sin JWT válido devuelve `401`, y otros roles reciben `403`. Esta consulta no habilita cambios de estado por parte del repartidor. Consulte el [contrato y los límites de seguridad](docs/driver-routes.md).
