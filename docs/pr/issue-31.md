## Descripción

Endurece el registro público y completa el contrato actualizado de autenticación sin alterar el login de ADMIN, CLIENT y DRIVER.

## Issue relacionado

Refs #31

## Cambios realizados

- Registro estricto `{name,email,password}`: nombre trim 2..120, email válido normalizado y password 8..128; rechaza cualquier atributo adicional y asigna CLIENT desde el servidor.
- Respuestas allowlist y errores `VALIDATION_ERROR`, `EMAIL_ALREADY_EXISTS`, `INVALID_CREDENTIALS`, conservando los campos Nest y el shape de login.
- Manejo del índice único real durante registros concurrentes. Login compatible con email mixto legado; colisiones ambiguas fallan cerrado.
- Hash nuevo `bcrypt-sha256:v1:` (SHA-256 del password UTF-8 completo seguido de bcrypt cost 10), sin truncamiento de passwords largos. Las cuentas con bcrypt legado siguen usando su verificación anterior, sin migración.
- Proyecciones seguras de usuario/conductor y Swagger actualizado. No modifica guards, secretos JWT, base de desarrollo, dependencias ni esquema.

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | PASS; solo warning preexistente de `route-start.e2e-spec.ts` | oxlint type-aware |
| Pruebas unitarias | 53 suites / 709 pruebas PASS | Jest `--roots src test --runInBand` |
| Pruebas de integración | 35/35 PASS contra PostgreSQL desechable | `test/issue31-auth.e2e-spec.ts` |
| Compilación | PASS | `nest build` |
| Pruebas funcionales | API HTTP real: roles, asignación masiva, límites, secretos, carreras y JWT | E2E existente extendido |
| Revisión independiente acotada | PASS: 33 unitarias y 35 E2E; bloqueantes resueltos | Copia aislada, sin `.env`, dependencias propias |
| CI remoto | Pendiente al abrir este PR | GitHub Actions |

No se repitió localmente el manifiesto E2E completo ni Newman: CI los ejecuta. No se modificaron scripts shell; shellcheck específico N/A. No se ejecutaron React ni Flutter.

## Evidencias

`docs/issue-31-auth.md` describe el alcance, comandos, resultados, RED/GREEN, comparación con comportamiento legado y recheck independiente. `odd/tasks/31-auth-client-only-registration.md` conserva el historial y requisitos actualizados.

## Impacto técnico

**API / Contratos:** cambios intencionales: registro ya no acepta `role`, mínimo password pasa de 6 a 8 para cuentas nuevas y se añaden límites/normalización/códigos de error. Login conserva `{access_token,user:{id,name,email,role}}`. Payloads ADMIN de usuarios/conductores no devuelven `password`.

**Base de datos / Migraciones:** sin migración ni saneamiento de datos históricos. El formato versionado usa la columna de texto existente; bcrypt legado sigue válido.

**Seguridad y permisos:** prueba fuerza ambos INSERT reales tras sus preconsultas y obtiene 201+409 con una sola cuenta CLIENT; verifica anónimo 401 y JWT ADMIN que pierde permiso tras downgrade del rol en DB.

**Compatibilidad con otros componentes:** no se cambian APIs logísticas. Frontend #20 debe omitir `role` al registrar y admitir CLIENT únicamente en Shop, sin abrir el panel ADMIN. Esa integración requiere coordinación humana; no se afirma ejecutada.

**Limitaciones conocidas:** emails históricos que colisionen al ignorar mayúsculas bloquean login; no se inspeccionó ni migró la base compartida. Bcrypt legado conserva su límite histórico de 72 bytes. La consulta `lower(email)` no tiene índice funcional. Los endpoints Shop ADMIN/Cloudinary ausentes en esta rama pertenecen a #32: no se presenta un 404 como prueba de permisos. Revisión humana y CI pendientes.

## Checklist de entrega

- [x] Implementé el alcance de autenticación actualizado y documenté dependencias de integración.
- [x] Implementé únicamente cambios de #31.
- [x] Ejecuté las pruebas necesarias del código afectado.
- [x] Verifiqué compilación.
- [x] Comprobé errores y concurrencia de email con PostgreSQL real.
- [x] Actualicé Swagger y documentación.
- [x] Excluí credenciales y cambios ajenos.
- [x] Adjunté evidencia local e independiente.
- [ ] CI remoto verde.
- [ ] Revisión humana de otro integrante.
- [ ] Coordinación/validación integrada con frontend #20 y endpoints Shop de #32.

## Observaciones para el revisor

Revisar el versionado de hashes, la compatibilidad de cuentas legadas, el mapeo del unique error y las allowlists. GGA local bloqueó el commit por `AGENTS.md` inexistente: el usuario autorizó explícitamente `--no-verify` solo para esta entrega, sin desactivar el hook permanentemente. No hay merge automático.
