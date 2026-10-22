# Issue 31 — Registro público exclusivo CLIENT y redacción de secretos

Especificación: `odd/tasks/31-auth-client-only-registration.md` (T1, T2; S1–S4). Base: `main` @ `13a557e`, rama `feat/31-auth-client-only-registration`.

## Contrato

| Spec | Regla | Implementación | Prueba |
|---|---|---|---|
| S1 | `POST /api/v1/auth/register` nunca crea ADMIN ni DRIVER, ni con un body manipulado | `RegisterDto` ya no declara `role` (`src/modules/auth/dto/register.dto.ts`) y `AuthService.register` persiste `role: Role.CLIENT` sin condición (`src/modules/auth/auth.service.ts`) | `src/modules/auth/dto/register.dto.spec.ts`, `src/modules/auth/auth.service.spec.ts`, `test/issue31-auth.e2e-spec.ts` |
| S2 | Ninguna respuesta de usuario o conductor expone el hash de contraseña | Proyección explícita `select('id','name','email','role','createdAt')` en `src/modules/drivers/drivers.service.ts` y `src/modules/routes/routes.service.ts`; se elimina el miembro `password` de `AdminRouteHistoryUserDto` | `src/modules/drivers/drivers.service.spec.ts`, `src/modules/routes/route-history.service.spec.ts`, `test/issue31-auth.e2e-spec.ts` |
| S3 | El login de ADMIN, CLIENT y DRIVER se conserva | Sin cambios en `AuthService.login` ni en `LoginDto`; verificado por prueba unitaria, E2E y comparación diferencial | `src/modules/auth/auth.service.spec.ts`, `test/issue31-auth.e2e-spec.ts` |
| S4 | 201 con rol CLIENT, 400/403 en escalada, regresiones de autenticación y seguridad en verde | Ver tabla de comandos | suite completa + E2E |

### Cambios de contrato (breaking changes)

Estos dos cambios rompen consumidores existentes y hay que adaptarlos:

1. **`POST /api/v1/auth/register` ya no acepta un campo `role` en el body.** Antes, un body con `role: "ADMIN"` o `role: "DRIVER"` devolvía 201 y creaba ese usuario; ahora devuelve **400 Bad Request** (`property role should not exist`) y no crea ninguna fila. El registro público solo puede crear CLIENT. Un cliente que envíe el rol debe dejar de enviarlo.
2. **Los payloads ADMIN de repartidores y de rutas ya no incluyen `password`.** `GET /api/v1/drivers`, `GET /api/v1/routes` y `GET /api/v1/routes/:id` devuelven el usuario relacionado con `id, name, email, role, createdAt` y sin el hash. Un cliente que leyera ese campo debe dejar de leerlo.

Ninguno de los dos cambios afecta el login de ADMIN, CLIENT ni DRIVER, ni la forma de su respuesta.

### Código de rechazo observado

El `ValidationPipe` global de `src/main.ts` (`whitelist: true, forbidNonWhitelisted: true`) rechaza el campo `role` porque el DTO ya no lo declara. Estado observado: **400 Bad Request**.

```json
{
  "message": ["property role should not exist"],
  "error": "Bad Request",
  "statusCode": 400
}
```

La defensa es doble: el pipe rechaza el campo (400) y el servicio persiste `Role.CLIENT` aunque el objeto llegue manipulado.

### Rutas de exposición de secretos revisadas

Búsqueda sobre todo `src/` de serializaciones capable de devolver la columna `password`:

| Ubicación | Estado |
|---|---|
| `src/modules/drivers/drivers.service.ts` (`include('user')`) | Corregido: proyección explícita sin `password` |
| `src/modules/routes/routes.service.ts` (`include('driver', d => d.include('user'))`, listados y detalle) | Corregido: proyección explícita sin `password` |
| `src/modules/routes/dto/route-history-response.dto.ts` (`AdminRouteHistoryUserDto.password`) | Corregido: miembro eliminado |
| `src/modules/orders/orders.service.ts` (`.include('user', user => user.select('id','name'))`) | Ya era una lista blanca; sin cambios |
| `src/modules/auth/auth.service.ts` (`register`/`login`) | Ya devolvía campos explícitos; sin cambios |
| `src/modules/auth/jwt.strategy.ts`, `src/modules/realtime/realtime.service.ts`, `src/modules/orders/orders.service.ts` (consulta de actor) | Ya usaban `select` explícito o devolvían campos explícitos; sin cambios |
| `src/prisma/seed.ts` | Ruta de aprovisionamiento ADMIN/DRIVER; **sin cambios** (L5) |

