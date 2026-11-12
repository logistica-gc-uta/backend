# Issue #43 — Gestión ADMIN de perfiles de repartidor

## Qué se contrastó antes de implementar

- `DriversController` solo tenía `GET /drivers` (ADMIN), `GET /drivers/me/availability` y `GET /drivers/me/routes` (DRIVER). No existía alta ni edición.
- Ningún otro módulo crea identidades: `AuthService.register` es la única vía (siempre CLIENT) y `src/prisma/seed.ts` crea los perfiles de desarrollo. **Se reutiliza** de `AuthService` la normalización del correo, el error `409 EMAIL_ALREADY_EXISTS` y el reconocimiento de la violación de unicidad: se movieron sin cambiar su comportamiento a `src/modules/auth/email-identity.util.ts` y los usa también el registro público.
- `Driver.isAvailable` es una bandera de compatibilidad que la asignación de rutas pone en `false` y la disponibilidad efectiva (`RouteAvailabilityService.effective`) combina con las reservas y rutas persistidas. **La corrección de perfiles nunca la toca.**

## Contrato

| Operación | Rol | Cuerpo | Respuesta |
|---|---|---|---|
| `POST /api/v1/drivers` | ADMIN | `name` (2–120), `email`, `vehicle` (2–120) | `201` perfil + `temporaryPassword` (una sola vez, `Cache-Control: no-store`) |
| `PATCH /api/v1/drivers/:id` | ADMIN | cualquiera de `name`, `email`, `vehicle` (al menos uno) | `200` perfil |
| `GET /api/v1/drivers` | ADMIN | — | sin cambios de forma |
| `GET /api/v1/drivers/me/availability`, `/me/routes` | DRIVER | — | sin cambios |

Forma del perfil (igual que el listado existente, sin hashes): `id`, `userId`, `vehicle`, `isAvailable`, `createdAt`, `user {id,name,email,role,createdAt}`, `effectiveAvailability {isAvailable, hasPersistedHolds, compatibilityFlagBlocks, blockingRouteIds}`.

Errores: `400` campos inválidos, no permitidos (por ejemplo `role`, `isAvailable`, `password`, `userId`) o cuerpo vacío; `401` sin token; `403` rol distinto de ADMIN; `404` repartidor inexistente; `409 EMAIL_ALREADY_EXISTS`.

## Decisiones de diseño (decididas, no adivinadas)

| Tema | Decisión |
|---|---|
| Campos del alta | Los existentes del modelo: nombre, correo y vehículo. No se agregan columnas ni migraciones (teléfono no es requerido por ningún consumidor actual). |
| Unicidad | Correo único sin distinguir mayúsculas, con la misma regla del registro público. |
| Rol | Lo fija el servidor (`DRIVER`). Cualquier `role` en el cuerpo se rechaza con 400; un CLIENT recibe 403. |
| Acceso inicial | Contraseña temporal aleatoria (18 bytes, 24 caracteres base64url) generada por el servidor, guardada **solo con hash** (`bcrypt-sha256`) y devuelta **una única vez**. No hay claves compartidas, no se registra y no se envían correos. |
| Atomicidad | Usuario y perfil se crean en una transacción: si falla el perfil no queda ningún usuario huérfano. |
| Edición | Nombre, correo y vehículo. Bloquea la fila del repartidor (mismo patrón que la asignación) y **no modifica** rol, `isAvailable`, rutas ni reservas. |
| Baja/desactivación | No está definida: no existe y no hay borrado físico de usuarios ni de historial. Queda como pregunta abierta al líder. |

## Riesgos y limitaciones

- **No hay flujo de cambio de contraseña** en el backend: el repartidor usa la contraseña temporal hasta que exista uno (fuera de alcance). Si el ADMIN la pierde no hay recuperación; habría que decidir un flujo de restablecimiento.
- Cambiar el correo cambia la identidad de acceso: los tokens ya emitidos siguen siendo válidos hasta expirar.
- Frontend (`frontend-web-logistica#36`): debe mostrar `temporaryPassword` una sola vez y avisar que no se puede volver a ver.
- Las ausencias y la disponibilidad por fecha son del issue #44; no se duplican aquí.

## Pruebas

- Unitarias: `src/modules/drivers/driver-management.spec.ts` (DTO, servicio, controlador y helpers compartidos).
- E2E en PostgreSQL real (contenedor propio): `test/driver-profiles.e2e-spec.ts`, 14 pruebas: alta, inicio de sesión con la contraseña temporal, permisos (CLIENT/DRIVER/anónimo), elevación de privilegios, validaciones, correo duplicado, atomicidad con fallo inyectado, corrección parcial, conflicto de correo sin cambios parciales y la corrección de un repartidor ocupado (rutas, reserva e indisponibilidad intactas).
- Regresión: `issue31-auth` (el registro usa los helpers movidos), `route-assignment`, `admin-guest-orders-api` y las suites de `drivers`/`auth`.
