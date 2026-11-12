## Descripción

Ausencias de repartidores y disponibilidad por fecha: el ADMIN registra, consulta y anula ausencias de hoy o fechas futuras, y la asignación de rutas respeta la ausencia del día de la ruta junto a los bloqueos por rutas y reservas. Registrar una ausencia con una ruta asignada informa el conflicto sin cancelar, liberar ni reasignar nada.

## Issue relacionado

Closes #44

## Cambios realizados

- Tabla `driverAbsence` (migración aditiva `20261111T2346_driver_absences`): rango cerrado de días operativos, motivo opcional y auditoría de quién registró y quién anuló.
- `POST /drivers/:driverId/absences`, `GET /drivers/:driverId/absences`, `POST /drivers/:driverId/absences/:absenceId/cancel` y `GET /drivers/:driverId/availability?date=` (solo ADMIN).
- `RouteAvailabilityService.effective(driverId, tx, day?)`: sin `day` conserva la forma histórica; con `day` suma la ausencia de ese día.
- Asignación, reemplazo y urgencias evalúan la ausencia del día de la ruta. La asignación rechaza con `409 DRIVER_ABSENT`. El registro y la anulación usan el mismo bloqueo del repartidor que la asignación (sin carreras).
- El retorno de una ruta no elimina la ausencia; levantar una ausencia no libera reservas.
- `GET /drivers/me/availability` (Flutter) y `GET /drivers` no cambian.
- Documentación del contrato y las decisiones en `docs/issue-44-driver-absences.md`.

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | PASS | `pnpm lint`, `tsc --noEmit` |
| Pruebas unitarias | PASS | `route-availability-absence.spec.ts`, `driver-absences.spec.ts` y suites de `routes` |
| Pruebas de integración | PASS (16 nuevas) | `test/driver-absences.e2e-spec.ts` sobre PostgreSQL 16 real en contenedor propio |
| Regresión | PASS | suites e2e de rutas, pedidos y repartidores (ver la sección de evidencias) |
| Compilación | PASS | `pnpm build` |

Ejemplos del issue cubiertos: un conductor ausente hoy no es elegible y la asignación se rechaza sin dejar cambios; con ausencia solo mañana se puede asignar hoy y no se crea ninguna ruta de mañana; registrar una ausencia con ruta asignada conserva ruta, pedidos y reserva y expone el conflicto. Concurrencia: 8 rondas de asignación y ausencia simultáneas terminan siempre en uno de los dos desenlaces válidos.

## Evidencias

`docs/issue-44-driver-absences.md` y la salida de Jest.

## Impacto técnico

**API / Contratos:** cuatro operaciones nuevas (ADMIN) y un error nuevo en la asignación (`409 DRIVER_ABSENT`). Sin cambios en las respuestas existentes. Frontend (`frontend-web-logistica#36`) puede consumir las nuevas.

**Base de datos / Migraciones:** una tabla nueva con claves foráneas, índices y restricciones; migración aditiva. El runner aislado apunta al nuevo contrato.

**Seguridad y permisos:** solo ADMIN; el actor sale del JWT; las ausencias no se editan ni se borran, se anulan con auditoría.

**Compatibilidad con otros componentes:** la consulta de Flutter conserva su forma. La ausencia no aparece en `me/availability` ni en el listado de repartidores; se ve en `GET /drivers/:id/availability?date=`.

**Limitaciones conocidas:** no hay tope de duración del rango; reemplazo automático, turnos y nómina están fuera de alcance; mostrar la ausencia en `me/availability` y en el listado exige acordar un cambio de contrato con web y móvil.

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

Decisiones que conviene confirmar con el líder: rango en un solo registro, conflicto informado sin bloquear el registro, anulación en lugar de edición, y que la ausencia se evalúe en el día de la ruta. `ci-security.spec.ts` ahora espera 35 suites e2e; si se fusiona antes el PR del issue #43, el conteo debe sumarse.
