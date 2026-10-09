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

**Limitaciones conocidas:** Optimización de rutas (#7), ciclo de vida de rutas (#10), despliegue y datos de geolocalización fuera de alcance. Shellcheck no disponible localmente; bash -n aprobado. CI remoto, revisión independiente y evaluación nativa pendientes; no se declara el Issue cerrado.

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

Revisar primero el acotamiento de identidad en DriversService y la proyección. Comprobar después el filtro de día local, orden NULL/ties y pruebas de aislamiento. Mantener código, pruebas y documentación en una unidad de trabajo coherente; el presupuesto orientativo de 400 líneas no justifica separar las pruebas de su comportamiento. No se asume una excepción de tamaño ni aprobación de entrega.