## Evidencia RED (antes de la corrección)

| Prueba | Fallo observado |
|---|---|
| `src/modules/auth/dto/register.dto.spec.ts` → "rejects a caller-supplied role as a non-whitelisted property" | `expect(received).toHaveLength(expected)` — esperado 1, recibido 0: `role` todavía estaba en la lista blanca |
| `src/modules/auth/auth.service.spec.ts` → "persiste siempre el rol CLIENT aunque el payload incluya un rol" | `create` recibido con `{"role":"ADMIN"}` en lugar de `{"role":"CLIENT"}` |
| `src/modules/drivers/drivers.service.spec.ts` → "findAll lista los repartidores con su usuario y sin exponer el hash de contraseña" | `include` recibido con `"user"` (sin callback de proyección) |
| `src/modules/routes/route-history.service.spec.ts` → "no declara un miembro password en la relación de usuario" | Claves recibidas: `["id","name","email","password","role","createdAt"]` |
| `test/issue31-auth.e2e-spec.ts` → escalada con `role: 'ADMIN'` y `role: 'DRIVER'` | `expected 400 "Bad Request", got 201 "Created"` (el usuario ADMIN/DRIVER se creaba) |
| `test/issue31-auth.e2e-spec.ts` → listados ADMIN de repartidores y de rutas | Claves secretas detectadas: `$[0].user.password` y `$[0].driver.user.password` |
| `test/issue31-auth.e2e-spec.ts` → detalle ADMIN de una ruta | Clave secreta detectada: `$[0].driver.user.password` |
| `test/issue31-auth.e2e-spec.ts` → DTO documentado | Esquema `AdminRouteHistoryUserDto` con `["id","name","email","password","role","createdAt"]` |

RED adicional sobre la base: el mismo archivo E2E (`test/issue31-auth.e2e-spec.ts`) ejecutado contra la copia de `13a557e` falla **6 de 11** pruebas (las dos escaladas, los dos listados, el detalle de ruta y el DTO documentado) y pasan las 5 de conservación (registro CLIENT, los tres logins y el 401 de credenciales inválidas).

## Evidencia GREEN (después de la corrección)

- `src/modules/auth/**` + `src/modules/drivers/**` + `src/modules/routes/**`: 6 suites, 26/26 pruebas PASS.
- `test/issue31-auth.e2e-spec.ts`: 1 suite, 11/11 pruebas PASS contra PostgreSQL 16 real.
- Manifiesto E2E completo (runner canónico `pnpm run test:e2e:isolated`): **22 suites** (19 auto-gestadas + 3 heredadas), 19/19 suites auto-gestadas con 304/304 pruebas, 1/1 + 35/35 + 23/23 en las heredadas, exit 0 y limpieza del PostgreSQL propio confirmada.

## Comandos ejecutados y resultados

| Comando | Resultado observado |
|---|---|
| `pnpm test --roots src --testPathPatterns "auth.service.spec\|auth.controller.spec\|register.dto.spec\|drivers.service.spec\|route-history.service.spec\|routes.service.spec"` | 6 suites, 26/26 pruebas PASS, exit 0 |
| `pnpm run test:e2e -- --runTestsByPath test/issue31-auth.e2e-spec.ts` | 1 suite, 11/11 pruebas PASS, exit 0 |
| `pnpm test --roots src test` | 52 suites, 688 pruebas: 51 suites / 687 pruebas PASS y **1 fallo**: `test/ci-security.spec.ts` espera 21 suites E2E y ahora hay 22 (ver "Pendiente fuera de la superficie de edición") |
| `pnpm run build` | exit 0 |
| `pnpm run lint` | exit 0; un aviso preexistente en `test/route-start.e2e-spec.ts` (parámetro `status` sin uso), no tocado por este cambio |
| `pnpm run test:e2e:isolated` | 22 suites completas, exit 0, "Owned PostgreSQL cleanup confirmed" |
| `pnpm test` (sin `--roots src test`) | Falla antes y después del cambio con `jest-haste-map: Haste module naming collision: backend` / `socket.io-client`, por los directorios `.issue13-*` residuales. Fallo ambiental conocido, no causado por este cambio |

