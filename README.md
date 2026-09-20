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

Asegúrate de tener instaladas las siguientes herramientas en tu entorno:
- **Node.js:** Versión  `>= 22.0.0`.
- **pnpm:** Versión  `>= 12.0.0`.
- **Docker & Docker Compose:** Para ejecutar el contenedor de PostgreSQL.

---

## 4. Instalación y Puesta en Marcha (Paso a Paso)

### Paso 1: Clonar el repositorio y entrar al directorio
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
Verifica que los valores coincidan con tu configuración local de Docker:
```env
DATABASE_URL="postgresql://logistica_user:logistica_password123@localhost:5432/logistica_db?schema=public"
JWT_SECRET="uta_logistica_jwt_secret_key_2026_super_secure"
JWT_EXPIRES_IN="24h"
PORT=3000
```

### Paso 4: Levantar la base de datos PostgreSQL en Docker
```bash
docker compose up -d
```
> Verifica que el contenedor esté corriendo con `docker compose ps`.

### Paso 5: Aplicar migraciones con Prisma 8
```bash
pnpm exec prisma db migrate --advance-ref db
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

## 7. Colección de Pruebas (Postman / Insomnia / Bruno)

El archivo [`delivery-api.postman_collection.json`](./delivery-api.postman_collection.json) se encuentra en la raíz del proyecto listo para importar. Contiene:
- **Variables automáticas:** La petición `POST Login Admin` almacena automáticamente el token en `{{token}}`.
- **Casos de prueba de la Regla de Negocio:**
  - `POST Assign Route - Success (<= 4 orders)`: Validación exitosa de ruta.
  - `POST Assign Route - Reject (> 4 orders)`: Validación de rechazo con error 400 cuando se envían 5 pedidos.

---

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
