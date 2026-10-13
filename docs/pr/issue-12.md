## Descripción

Urgencias del mismo día, intervención ADMIN auditada y reprogramación explícita con historial intacto. Un único PR hacia `main` desde `feat/12-urgent-dispatch`. **Gates funcionales locales PASS; commit E y publicación autorizados. CI remoto se reporta por separado.**

## Issue relacionado

Refs #12

Referencia no cerrante; aprobación/labels/política y CI del destino se revalidan antes de una publicación autorizada. No se infiere aprobación por este borrador.

## Cambios realizados

- Propuestas/inbox ADMIN de Guayaquil sin escrituras; DRAFT/ASSIGNED, cuatro pedidos, zona/fecha/geografía, claims y disponibilidad efectiva; Clarke & Wright/Haversine reutilizados.
- CONFIRM/REJECT/REORDER/MOVE/REASSIGN_DRIVER/PRIORITIZE atómicos, JWT/current DB ADMIN, auditoría append-only e idempotencia global.
- CONTACT/RESCHEDULE con acuerdo persistido fecha/franja, revalidación bajo locks, mismo pedido e historial R1 intacto, conductor retenido hasta retorno físico.
- Guards SQL oficiales y regresiones reales de permisos, concurrencia, rollback, historia y contratos. Sin Socket.IO/React/Flutter.

Archivos principales: servicios/controlador/DTOs en `src/modules/routes`, helpers de asignación, contrato y migraciones, `test/urgent-dispatch.e2e-spec.ts`, `test/dispatch-agreement-prestart.e2e-spec.ts`, historial y unitarias. [Contrato](../urgent-dispatch.md) · [Matriz/evidencia](../issue-12-verification.md).

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | TypeScript padre/aislado y lint exit0; solo warning preexistente status sin uso. Diff check exit0. | `reports/issue12-E-recovery/*controlled.log` |
| Pruebas unitarias | 637/637,46 suites, exit0; cobertura91.43/83.32/88.85/92.79, cuatro gates>=80%. | `coverage-controlled.log` |
| Pruebas de integración | 344/344,20 suites PostgreSQL, exit0/cleanup; suite20 enfocada1/1. | `e2e-controlled.log`, `suite20-controlled.log` |
| Compilación | Build aislado exit0; también incluido en Newman exitoso. | `build.log`, `newman-controlled.log` |
| Pruebas funcionales | Newman104requests/434assertions, cero fallos. UI/browser N/A: backend exclusivamente. | `newman-controlled.log` |
| Verificación independiente | Feature S1–S15/probe1 PASS; control de ejecución aislada10aserciones PASS. Nota de E2E pendiente de ese informe reconciliada con exit0 observado por padre. | Matriz/probe temporal |
| Integridad padre | 98.680 entradas de dependencias/package/lock, cero cambios; HEAD A–D/branch preservados. | `integrity-final.log` |

Shell scripts unchanged: `bash -n` PASS; local `shellcheck` unavailable (not installed), no automatic installation/retry. Required hosted CI installs and runs shellcheck; no remote PASS is claimed in advance. Changed `.mjs` runner is covered by focused tests and Node syntax check. Issue approval is human-granted `status:approved`; actor has ADMIN/MAINTAIN. Exactly one type label: `type:feature`; human-authorized `size:exception` documents the cohesive A–E rationale.

## Evidencias

[CP-RUT-003/004/005/006/008/009/010 y CP-SEG-004/008](../issue-12-verification.md). Fuentes: Issue/adenda y criterios académicos aportados; Drive explícitamente excluido. Fallos anteriores retenidos y distinguibles del verde actual. La recuperación usa dependencias propias y un shim temporal fail-closed con los mismos argumentos/comandos locales; no elimina pruebas, migraciones/verify ni thresholds, evita reinstalaciones concurrentes. Artefactos temporales no se incluyen en el PR. Sanear logs de fixtures antes de adjuntar remotamente. CI alojada no ejecutada todavía.

## Impacto técnico

**API / Contratos:** nuevos endpoints ADMIN `/api/v1/dispatch/{inbox,orders/:id/proposal,interventions,audit}`; actor nunca desde body, acciones estrictas. APIs anteriores conservadas; Issue13 puede consumir persistencia futura, sin eventos precommit.

**Base de datos / Migraciones:** auditoría y guards; última huella `eb8ebd14b89f17eea5458cd12220be7bd572fa8f0e3771b68d2089c880e18f83`. Edge real con CHECK instala guards que el self-edge anterior puede omitir. Ninguna migración/snapshot anterior al baseline reescrita. Precheck fail-closed ante histórico incoherente, sin fabricar acuerdos; revisar datos/backup antes de desplegar.

**Seguridad y permisos:** JWT/ADMIN persistido, aislamiento de contacto/contexto en dispatch, auditoría inmutable, replay exacto, conflictos/rollback sin incrementar decisiones aceptadas.

**Compatibilidad con otros componentes:** planner/claims/ejecución/historial/disponibilidad/retorno reutilizados; rutas iniciadas congeladas y conductor retenido hasta regreso. Sin frontend ni dependencias nuevas del padre.

**Limitaciones conocidas:** fingerprint no reserva; disponibilidad revalidada; MOVE/reprogramación prestart no dejan rutas vacías inválidas. Advisory preexistente del password DTO ADMIN de rutas fuera de dispatch sigue registrado, no corregido silenciosamente. Revisión humana/CI remoto/entrega pendientes. RDD previamente off clone_local, sin cambios ni aprobación nativa. Commit E/push/PR autorizados; merge/cierre de Issue no autorizados.

## Checklist de entrega

- [x] Cumplí los criterios funcionales de aceptación con prueba propia e independiente.
- [x] Implementé únicamente los cambios necesarios.
- [x] Ejecuté las pruebas correspondientes.
- [x] Verifiqué compilación.
- [x] Comprobé errores/excepciones.
- [x] Actualicé documentación.
- [x] No incluí credenciales ni información sensible en artefactos de entrega.
- [x] Registré evidencia local.
- [ ] Solicité revisión a otro integrante (agente no equivale a revisión humana).

## Observaciones para el revisor

Tipo propuesto `type:feature`, no aplicado. Justificación size:exception L5: A→E coherentes, migraciones/snapshots oficiales inseparables y pruebas reales; sin múltiples PRs ni exclusiones artificiales. No autorización de label protegido o RDD. Revisar authored/locks/JWT primero, SQL/prechecks después, consistencia de generados al final.

Commits A–D `b508930`, `a0131cf`, `d325eb8`, `a0531f4`; E autorizado y agregado en esta entrega. Un único PR, referencia no cerrante `Refs #12`. No merge ni cierre de Issue.
