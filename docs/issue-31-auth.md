# Issue #31 — Registro público CLIENT y compatibilidad de autenticación

Especificación vigente: `odd/tasks/31-auth-client-only-registration.md`, T4 y S8–S9. Rama de trabajo: `feat/31-auth-client-only-registration`. Esta actualización conserva las correcciones previas de escalada y proyección de secretos presentes en `37395ea`, `93a156a` y `db4bede`; no modifica guards, realtime, provisión de roles, secretos JWT ni endpoints Shop.

## Compatibilidad y diferencias de contrato

1. **Contraseña de registro:** el DTO anterior aceptaba contraseñas de mínimo 6 caracteres y no fijaba máximo. El contrato S8 exige de 8 a 128 caracteres. Para nuevas cuentas la columna `password` (texto existente) almacena `bcrypt-sha256:v1:<hash bcrypt cost 10>`: el SHA-256 de todos los bytes UTF-8 se codifica como 64 caracteres ASCII hex antes de bcrypt; así un sufijo posterior al byte 72 y Unicode también afectan el resultado. Login reconoce solamente ese marcador/version y compara el prehash; los hashes bcrypt sin marcador de cuentas legadas siguen comparándose con el password crudo, incluso si es corto. Un marcador desconocido o malformado falla 401, sin fallback; no hay rehash oportunista, migración ni cambio de esquema.
2. **Correo de login y cuentas antiguas:** registro/login normalizan el correo de entrada (trim y minúsculas). La búsqueda compara sin distinguir mayúsculas, por lo que un correo legado almacenado con casing mixto sigue funcionando sin migrar sus datos. Si dos filas legadas comparten el mismo correo ignorando casing, login falla cerrado con `401 INVALID_CREDENTIALS`; nunca se selecciona una cuenta arbitrariamente. No se inspeccionó una base de datos del proyecto ni se hizo migración; la presencia de colisiones reales queda por determinar.
3. **Issue frente al contrato legado:** S8 exige errores de autenticación tipados y registro estricto de `{name,email,password}`. Las respuestas anteriores conservaban los campos Nest `statusCode`, `message` y `error`, pero no incluían `code`. La implementación añade `VALIDATION_ERROR`, `INVALID_CREDENTIALS` y `EMAIL_ALREADY_EXISTS` manteniendo esos campos; no cambia el shape de éxito de login.
4. **Adenda CI-SHOP-001 v1.1:** la adenda local especifica errores de Shop, pero no define un envelope integral para errores de autenticación. Se preservan los campos de error Nest ya existentes y se añade el código de máquina solicitado por S8. Recuperación de contraseña y emails siguen fuera de alcance.
5. **Unicidad Prisma:** la implementación anterior solo hacía una preconsulta y no tenía un manejador existente de `P2002`/SQLSTATE para esta ruta. T4 reconoce únicamente errores de unicidad cuyo target identifica email; cualquier otro error se propaga.

## Cobertura S8