## Comparación diferencial contra la base `13a557e`

Procedimiento: copia de la base en un directorio temporal creado con `mktemp -d` fuera del repositorio (`git archive 13a557e`), con `node_modules` enlazado; la misma sonda HTTP (supertest contra la app real con `setGlobalPrefix('api/v1')` y el mismo `ValidationPipe`) se ejecutó contra la base y contra el código actual, cada una sobre su propia base PostgreSQL propiedad con los mismos datos sembrados. Los UUID, marcas de tiempo y el JWT se normalizaron antes de comparar.

| Comando comparado | Base `13a557e` | Actual | Diferencia |
|---|---|---|---|
| `POST /api/v1/auth/login` (ADMIN) | 200, `{access_token, user:{id,name,email,role}}` | idéntico | ninguna |
| `POST /api/v1/auth/login` (CLIENT) | 200, misma forma | idéntico | ninguna |
| `POST /api/v1/auth/login` (DRIVER) | 200, misma forma | idéntico | ninguna |
| `POST /api/v1/auth/login` (credenciales inválidas) | 401, `Credenciales inválidas` | idéntico | ninguna |
| `GET /api/v1/drivers` (ADMIN) | 200, `user` con `id,name,email,password,role,createdAt` | 200, `user` con `id,name,email,role,createdAt` | **solo** se elimina la clave `password`; el resto del payload es idéntico tras normalizar (orden de claves irrelevante) |
| `GET /api/v1/routes` (ADMIN) | 200, `driver.user` con `password` | 200, `driver.user` sin `password` | **solo** se elimina la clave `password` |
| `POST /api/v1/auth/register` con `role: 'ADMIN'` | 201, usuario creado con rol ADMIN | 400 `property role should not exist` | cambio intencional de S1 |

Comprobación estructural automatizada sobre las dos capturas: `login` idéntico (`true`), listados de repartidores y de rutas idénticos tras eliminar únicamente la clave `password` de la base (`true`), y presencia de la clave `password` en base `true` / actual `false` en ambos listados.

## Pendiente fuera de la superficie de edición

`test/ci-security.spec.ts` fija el número de suites E2E del manifiesto. Al añadir `test/issue31-auth.e2e-spec.ts` el inventario pasa de 21 a 22 suites, por lo que esa prueba falla. El archivo está fuera de las superficies autorizadas y no se modificó. Cambio requerido (una línea, decisión del padre):

```ts
// test/ci-security.spec.ts:73
)).toHaveLength(21);   ->   )).toHaveLength(22);
```

El título de la prueba en la línea 59 (`'delegates all 21 suites ...'`) conviene ajustarlo a 22 por coherencia. `.github/workflows/ci.yml` no fija ningún número de suites y `test/run-e2e-isolated.mjs` calcula el manifiesto dinámicamente: no requieren cambios.

## Notas de entorno

- Directorio temporal de la comparación diferencial (fuera del repositorio, nunca confirmado): `/tmp/gpXT25eG/ga0KqvN7/tmp.XTw5xOOYZK` (contiene la copia de `13a557e` y una copia del árbol actual; incluye una copia de `.env`, por lo que conviene borrarlo). Capturas y diff conservados en `/tmp/issue31-diff-evidence/` (`base.json`, `current.json`, `base-vs-current.diff`, `isolated-e2e.log`).
- El contenedor del proyecto `logistica_postgres` (`.env` → `localhost:5433/logistica_db`) fue reparado durante la tarea y acepta conexiones; la sonda diferencial antes descrita no lo usa porque necesita dos bases idénticas en paralelo, y el manifiesto E2E canónico exige suites auto-gestadas sin `DATABASE_URL` ambiental (requisito de CI: `env -u DATABASE_URL -u JWT_SECRET DOTENV_CONFIG_PATH=/dev/null`).
- `test/issue31-auth.e2e-spec.ts` sigue el patrón auto-gestado ya establecido en el repositorio (`test/geolocation-migration.fixtures.ts`): contenedor PostgreSQL 16 propio, base propia, migraciones reales y limpieza de las filas creadas por la propia suite. Los correos son únicos por ejecución y solo se borran filas creadas por la suite.
- `src/prisma/seed.ts` no se modificó: sigue aprovisionando ADMIN y DRIVER por Prisma directo, fuera de `POST /auth/register`.
