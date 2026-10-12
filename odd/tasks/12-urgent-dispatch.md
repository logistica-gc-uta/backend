# Issue 12 — Urgent dispatch and ADMIN intervention
Branch: `feat/12-urgent-dispatch`; baseline: `c740ad4503167996020c2ae314c7e0fb03a3bed6`. Local commits only; RDD deferred until functional checks; one final main PR when authorized (feature-branch-chain clarification L5), justified size exception if applicable.
Runner: repository Jest and isolated PostgreSQL E2E runners. Forecast: >400 authored lines; cohesive A→E work units, no scope compression.

## Specs
S1 — "Implementar detección y consulta administrativa de urgencias del mismo día, respetando `America/Guayaquil`." "Evaluar inserción exclusivamente en rutas `DRAFT` o `ASSIGNED`, nunca en `IN_PROGRESS` o `COMPLETED`." "Validar capacidad máxima de cuatro pedidos, zona, fecha, coordenadas, orden y elegibilidad." "Reutilizar Haversine, Clarke & Wright y las políticas existentes." "La propuesta no debe modificar persistencia hasta que ADMIN la confirme." "Si no hay ruta compatible, proponer nueva salida; comprobar disponibilidad real del conductor antes de asignarla." "Si no existe una alternativa válida, conservar el pedido `PENDING` y exponer motivo/alerta."
S2 — "Consultar la bandeja de urgencias e incidencias." "Aprobar/rechazar propuestas." "Confirmar nuevas rutas." "Insertar, reajustar o reasignar antes del inicio." "Priorizar o reprogramar pedidos con validaciones." "Registrar actor JWT, instante, pedido/ruta, acción, motivo y resultado. No aceptar identidades de actores desde el body." "Las operaciones deben respetar los invariantes centrales de ruta; evitar duplicar reglas en varios servicios."
S3 — "Reutilizar el mecanismo existente de `DeliveryAttempt` y `RouteStop`." "DRIVER registra ausencia/rechazo mediante los endpoints existentes." "ADMIN consulta la incidencia con permisos estrictos." "Registrar la gestión y el acuerdo de nueva fecha/franja." "Sin acuerdo explícito, no autorizar reprogramación ni nueva asignación." "No convertir automáticamente fallos en `DELIVERED`, `CANCELLED` o `PENDING`." "Preservar la identidad comercial del pedido, intentos anteriores y paradas históricas." "Al asignar a R2, R1 debe conservar íntegros sus registros y secuencia." "Respetar confirmación de retorno al depósito antes de reutilizar un conductor."
S4 — "Dos inserciones simultáneas al último cupo." "Asignación concurrente de pedido o conductor." "Confirmación duplicada de una propuesta." "Reprogramación repetida y conflictos de idempotencia." "Rollback completo ante fallos." "Rechazo de modificación estructural de rutas iniciadas, incluso por ADMIN." "Autorización JWT/RBAC e aislamiento de información sensible." "Utilizar las restricciones, claims, locks y transacciones existentes antes de proponer nuevos mecanismos."
S5 — "CP-RUT-003/004/005/006/008/009/010." "CP-SEG-004 y CP-SEG-008." "Casos negativos, permisos, histórico, rollback y concurrencia PostgreSQL." "OpenAPI/Swagger y compatibilidad con endpoints anteriores." "Actualizar la documentación técnica, trazabilidad, riesgos y evidencia de pruebas." "No implementar Socket.IO, React ni Flutter en esta Issue. Solo preparar contratos compatibles con la Issue #13."
S6 — "CP-RUT-003: urgencia en ruta ASSIGNED con tres pedidos; permitir una cuarta parada con secuencia recalculada antes del inicio."
S7 — "CP-RUT-004: si no hay capacidad en rutas elegibles, proponer una nueva salida sin modificar las iniciadas."
S8 — "CP-RUT-005: ADMIN puede reasignar pedidos o conductor únicamente antes del inicio, respetando capacidad, zona, fecha y auditoría."
S9 — "CP-RUT-006: asignaciones simultáneas al último cupo no deben duplicar pedidos ni exceder cuatro paradas."
S10 — "CP-RUT-008: IN_PROGRESS es inmutable en composición y orden, incluso para ADMIN."
S11 — "CP-RUT-009: sin ruta o conductor disponible, conservar PENDING y exponer causa de bloqueo."
S12 — "CP-RUT-010: intervención administrativa con actor, instante, motivo, acción y resultado persistidos."
S13 — "CP-SEG-004: entrega fallida por ausencia/rechazo; no marcar automáticamente DELIVERED/CANCELLED ni reprogramar sin acuerdo."
S14 — "CP-SEG-008: reprogramar el mismo pedido en R2 preservando íntegramente las paradas e intentos históricos de R1."
S15 — "No fabriques aprobaciones ni desactives RDD por cuenta propia. Si el mecanismo nativo exige una aprobación para una operación concreta, reporta el bloqueo sin descartar el trabajo realizado." "No hagas push, merge, cambios remotos ni cierres la Issue sin autorización posterior. Los commits locales deben respetar los gates obligatorios del proyecto."

