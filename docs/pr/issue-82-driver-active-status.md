## Descripción

Agrega una baja operativa reversible de repartidores: un estado administrativo `isActive`, distinto de las ausencias y de la disponibilidad calculada por rutas. Un repartidor inactivo no inicia sesión, su sesión previa deja de valer, no abre tiempo real y no recibe asignaciones. La reactivación devuelve el acceso sin tocar ausencias ni otras restricciones, y nada se elimina.

## Issue relacionado

Closes #82

## Cambios realizados

- `Driver.isActive` (activo por defecto: las cuentas existentes siguen activas), con quién, cuándo y por qué del último cambio, y un historial `DriverStatusChange` inmutable.
- `POST /drivers/:id/deactivate`, `POST /drivers/:id/activate` y `GET /drivers/:id/status-changes` (solo ADMIN, actor del JWT). El listado y las respuestas incluyen `isActive` y el motivo del último cambio.
- La baja se rechaza con `409 DRIVER_HAS_OPEN_ROUTE` (con las rutas que la bloquean) si hay una ruta asignada, en curso o terminada o interrumpida sin regreso confirmado, y no modifica nada. Repetirla o reactivar a uno activo da `DRIVER_ALREADY_INACTIVE` o `DRIVER_ALREADY_ACTIVE`.
- Login (`403`), sesión previa (`401`), tiempo real y todas las entradas de asignación (asignar, confirmar, asignación heredada y reasignar, `409 DRIVER_INACTIVE`) rechazan a un repartidor inactivo.
- La baja y la asignación se serializan con el mismo bloqueo de fila; además, disparadores de la base de datos impiden crear una reserva o una ruta para un inactivo.
- Migración `20261120T0109_driver_active_status` y documentación en `docs/issue-82-driver-active-status.md`.

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | PASS | `pnpm lint`, `tsc --noEmit` |
| Pruebas unitarias | PASS | baja, reactivación, login, sesión y tiempo real; cobertura de ramas sobre el umbral del CI |
| Pruebas de integración | PASS (24 nuevas) | `test/driver-active-status.e2e-spec.ts` sobre PostgreSQL 16 real y JWT reales |
| Regresión | PASS | e2e completo del manifiesto aislado |
| Compilación | PASS | `pnpm build` |

La suite cubre la migración por etapas de una cuenta existente, permisos, sesión emitida antes de la baja, reincorporación, los estados de ruta con y sin regreso, el rechazo de asignación y reasignación, Socket.IO real y la carrera entre asignación y baja (8 repeticiones: nunca queda un inactivo con una asignación nueva).

## Evidencias

`docs/issue-82-driver-active-status.md` y la salida de Jest.

## Impacto técnico

**API / Contratos:** tres endpoints nuevos y campos nuevos en el perfil del repartidor. `effectiveAvailability` conserva su forma y solo deja `isAvailable` en `false` para un inactivo. Los motivos estables están documentados; hay que acordarlos con web (`frontend-web-logistica#64`).

**Base de datos / Migraciones:** columnas nuevas en `driver`, una tabla y tres disparadores. La relación `Driver.user` se renombra en el contrato; no cambia ninguna columna.

**Seguridad y permisos:** solo ADMIN gestiona la baja; el login no revela qué cuentas están inactivas hasta verificar la contraseña.

**Compatibilidad con otros componentes:** la app móvil no cambia (queda fuera de alcance) pero debe mostrar el mensaje de `DRIVER_INACTIVE` en el login. `ci-security.spec.ts` espera 53 archivos e2e.

**Limitaciones conocidas:** un socket ya conectado no se cierra por la fuerza: se rechaza en la siguiente suscripción. No hay revocación individual de tokens: la sesión previa vuelve a valer al reactivar si el JWT no venció.

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

Conviene revisar la función `driver_requires_active_for_assignment`: el `FOR SHARE` sobre la fila del repartidor es lo que serializa la baja con una asignación aunque algún camino no bloquee antes. Decisiones a confirmar: que el estado viva en `Driver` y no en `User`, y que una sesión previa vuelva a valer al reactivar.
