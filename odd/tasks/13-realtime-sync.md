# Issue 13 — Realtime synchronization
Branch: `feat/13-realtime-sync`; updated main baseline `232126c3588f8b2606d0e0d70088c6ea5a37157d`. Local commits only; RDD off unchanged; no other worktrees/shared DB.
Delivery: one feature branch, no artificial 400-line split; forecast >400 authored lines, generated files excluded. Parallel writers only after frozen interface, disjoint surfaces; no remote delivery authorized.

## Specs
S1 — "Partir de `main` actualizado y trabajar únicamente en `feat/13-realtime-sync`. No crear subramas."
S2 — "Implementar Gateway Socket.IO con autenticación JWT y autorización por rol y propiedad de recursos."
S3 — "Emitir `order.status.updated` y eventos de rutas/incidencias cuando corresponda, **solo después del commit exitoso en PostgreSQL**. Nunca emitir si la transacción falla."
S4 — "Reflejar entregas, intentos fallidos, intervención ADMIN, reprogramaciones y disponibilidad del conductor únicamente después del regreso confirmado al depósito." Source adenda and approved contract clarify ONLY driver availability waits for depot return; other updates wait for their own successful commit.
S5 — "Definir eventos versionados, payloads mínimos y salas autorizadas. No exponer credenciales, contactos privados ni datos de otros usuarios."
S6 — "Implementar manejo de desconexión/reconexión: los clientes deben recuperar el estado real mediante REST GET."
S7 — "Documentar contratos para React/Flutter, CORS y funcionamiento con Cloudflare Tunnel. No implementar GPS continuo ni ETA vial."
S8 — "Cubrir CP-SEG-002/006/007"; "Evento emitido tras persistencia exitosa." "Ningún evento ante rollback o transición rechazada." "Conexiones sin JWT, roles incorrectos y acceso a recursos ajenos." "Desconexión, reconexión y recuperación REST." "Integración real con PostgreSQL y cliente Socket.IO de prueba."
S9 — "Ejecutar pruebas enfocadas durante el desarrollo y regresión completa al finalizar. No declarar integración React/Flutter verificada sin ejecutarla realmente."
S10 — "Optimizar consumo de tokens: no repetir exploraciones ni mostrar logs completos." "Reutilizar servicios y políticas existentes; evitar refactorizaciones ajenas." "Una rama, commits locales coherentes, sin fragmentación artificial por 400 líneas." "Mantener las reglas de Gentle-AI/RDD, sin desactivar controles ni inventar aprobaciones." "No modificar bases compartidas ni otros worktrees." "No hacer push, crear PR ni merge sin autorización."
S11 — User-approved protocol preview (verbatim):
**Eventos:** `order.status.updated`, `route.updated`, `dispatch.incident.updated`, `driver.availability.updated`.

**Sobre común:** `version: 1`, `eventId`, `occurredAt`, `data` mínimo.

**Destinatarios:** order → ADMIN, CLIENT dueño, DRIVER actualmente asignado; route → ADMIN y DRIVER asignado; incidencias/CONTACT/RESCHEDULE → ADMIN; disponibilidad → ADMIN y el conductor, únicamente tras regreso confirmado.

Sin credenciales, contactos, conversaciones ni motivos libres. CLIENT recibe cambios de su pedido, no resultados privados de gestión. Salas autorizadas y permisos revalidados antes de publicar.

Reconectar → autenticar de nuevo, suscribirse con autorización y consultar REST GET. Sin garantía de replay/offline; sin GPS/ETA.

## Tasks
T0 | S1,S5,S10,S11 | inline baseline/dependency/protocol setup | in_progress | dependenciesinstall0+imports/typecheck plannedobserved; token REALTIME_PUBLISHER and RealtimePublisher.publish frozen; docsprotocol; localcommitnext
T1 | S2,S5,S6,S7,S11 | delegated gateway/security/publisher unit (parallel reason: disjoint independent unit after frozen interface) | pending | gateway module/own unit tests/CORS docs; no mutation-service edits
T2 | S3,S4,S5,S11 | delegated postcommit mutation hooks unit (parallel disjoint unit) | pending | existing business services/own unit tests/transaction docs; no gateway edits
T3 | S2-S9,S11 | inline seam + actual owned PostgreSQL/Socket.IO E2E | pending | public transport, commit/rollback/privacy/reconnect/return proof; preserve baseline cases
T4 | S7-S10 | inline regression orchestration + independent high-risk verifier | pending | all functional gates/coverage, whole-S verdict, docs/matrix and local commit, no remote publishing

## Log
L1 — Original user request (verbatim)
`ya es realizo merge del PR ahora realizemos el issue 13 `
# Implementar Issue #13 — Socket.IO y resincronización

Repositorio: `logistica-gc-uta/backend`
Issue: https://github.com/logistica-gc-uta/backend/issues/13