| Requisito | Implementación actual | Evidencia enfocada (ejecutada tras L15) |
|---|---|---|
| Registro acepta solo `name`, `email`, `password`; rechaza todo atributo adicional, incluso `role: CLIENT` | Validación auth-local con `whitelist` y `forbidNonWhitelisted`; servicio asigna `Role.CLIENT` incondicionalmente | `src/modules/auth/dto/register.dto.spec.ts`; `test/issue31-auth.e2e-spec.ts` cubre `CLIENT`, `ADMIN`, `DRIVER`, `isAdmin`, `permissions`, `userId`, `createdAt` y un campo desconocido |
| Nombre trim 2..120, email válido normalizado, password 8..128 | `RegisterDto`; datos normalizados también en el servicio | Unit y E2E de límites mínimos/máximos, espacios, email inválido y longitudes fuera de rango |
| Cuenta legado con password corto y email de casing mixto sigue disponible | `LoginDto` conserva validación de password no vacío; lookup case-insensitive limitado a dos coincidencias | Unit y E2E con cuenta mixta y password menor que 8 |
| `CLIENT` solamente, bcrypt-SHA256 versionado, respuesta de registro allowlist | Servicio fija rol, aplica SHA-256 UTF-8 completo + bcrypt cost 10 y proyecta `{id,name,email,role,createdAt}` | Unit y E2E confirman mismo password, sufijo diferente después de byte 72, Unicode, credenciales legadas y ausencia de secretos |
| Duplicados y carrera de unicidad | Preconsulta case-insensitive y mapeo exclusivo de errores únicos de email (`P2002`/`23505` con target de email) a 409; otros errores se propagan | Unit con error de unicidad y error ajeno; E2E instala una barrera solo en test antes de ambos `create`, reenvía ambos INSERT reales a Prisma 8 y comprueba 201+409 y exactamente una fila CLIENT |
| Login mantiene su shape y roles ADMIN/CLIENT/DRIVER; credenciales inválidas tipadas | JWT y guards existentes se conservan; login responde `{access_token,user:{id,name,email,role}}` | Unit/E2E para los tres roles, error 401, secreto ausente, anónimo 401 en rutas reales, 403 tras degradar rol ADMIN en DB con JWT previo y acceso a orden propia |
| Swagger documenta request, allowlists de éxito y errores | DTO explícitos de registro, login y error; respuestas 201/200/400/401/409 documentadas | Inspección del documento Swagger en el E2E |
| Shop ADMIN/Cloudinary | No se atribuye protección a rutas inexistentes; corresponde a la dependencia #32 | Se cubren rutas reales existentes de ADMIN, DRIVER y propiedad de órdenes. No se añadieron endpoints Shop ni pruebas basadas en 404. |

## Resolución de contradicciones de alcance

- El S4 anterior mencionaba `403/400` para escalada de registro. El S8 actualizado especifica `400 VALIDATION_ERROR` para atributos prohibidos, incluidos los tres valores de `role`; la respuesta de registro no usa 403. Los 403 se comprueban en endpoints reales protegidos por roles, no en rutas Shop ausentes.
- Los commits anteriores ya cerraban la asignación privilegiada y la exposición de hashes. T4 conserva esas implementaciones y amplía validación, compatibilidad de login, errores y carrera de email sin refactorizar guards ni proyecciones ajenas a Auth.

## Validación y evidencia

**T4 — corrección autorizada posteriormente en L15:** el usuario autorizó pruebas necesarias después de S9. RED observado con bcrypt crudo: dos fallos en unit (sin marcador y password distinto tras byte 72 autenticado). GREEN tras corrección: 4 suites/33 unit PASS; 1 suite/35 E2E PASS con PostgreSQL desechable propio, incluyendo barrera en ambos INSERT reales; oxlint exit 0 con un warning preexistente en `test/route-start.e2e-spec.ts`. Una primera iteración GREEN unit falló solo porque el test de registro contaba una transacción antes de añadir la aserción de login en ese mismo caso; se corrigió la expectativa y pasó. El worker no ejecutó build por sus superficies de escritura; el padre lo ejecutó posteriormente con exit 0, junto con la regresión unitaria de 53 suites / 709 pruebas PASS. CI remoto y revisión humana aún pendientes.

**Evidencia histórica anterior a T4 (T1–T3):** commits previos reportaron 52 suites / 688 pruebas unitarias PASS, manifiesto E2E aislado de 22 suites / 364 pruebas PASS, build exit 0 y lint exit 0 (con un warning preexistente en un archivo no tocado). Esa evidencia corresponde únicamente a los cambios anteriores de escalada/proyecciones y no verifica el contrato S8 ni este código actualizado; no debe presentarse como resultado de T4.

Las pruebas E2E extendidas reutilizan `test/issue31-auth.e2e-spec.ts` y sus fixtures de PostgreSQL desechable propio (`createOwnedDatabase`); no deben apuntarse al DB configurado por `.env`. Las únicas consultas de verificación se ejecutaron contra PostgreSQL desechable propiedad de las suites, no contra la base del proyecto.

