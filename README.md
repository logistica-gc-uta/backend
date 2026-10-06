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
Este comando creará automáticamente los usuarios, choferes, zonas y productos necesarios para pruebas.

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

---

## 7. Colección de Pruebas (Postman / Insomnia / Bruno / Newman)

El archivo [`delivery-api.postman_collection.json`](./delivery-api.postman_collection.json) está en la raíz del proyecto, listo para importar. Es una colección **autocontenida y ejecutable de punta a punta**:
- Crea sus propios datos (zona, producto y 4 pedidos con códigos únicos), por lo que no depende de IDs fijos de la base de datos.
- Encadena variables entre requests (`adminToken`, `clientToken`, `driverToken`, `zoneId`, `productId`, `orderId1..4`, `driverId`, `routeId`).
- Valida en cada request el código HTTP y el tiempo de respuesta (< 500 ms), y en los casos de negocio la estructura JSON: máximo 4 pedidos por ruta, zona única por ruta, repartidor no disponible, `stopOrder` secuencial, permisos por rol (401/403) y ciclo de vida del pedido.
- Las credenciales y la URL base se definen en [`test/postman/logistica_env.json`](./test/postman/logistica_env.json) (cambie `baseUrl` para apuntar a otro ambiente).

### Ejecutar con Newman (CLI)

Con la base de datos levantada, el seed ejecutado y el backend corriendo (`pnpm run start:dev`):

```bash
pnpm run test:api          # resultado en consola
pnpm run test:api:report   # consola + reporte HTML en reports/newman/informe-api.html
```

> Cada asignación de ruta deja al repartidor como no disponible. `test:api:report` ejecuta antes `pnpm run seed:reset-drivers` para liberarlos y poder repetir la corrida. Si usa `test:api` directamente varias veces, ejecute ese comando de reinicio entre corridas.

## 8. Comandos de Verificación y Calidad

### Ejecutar Pruebas Unitarias
```bash
pnpm run test
```
Ejecuta la suite de pruebas Jest cubriendo autenticación, validación de reglas de negocio en `RoutesService` y controladores.

### Ejecutar Linter
```bash
pnpm run lint
```
Ejecuta oxlint con validación de tipos estricta sin advertencias ni errores.

### Compilar para Producción
```bash
pnpm run build
```
Genera los archivos listos para producción en el directorio `dist/`.

### Iniciar en Producción
```bash
pnpm run start:prod
```
