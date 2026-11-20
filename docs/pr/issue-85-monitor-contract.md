## Descripción

Completa y deja documentado el contrato de Seguimiento para el flujo administrativo (cancelaciones, liberación de reservas, disponibilidad e incidentes de Emergencias). Tras inventariar la API de rutas, la bandeja y los eventos de tiempo real, casi todo ya alcanzaba: solo se agregan los identificadores que faltaban para enlazar ruta, pedido, incidente y emergencia, sin una API paralela.

## Issue relacionado

Closes #85

## Cambios realizados

- Los eventos de emergencia de `dispatch.incident.updated` ahora llevan `routeId` y `emergencyId` (el contrato ya lo aceptaba, pero ningún publicador lo rellenaba); el aviso de visita fallida lleva también `routeId`.
- `GET /dispatch/routes/:id/emergency` responde 404 con código estable: `ROUTE_NOT_FOUND` o `ROUTE_EMERGENCY_NOT_FOUND`.
- Todo es aditivo: no cambian campos ni permisos de lectura de repartidores y clientes, y los avisos siguen sin motivos ni datos de contacto.
- Se mantiene que la cancelación previa a la salida no emite `dispatch.incident.updated`; Seguimiento usa `route.updated` y `order.status.updated`. Queda documentado.
- Documentación en `docs/issue-85-monitor-contract.md` (inventario, decisiones y evidencia) y tablas de eventos actualizadas.

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | PASS | `pnpm lint`, `tsc --noEmit` |
| Pruebas unitarias | PASS | emergencias y regreso de ruta con los identificadores nuevos |
| Pruebas de contrato | PASS (10 nuevas) | `test/monitor-contract.e2e-spec.ts`: REST y Socket.IO sobre PostgreSQL real |
| Regresión | CI | e2e aislado del CI de GitHub |
| Compilación | PASS | `pnpm build` |

## Evidencias

`docs/issue-85-monitor-contract.md` y la salida de Jest.

## Impacto técnico

**API / Contratos:** campos aditivos en eventos de tiempo real (`routeId`, `emergencyId`) y un `code` estable en dos respuestas 404. Hay que acordar con web (`frontend-web-logistica#67`) cómo usarlos.

**Base de datos / Migraciones:** ninguno.

**Seguridad y permisos:** sin cambios; los avisos siguen filtrados por destinatario y revalidados antes de enviar.

**Compatibilidad con otros componentes:** la app móvil no cambia. `ci-security.spec.ts` espera 55 archivos e2e.

**Limitaciones conocidas:** no hay suscripción global de rutas ni reenvío de eventos perdidos: tras reconectar se resincroniza con REST.

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

Conviene confirmar que no hace falta una suscripción global de rutas para el tablero y que la cancelación previa a la salida siga sin emitir `dispatch.incident.updated`.