## Comandos de corrección ejecutados

```bash
node --experimental-vm-modules ./node_modules/jest/bin/jest.js --roots src --testPathPatterns 'auth.service.spec|auth.controller.spec|register.dto.spec|password-hash.util.spec'  # RED: exit 1, 2 fallos esperados, 24 PASS (primera invocación cargó .env, sin DB probes ni escrituras)
env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null node --experimental-vm-modules ./node_modules/jest/bin/jest.js --roots src --testPathPatterns 'auth.service.spec|auth.controller.spec|register.dto.spec|password-hash.util.spec'  # primera GREEN: exit 1, 1 expectativa de conteo test; segunda: exit 0, 33/33 PASS
env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null node --experimental-vm-modules ./node_modules/jest/bin/jest.js --config ./test/jest-e2e.json --runInBand --runTestsByPath test/issue31-auth.e2e-spec.ts  # exit 0, 35/35 PASS, DB desechable propia
./node_modules/.bin/oxlint --type-aware src/ test/ benchmarks/.  # exit 0, 1 warning preexistente
```

Verificación posterior del padre: `./node_modules/.bin/nest build` exit 0; regresión unitaria `env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null node --experimental-vm-modules ./node_modules/jest/bin/jest.js --roots src test --runInBand`: **53 suites / 709 pruebas PASS**, exit 0. No se usó la base del proyecto. El manifiesto E2E completo no se repitió localmente; se ejecutaron los 35 casos afectados de #31 en PostgreSQL desechable. CI remoto y revisión humana siguen pendientes.

## Riesgos y revisión pendiente

- **Riesgo principal (item 2): seguridad y compatibilidad compartida de Auth.** Revisar en particular que `Role.CLIENT` sea incondicional, que el lookup de cuentas mixtas nunca resuelva una colisión arbitrariamente y que la clasificación de errores DB solo traduzca la unicidad de email.
- No se conoce si existen en producción correos legados que colisionen al ignorar mayúsculas; sin probes ni migración, el comportamiento fail-closed queda documentado y debe decidirse cualquier saneamiento aparte.
- La búsqueda `lower(email)` no tiene índice funcional en el contrato actual; si el volumen de usuarios lo requiere, evaluar optimización de lectura separada sin migrar ni elegir identidades ambiguas.
- El defecto de truncamiento de bcrypt en nuevas cuentas quedó corregido con prehash SHA-256 versionado; hashes bcrypt crudos legados mantienen su verificación histórica (y su límite heredado). Los formatos desconocidos o malformados se rechazan. Integración enfocada, build y regresión unitaria ya pasaron.
- La revisión humana y CI quedan pendientes; las pruebas enfocadas fueron autorizadas. No se publicó PR ni se modificaron otros worktrees, configuración global o base de datos.

## Revisión independiente final

El mismo verificador reejecutó únicamente los bloqueantes reportados sobre una copia aislada con dependencias propias y sin `.env`: **33/33 pruebas unitarias y 35/35 E2E PASS, exit 0**. Confirmó en ejecución que un sufijo distinto después del byte 72 no autentica una contraseña nueva, que la carrera forzada de INSERT reales devuelve 201 + 409 y una sola fila CLIENT, que las rutas protegidas devuelven 401 a anónimos y que el mismo JWT ADMIN pasa a 403 tras degradar su rol en DB. No quedaron bloqueantes en ese recheck. Esto no sustituye revisión humana ni CI remoto.

## Entrega y hook local

El commit normal fue rechazado por GGA porque su configuración local exige `AGENTS.md`, inexistente. El usuario autorizó explícitamente omitir el hook solo para los commits de #31; no se desinstaló ni cambió su configuración. Los metadatos locales muestran `.gga` y `.git/hooks/pre-commit` creados el 13/10/2026 a las 16:25 (UTC−05); no permiten identificar quién ejecutó la instalación. Los cambios ajenos y el resto de issues quedan excluidos del PR.
