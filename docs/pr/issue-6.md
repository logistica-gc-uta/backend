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

**Limitaciones conocidas:** Optimización de rutas (#7), ciclo de vida de rutas (#10), despliegue y datos de geolocalización fuera de alcance. Local ShellCheck now passes after scoped trap-callback annotations (details below); bash -n passes. Native review is approved and acknowledged. Remote CI, external PR review and integration remain pending; the Issue is not declared closed.

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

Local implementation commit: `26c3cbb9461a0485ce62f34ba2448df78d3c5416`, based on `main` at `c0f97a4`. Independent local verification passed 178 unit tests, 54 PostgreSQL E2E tests and Newman 67 requests / 270 assertions. Historical native high-risk review awaited candidate-specific consent; that review is now formally approved and acknowledged as recorded below. No published PR, Actions result or merge is claimed. The 1,091-line coherent unit needs explicit maintainer size acceptance before publication. Authenticated GitHub operations also await an explicitly selected credential/session; local auth status is active, but no session has been selected for authenticated repository operations.

Revisar primero el acotamiento de identidad en DriversService y la proyección. Comprobar después el filtro de día local, orden NULL/ties y pruebas de aislamiento. Mantener código, pruebas y documentación en una unidad de trabajo coherente; el presupuesto orientativo de 400 líneas no justifica separar las pruebas de su comportamiento. No se asume una excepción de tamaño ni aprobación de entrega.


**Current native closure:** `review-834be02c3c944914` formally approved and acknowledged target `sha256:84f128b4898a63ef8663a92f38bfa6b631fec30875b8aa000ef5d5414e0f35b3`, consumed revision `sha256:0069c0ac71bc3ad0b64072cf338f5243b7f45f19ebda557798dd363733c73519`, authority burned. Earlier pending-consent statements are historical. Do not restart this review or issue trailing STATUS. Non-blocking native `R3-001` (Docker inspect errors versus confirmed absence) remains later work; no runtime cleanup fix is included.

**D4 local ShellCheck unit:** Delegated mechanical annotations extend only the two existing function-scoped `SC2317` directives with `SC2329`, citing indirect trap invocation and the [official rule guidance](https://www.shellcheck.net/wiki/SC2329). Verified ShellCheck 0.11.0 command `shellcheck test/run-newman-isolated.sh` (private verified binary) observed RED exit 1 with only two SC2329 trap-callback findings, then GREEN exit 0. `bash -n test/run-newman-isolated.sh` and `git diff --check` exit 0. Removing comment lines yields identical runtime code; flags, workflow and global lint settings are unchanged. Parent commit and native assessment remain pending. No full build/Jest/Newman/PostgreSQL rerun was necessary for comments-only changes; 178 unit tests, 54 E2E tests and 67 requests / 270 assertions remain previously executed proof, not fresh results.

**Delivery remains pending:** Public [Issue #6](https://github.com/logistica-gc-uta/backend/issues/6) functional criteria have local passing evidence; remote CI, published PR/external review and integration are not complete. Maintainer size acceptance remains unresolved. Local GitHub auth status is active, but no credential/session is selected for authenticated repository operations; public protection lookup returned 401, so protections remain unknown. No remote operation is included. The branch remains main-based and independent of Issue #9 commits.
