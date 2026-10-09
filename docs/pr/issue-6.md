## Descripción

Permite que un repartidor consulte únicamente sus rutas asignadas y sus pedidos ordenados, sin recibir información de otros repartidores ni habilitar cambios de estado.

## Issue relacionado

Refs #6

## Cambios realizados

- Consulta protegida `GET /api/v1/drivers/me/routes` con identidad derivada exclusivamente del JWT validado y proyección mínima de zona/ruta/pedidos.
- Filtro opcional estricto sobre `Route.date`, por día local de `America/Guayaquil`, independiente de la zona horaria del proceso.
- Pruebas unitarias, PostgreSQL real, Newman y documentación OpenAPI; las rutas ADMIN y restricciones de escritura DRIVER se mantienen.

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | Aprobado | Oxlint type-aware sobre src/test, exit 0 |
| Pruebas unitarias | Aprobado | RED observado; 22 suites / 178 pruebas, exit 0. Cobertura global: sentencias 98.21%, ramas 87.54%, funciones 93.54%, líneas 98.23% |
| Pruebas de integración | Aprobado | 3 suites / 54 pruebas E2E con PostgreSQL efímero propio, exit 0 |
| Compilación | Aprobado | Nest build directo, exit 0 |
| Pruebas funcionales | Aprobado | Newman aislado: 67 solicitudes / 270 aserciones, 0 fallos; 59 escenarios previos preservados |

## Evidencias

La evidencia funcional local está disponible en el informe de entrega. La publicación, GitHub Actions y revisión independiente aún no se han realizado; los logs locales no se presentan como evidencia de CI remoto ni como aprobación nativa.

## Impacto técnico

**API / Contratos:** Nuevo endpoint de solo lectura para DRIVER; salida estable `[]` sin perfil o rutas. Campos desconocidos, fechas inválidas/repetidas: 400. JWT faltante/inválido: 401. Otros roles: 403.

**Base de datos / Migraciones:** Sin cambios de esquema ni migraciones. Contrato Prisma 8 existente verificado en base efímera propia.

**Seguridad y permisos:** Consulta acotada al perfil de repartidor resuelto mediante JWT; no se expone User/password ni registros ajenos. Los pedidos asociados se devuelven sin filtrar estados. Las escrituras DRIVER continúan bloqueadas (403).

**Compatibilidad con otros componentes:** Endpoints ADMIN y escenarios de seguridad Newman previos preservados. Node 26/Temporal y dependencias existentes; sin instalaciones.

**Limitaciones conocidas:** Optimización de rutas (#7), ciclo de vida de rutas (#10), despliegue y datos de geolocalización fuera de alcance. Local ShellCheck and bash syntax checks passed after scoped trap-callback annotations (details below). Endpoint and D4 native reviews are separately approved and acknowledged. Remote CI, external PR review and integration remain pending; the Issue is not declared closed.

## Checklist de entrega

- [ ] Cumplí los criterios de aceptación del Issue.
- [x] Implementé únicamente los cambios necesarios.
- [x] Ejecuté las pruebas correspondientes.
- [x] Verifiqué que el código compile correctamente.
- [x] Comprobé los posibles errores y excepciones.
- [x] Actualicé la documentación cuando fue necesario.
- [x] No incluí credenciales ni información sensible.
- [ ] Adjunté evidencia de los resultados.
- [ ] Solicité revisión a otro integrante.

## Observaciones para el revisor

Review the JWT-scoped `DriversService` query and minimal projection first, then local-day boundaries, deterministic NULL/tie ordering and cross-driver isolation tests. Issue #9 commits are not included.

**Delivery boundary:** One final PR from `feat/6-driver-own-routes` to `main`, covering implementation `26c3cbb`, scoped ShellCheck annotations `3a82225` and closure documentation `603c2ba`, plus publication documentation. The repository owner explicitly accepted the oversized single-PR exception for Issues #6 and #9 only. This endpoint, security isolation/date/order handling, real PostgreSQL/Newman regression coverage, Swagger and handoff documentation form one cohesive unit; splitting by file type would separate behavior from its proof. Before this publication-documentation update, the branch contained 1,097 additions and 24 deletions across 15 paths; the final count must be read from the published diff. The 400-line reviewability convention is not a GitHub gate. No nonexistent `size:exception` label is required or claimed.

**Verification:** Previously observed local proof is recorded above, not a fresh runtime rerun for this prose. ShellCheck 0.11.0 initially reported two SC2329 trap-callback findings; function-scoped annotations produced exit 0, with `bash -n` passing and runtime code unchanged. Endpoint and ShellCheck work units each completed separate approved, acknowledged reviews. The non-blocking Docker inspect/daemon cleanup warning `R3-001` remains a follow-up, not a fix included here.

**Publication and integration:** The owner authorized push and PR creation through the selected `Saimol-Uta` session, but not merge. Verified `main` protection requires one approving review; configured required status checks are absent, no applicable rulesets were returned, and administrator enforcement is disabled. Nevertheless, green feature CI and outside approval remain explicit integration requirements: the workflow runs quality checks followed by API tests for PRs targeting `main`. No bypass, self-approval, Actions success, published PR or integration is claimed here. Publication, CI and independent review remain pending; this proposal uses `Refs #6` and does not declare the Issue closed.