## Tasks
T0 | S1-S15 | inline coordination + delegated read-only map (evidence budget) | done | main/dependencies verified; source clarification reconciled; map received; tracking setup (no code commit)
T1 A | S1,S6,S7,S11 | inline (dependent units; no parallel writer reason) | done | RED exit1, GREEN 13/13, tsc/lint exit0; commit b508930
T2 B | S2,S8,S10,S12 | inline | done | RED 404, GREEN 5 PostgreSQL HTTP cases; 37 unit/assignment tests; tsc/lint exit0; commit a0131cf
T3 C | S3,S13,S14 | inline | in_progress | explicit persisted agreement, historical retry; commit none
T4 D | S4,S9,S10,S15 | inline | pending | commit none
T5 E | S5,S6-S15 | inline checks + independent verify (security/concurrency) | pending | commit none

## Log
L1 — Original request (verbatim)
# Implementación Issue #12 — Urgencias e intervención manual ADMIN

Proyecto: `logistica-gc-uta/backend`

Issue: https://github.com/logistica-gc-uta/backend/issues/12

## Objetivo

Implementar completamente la Issue #12 conforme a sus criterios de aceptación, adenda del 09/10/2026 y documentación oficial del proyecto.

**Restricción de recursos:** queda aproximadamente el 30 % de la cuota de Codex. Optimiza las lecturas, delegaciones, pruebas y contexto sin reducir seguridad, cobertura relevante ni calidad.

## 1. Preparación

- Verifica estado de Git y la última versión de `main`.
- Confirma que las Issues #7, #9, #10 y #11 están integradas.
- Crea una rama independiente `feat/12-urgent-dispatch` desde `main`, sin alterar otros worktrees.
- Consulta la Issue #12 y los requisitos RF-EXP-05/09, RF-DEC-07/12/14, RF-TEC-04/05.
- Revisa los casos CP-RUT-003/004/005/006/008/009/010, CP-SEG-004/008 del Catálogo v2.0.
- Utiliza el SRS v2.0, Plan Maestro y Plan de Pruebas de Google Drive, carpeta `ProyectoGestionPruebas6A`.

No explores indiscriminadamente el repositorio. Inspecciona primero los servicios existentes de planificación, asignación, progreso, historial, disponibilidad y retorno al depósito.

## 2. Implementación por unidades

### Unidad A — Urgencias y propuestas

Implementar detección y consulta administrativa de urgencias del mismo día, respetando `America/Guayaquil`.

- Evaluar inserción exclusivamente en rutas `DRAFT` o `ASSIGNED`, nunca en `IN_PROGRESS` o `COMPLETED`.
- Validar capacidad máxima de cuatro pedidos, zona, fecha, coordenadas, orden y elegibilidad.
- Reutilizar Haversine, Clarke & Wright y las políticas existentes.
- La propuesta no debe modificar persistencia hasta que ADMIN la confirme.
- Si no hay ruta compatible, proponer nueva salida; comprobar disponibilidad real del conductor antes de asignarla.
- Si no existe una alternativa válida, conservar el pedido `PENDING` y exponer motivo/alerta.

### Unidad B — Intervención administrativa

Implementar endpoints ADMIN para:

- Consultar la bandeja de urgencias e incidencias.
- Aprobar/rechazar propuestas.
- Confirmar nuevas rutas.
- Insertar, reajustar o reasignar antes del inicio.
- Priorizar o reprogramar pedidos con validaciones.

Registrar actor JWT, instante, pedido/ruta, acción, motivo y resultado. No aceptar identidades de actores desde el body.

Las operaciones deben respetar los invariantes centrales de ruta; evitar duplicar reglas en varios servicios.

### Unidad C — Entrega fallida y reprogramación

Reutilizar el mecanismo existente de `DeliveryAttempt` y `RouteStop`.

- DRIVER registra ausencia/rechazo mediante los endpoints existentes.
- ADMIN consulta la incidencia con permisos estrictos.
- Registrar la gestión y el acuerdo de nueva fecha/franja.
- Sin acuerdo explícito, no autorizar reprogramación ni nueva asignación.
- No convertir automáticamente fallos en `DELIVERED`, `CANCELLED` o `PENDING`.
- Preservar la identidad comercial del pedido, intentos anteriores y paradas históricas.
- Al asignar a R2, R1 debe conservar íntegros sus registros y secuencia.
- Respetar confirmación de retorno al depósito antes de reutilizar un conductor.