Implementa completamente la Issue #13 conforme a sus criterios de aceptación y adenda, reutilizando las funcionalidades existentes de las Issues #8, #10 y #12.

## Implementación

1. Partir de `main` actualizado y trabajar únicamente en `feat/13-realtime-sync`. No crear subramas.
2. Implementar Gateway Socket.IO con autenticación JWT y autorización por rol y propiedad de recursos.
3. Emitir `order.status.updated` y eventos de rutas/incidencias cuando corresponda, **solo después del commit exitoso en PostgreSQL**. Nunca emitir si la transacción falla.
4. Reflejar entregas, intentos fallidos, intervención ADMIN, reprogramaciones y disponibilidad del conductor únicamente después del regreso confirmado al depósito.
5. Definir eventos versionados, payloads mínimos y salas autorizadas. No exponer credenciales, contactos privados ni datos de otros usuarios.
6. Implementar manejo de desconexión/reconexión: los clientes deben recuperar el estado real mediante REST GET.
7. Documentar contratos para React/Flutter, CORS y funcionamiento con Cloudflare Tunnel. No implementar GPS continuo ni ETA vial.

## Pruebas obligatorias

Cubrir CP-SEG-002/006/007, incluyendo:
- Evento emitido tras persistencia exitosa.
- Ningún evento ante rollback o transición rechazada.
- Conexiones sin JWT, roles incorrectos y acceso a recursos ajenos.
- Desconexión, reconexión y recuperación REST.
- Integración real con PostgreSQL y cliente Socket.IO de prueba.

Ejecutar pruebas enfocadas durante el desarrollo y regresión completa al finalizar. No declarar integración React/Flutter verificada sin ejecutarla realmente.

## Eficiencia y restricciones

- Optimizar consumo de tokens: no repetir exploraciones ni mostrar logs completos.
- Reutilizar servicios y políticas existentes; evitar refactorizaciones ajenas.
- Una rama, commits locales coherentes, sin fragmentación artificial por 400 líneas.
- Mantener las reglas de Gentle-AI/RDD, sin desactivar controles ni inventar aprobaciones.
- No modificar bases compartidas ni otros worktrees.
- No hacer push, crear PR ni merge sin autorización.

Trabaja autónomamente hasta completar implementación, pruebas y documentación. Al finalizar entrega una matriz breve de aceptación, resultados reales, riesgos y estado Git/RDD.

Detente solamente ante bloqueos técnicos reales o decisiones de negocio imprescindibles.

L2 — Human selected "Aprobar contrato mínimo y aislado (recomendado)" with S11 preview verbatim. Explorer mv62sjj6-1-5ni3 read-only map: current DB role JwtStrategy; orders own CLIENT/current assigned DRIVER; outer transaction promises must resolve before publish; return alone releases driver reservation. Roles.guard HTTP-only not directly WS. Source13/adenda stored reports/issue13-source.json. Socket.IO/Nest primary documentation via Context7 supports namespace middleware and no offline exactly-once guarantee.
L3 — PR27 merge observed232126c35; main fetchedsame, feature13 created/unsetoriginmainupstream. Pre-existing human.gitignore/ownedIssue12ledger WIP/untrackedissue11draft and ignorediso12 retained byte-preserved, excluded13commits. No other worktree or ambient DB modified. RDDoff existing unchanged. High-risk security/shared business hooks/concurrency/dependency setup; independent verifier after own checks required. Source React-connected criterion is not falsely verified by Nodeclient; frontend integration remains explicitly unexecuted/out-of-backend-scope.

L4 — Frozen internal seam src/modules/realtime/realtime.contract.ts: REALTIME_PUBLISHER string DI token, RealtimePublisher.publish(readonlyRealtimeChange[]):Promise<void>; optionalDI for isolatedlegacyservice tests, alwayswired byGlobalRealtimeModule in AppModule. Producer awaits outercommit, gatewayprojectswirepayload allowlist/rechecksrecipients, failuresnotreinterpretcommittedRESTfailure. Namespace/realtime,path/socket.io,auth.token,resource.subscribe({resource,id}); order/route/driver UUIDid required,incidentsADMINwithoutid. T0dependencyfoundationno meaningfulbehaviorRED; behaviorunitsmustobserveREDfirst. Dependencies12.0.1Sockets+4.8.4clientinstalled scriptsdisabled/root-ownedstore beforetests. No sharedworktree/DB/RDDchanges. Twoindependentboundedwriterunits readyafterT0commit.

L5 — T0dependency imports4/typecheck/diff0; initialstageddiffcheck2 flagged originalverbatimusertrailing-space. Quote that exactfirstline ininlinecode toretainitscharacterwithoutEOLwhitespace; no behavior/codechange. Commitnotexecutedonfailedcheck; onecorrectedcommitnext.
