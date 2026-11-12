## Descripción

Gestión de perfiles de repartidor desde administración: alta (`POST /drivers`) y corrección (`PATCH /drivers/:id`) solo para ADMIN. La identidad DRIVER la fija el servidor, el alta crea usuario y perfil en una transacción y editar un perfil no libera a un repartidor ocupado ni toca sus rutas.

## Issue relacionado

Closes #43

## Cambios realizados

- `POST /api/v1/drivers` (ADMIN): `name`, `email`, `vehicle`. Crea la identidad `DRIVER` y el perfil de forma atómica. El acceso inicial es una contraseña temporal aleatoria generada por el servidor, guardada solo con hash y devuelta una única vez (`Cache-Control: no-store`).
- `PATCH /api/v1/drivers/:id` (ADMIN): corrige nombre, correo y/o vehículo. Bloquea la fila del repartidor y no modifica rol, `isAvailable`, rutas ni reservas.
- Reutilización: la normalización del correo, el `409 EMAIL_ALREADY_EXISTS` y la detección de unicidad se movieron sin cambios de comportamiento a `auth/email-identity.util.ts`; el registro público los sigue usando y solo crea CLIENT.
- `GET /drivers` y las consultas de Flutter (`me/availability`, `me/routes`) no cambian.
- Documentación del contrato, decisiones y riesgos en `docs/issue-43-driver-profiles.md`.

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | PASS | `pnpm lint`, `tsc --noEmit` |
| Pruebas unitarias | PASS | `driver-management.spec.ts` (DTO, servicio, controlador, helpers) y suites de `drivers` y `auth` |
| Pruebas de integración | PASS (14 nuevas) | `test/driver-profiles.e2e-spec.ts` sobre PostgreSQL 16 real en contenedor propio |
| Regresión | PASS (126) | `issue31-auth`, `route-assignment`, `admin-guest-orders-api` |
| Compilación | PASS | `pnpm build` |

Ejemplos del issue cubiertos: un CLIENT que intenta crear un DRIVER recibe 403 sin usuario ni perfil parcial; la corrección de un repartidor ocupado conserva sus rutas, su reserva y su indisponibilidad.

## Evidencias

`docs/issue-43-driver-profiles.md` y la salida de Jest del e2e.

## Impacto técnico

**API / Contratos:** dos operaciones nuevas (ADMIN); sin cambios en las existentes. Frontend (`frontend-web-logistica#36`) debe mostrar `temporaryPassword` una sola vez.

**Base de datos / Migraciones:** sin cambios.

**Seguridad y permisos:** solo ADMIN; el cuerpo rechaza `role`, `isAvailable`, `userId` y `password`; la contraseña temporal se guarda con hash, no se registra y no se vuelve a mostrar; las respuestas no incluyen hashes.

**Compatibilidad con otros componentes:** la forma del perfil es la del listado actual.

**Limitaciones conocidas:** no hay flujo de cambio ni de restablecimiento de contraseña (el repartidor usa la temporal); la baja o desactivación no está definida y no se implementó; ausencias en #44.

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

Decisiones que conviene confirmar con el líder: la contraseña temporal mostrada una vez como acceso inicial, que el correo sea editable por ADMIN y que la baja quede fuera. `ci-security.spec.ts` ahora espera 35 suites e2e.