### Unidad D — Concurrencia y seguridad

Garantizar operaciones atómicas en PostgreSQL:

- Dos inserciones simultáneas al último cupo.
- Asignación concurrente de pedido o conductor.
- Confirmación duplicada de una propuesta.
- Reprogramación repetida y conflictos de idempotencia.
- Rollback completo ante fallos.
- Rechazo de modificación estructural de rutas iniciadas, incluso por ADMIN.
- Autorización JWT/RBAC e aislamiento de información sensible.

Utilizar las restricciones, claims, locks y transacciones existentes antes de proponer nuevos mecanismos.

### Unidad E — Verificación y documentación

Verificar con pruebas reales:

- CP-RUT-003/004/005/006/008/009/010.
- CP-SEG-004 y CP-SEG-008.
- Casos negativos, permisos, histórico, rollback y concurrencia PostgreSQL.
- OpenAPI/Swagger y compatibilidad con endpoints anteriores.

Actualizar la documentación técnica, trazabilidad, riesgos y evidencia de pruebas.

No implementar Socket.IO, React ni Flutter en esta Issue. Solo preparar contratos compatibles con la Issue #13.

## 3. Política de eficiencia de tokens

1. Aplica `Gentle-AI`, las skills instaladas y `work-unit-commits` cuando corresponda, sin incumplir sus requisitos.
2. Usa un único agente escritor por unidad. Evita análisis duplicados y múltiples revisores simultáneos del mismo código.
3. Implementa cambios mínimos, reutilizando los componentes existentes.
4. Ejecuta pruebas enfocadas durante el desarrollo y pruebas integrales al cierre.
5. Conserva logs completos localmente y presenta solo resúmenes y errores relevantes.
6. No repitas pruebas verdes si no cambiaron sus dependencias, salvo verificación final necesaria.
7. No regeneres artefactos Prisma 8 ni crees migraciones salvo que realmente cambie el esquema.
8. Si se requiere migración, utiliza exclusivamente el CLI oficial y preserva historial y hashes anteriores.
9. No reduzcas aserciones, cobertura, controles de seguridad o escenarios de concurrencia para ahorrar tokens.
10. Mantén un registro compacto de avances y decisiones para evitar reconstruir el contexto.

## 4. RDD y autorizaciones

Difiere RDD hasta finalizar la implementación y verificación funcional, de acuerdo con el procedimiento acordado.

No fabriques aprobaciones ni desactives RDD por cuenta propia. Si el mecanismo nativo exige una aprobación para una operación concreta, reporta el bloqueo sin descartar el trabajo realizado.

Puedes implementar, modificar y verificar el código dentro de la rama autorizada. No hagas push, merge, cambios remotos ni cierres la Issue sin autorización posterior. Los commits locales deben respetar los gates obligatorios del proyecto.

## 5. Ejecución

Trabaja autónomamente, siguiendo las dependencias A → B → C → D → E.

No solicites confirmación por cada paso ordinario. Solo detente ante decisiones de negocio no resueltas, operaciones no autorizadas o bloqueos técnicos reales.

Al terminar presenta un único informe consolidado con:

- Funcionalidades implementadas y archivos relevantes.
- Matriz de criterios de aceptación de la Issue #12.
- Pruebas ejecutadas y resultados reales.
- Riesgos o limitaciones pendientes.
- Estado Git/RDD.
- Preparación para PR y autorización necesaria.

**Prioridad: finalizar una implementación correcta con el menor consumo razonable de tokens, sin sacrificar integridad, seguridad ni trazabilidad.**

L2 — User clarification (verbatim)
# Aclaración de fuentes — Issue #12

Codex no tiene acceso a Google Drive. Ignora la instrucción anterior de consultar directamente la carpeta `ProyectoGestionPruebas6A`.

**No detengas la implementación por esta limitación.**

Utiliza como fuentes principales:

- GitHub Issue #12 y su adenda del 09/10/2026.
- Código y documentación existentes del repositorio.
- Contratos implementados en las Issues #7, #9, #10 y #11.

Ya revisé los documentos académicos. Los criterios adicionales que debes preservar son:

**CP-RUT-003:** urgencia en ruta ASSIGNED con tres pedidos; permitir una cuarta parada con secuencia recalculada antes del inicio.

**CP-RUT-004:** si no hay capacidad en rutas elegibles, proponer una nueva salida sin modificar las iniciadas.

**CP-RUT-005:** ADMIN puede reasignar pedidos o conductor únicamente antes del inicio, respetando capacidad, zona, fecha y auditoría.

**CP-RUT-006:** asignaciones simultáneas al último cupo no deben duplicar pedidos ni exceder cuatro paradas.

**CP-RUT-008:** IN_PROGRESS es inmutable en composición y orden, incluso para ADMIN.

**CP-RUT-009:** sin ruta o conductor disponible, conservar PENDING y exponer causa de bloqueo.

**CP-RUT-010:** intervención administrativa con actor, instante, motivo, acción y resultado persistidos.

**CP-SEG-004:** entrega fallida por ausencia/rechazo; no marcar automáticamente DELIVERED/CANCELLED ni reprogramar sin acuerdo.

**CP-SEG-008:** reprogramar el mismo pedido en R2 preservando íntegramente las paradas e intentos históricos de R1.

Estas condiciones provienen del Catálogo de Casos v2.0 y del SRS v2.0.

No inventes requisitos que no estén definidos. Si aparece una ambigüedad de negocio imprescindible, consúltala.

Continúa con el plan de implementación ya recibido. No vuelvas a explorar documentos inaccesibles ni repitas trabajo completado.

Mantén la optimización de tokens y la prohibición de push/merge sin autorización.

L3 — Preparation evidence: fetched main == origin/main c740ad4; merged PR24/25 (#7), PR21 (#9), PR22 (#10), PR26 (#11). Branch created. Pre-existing untracked docs/pr/issue-11.md untouched. Issue12 body/adenda read. Drive requirement superseded by L2.
L4 — Map received: existing planner/assignment/availability/history/return reused. PostgreSQL and Docker available. Existing gates: CI lint/build/coverage/isolated E2E/Newman, no core.hooksPath. A stays read-only; B requires a genuine schema addition for durable ADMIN audit/idempotency. Existing SQL only permits DRAFT claim removal and completed physical-return reservation release; audited pre-start reassignment requires a new official-CLI migration, never editing old hashes. C requires audit-authorized clearing of the failure review hold. Security/concurrency risk items 1/2/4; one independent feature verifier after own checks. No writer duplication; dependent units remain inline.

L5 — User delivery clarification (verbatim)
# Issue #12 — Política de tamaño ya acordada

Selecciono «Cadena sobre rama de funcionalidad».

Esta decisión no autoriza múltiples PR ni fragmentación artificial.

**Política global del proyecto:**

1. No utilizar 400 líneas como límite máximo obligatorio de implementación.
2. Autorizar unidades de trabajo extensas cuando su complejidad técnica lo justifique.
3. Mantener A → E como commits locales coherentes dentro de `feat/12-urgent-dispatch`.
4. Conservar la atomicidad de migraciones Prisma, snapshots y pruebas.
5. Preparar un único PR final hacia `main`, cuando lo autorice.
6. Aplicar el procedimiento `size:exception` ya utilizado en las Issues #10 y #11 si corresponde, documentando la justificación.
7. Diferir la revisión RDD hasta terminar la implementación y las pruebas.
8. No confundir `size:exception` con una aprobación RDD ni desactivar los controles sin autorización específica.
9. No volver a interrumpir el desarrollo por el umbral artificial de 400 líneas. Si existe un bloqueo técnico obligatorio, informar el impedimento exacto.
10. No hacer push, crear PR ni merge sin autorización.

La prioridad es completar correctamente la Issue #12 y minimizar consultas repetitivas que consumen la cuota de Codex.

Continúa con la implementación.

L6 — A RED exit1 (missing module); GREEN exit0, 13/13 tests. TypeScript exit0; focused lint exit0 (one mapped-DTO spread warning corrected); diff check exit0. No active local Git hooks. One final PR scope, no line-size hard cap. Independent feature verification and PostgreSQL checks remain scheduled for E.

L7 — B: official CLI emitted genuine audit schema b1646787 from e357d1aa, planned 8 schema operations plus reviewed custom audit guard operation. Initial HTTP GREEN exposed DTO own undefined fields (400); exact defined-field validation corrected, 5 HTTP cases passed. Installed rawSql target requires objectType table, confirmed against installed types; tsc/lint exit0. Priority RED/GREEN captured; 37 unit tests passed. Migration hashes of previously committed files remain untouched. RDD remains deferred.

L8 — C: corrected public-projection assertion before observed CONTACT RED (400). SQL-only CLI migration initially blocked on true no-op self-edge; diagnosed on an owned DB, added a genuine fail-closed failure-hold invariant through official dataTransform/self-emit (no previous hashes touched). Initial GREEN exposed nanosecond-vs-PostgreSQL-microsecond fixture precision; corrected fixture precision. Absence/refusal 2/2 scenarios pass, including no agreement/started R1 rejection, exact replay/consumed agreement, R1 stops+attempts equality, return-before-driver reuse and same order on R2. The 5 unchanged B cases also passed in the preceding integrated run. tsc/lint exit0.
