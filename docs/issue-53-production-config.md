# Issue #53 — Configuración del backend para producción

> Esta issue corrige **configuración antes de publicar**. No acredita ni afirma exposición productiva: aún no hay base de producción. No elige proveedor ni infraestructura, no despliega y no rota credenciales reales.

## Qué se contrastó antes de implementar

| Hallazgo de la lectura estática | Estado en la rama |
|---|---|
| Secreto JWT con respaldo fijo (`auth.module.ts`, `jwt.strategy.ts`) | Confirmado y corregido: dos copias del mismo literal. El mismo valor figuraba en el README. |
| CORS y Swagger habilitados sin condición (`main.ts`) | Confirmado: `enableCors()` abierto y Swagger siempre publicado. |
| Compose de desarrollo con PostgreSQL visible | Confirmado: puerto publicado en todas las interfaces y usuario/clave fijos. |
| `realtime.service.ts` y `quote-token.util.ts` | Ya no tenían respaldo: sin `JWT_SECRET` rechazan. Se mantienen. |
| `REALTIME_ALLOWED_ORIGINS` | Ya exige orígenes exactos sin comodín; es una lista **aparte** (ver «Riesgos»). |

## Qué cambió

### Validación previa al arranque (`src/config/runtime-config.ts`, `src/bootstrap.ts`)

`main.ts` valida la configuración **antes de cargar la aplicación**; un error de configuración termina con código 1 y un mensaje que **nombra las variables, nunca sus valores**.

`NODE_ENV` ∈ `development | test | demo | production`. `production` y `demo` son entornos *desplegados*.

| Variable | Desarrollo / pruebas | `production` / `demo` |
|---|---|---|
| `JWT_SECRET` | Opcional. Si falta se usa un **secreto aleatorio por proceso** (no hay valor fijo en el código; los tokens dejan de valer al reiniciar). | **Obligatorio**, ≥ 32 caracteres y distinto de los valores de desarrollo conocidos (el que tuvo el código y el del `.env.example`). |
| `DATABASE_URL` | Sin exigencia nueva. | **Obligatoria** y sin la credencial de la base de desarrollo. |
| `CORS_ALLOWED_ORIGINS` | Vacía = CORS abierto (Flutter web y frontends locales siguen funcionando). Con lista: solo esos orígenes. | **Obligatoria**: orígenes exactos separados por comas (sin comodín, ruta ni credenciales); `https`, salvo `localhost`. |
| `SWAGGER_ENABLED` | Activo por defecto. | **Apagado por defecto**; solo `SWAGGER_ENABLED=true` lo publica. |
| `PORT` | 3000 por defecto. | Entero 1–65535. |

- **Sin `NODE_ENV`** se asume `development` con un aviso en el arranque. Un despliegue **debe** definir `NODE_ENV=production` (ver checklist). Un valor desconocido se rechaza.
- **CORS** solo gobierna a los navegadores: una petición sin cabecera `Origin` (Flutter, servidores) no se ve afectada, y CORS **no sustituye** la autenticación, el rol ni la propiedad por objeto, que se siguen exigiendo en cada ruta.
- `configureApp()` aplica prefijo, CORS, validación y Swagger y lo comparten el arranque y las pruebas e2e: lo que se prueba es lo que se despliega.

### `docker-compose.yml`

Queda marcado como **solo desarrollo**. PostgreSQL se publica únicamente en `127.0.0.1`; usuario, clave y base se pueden sobrescribir con `POSTGRES_USER/PASSWORD/DB`. Los valores por defecto siguen siendo de desarrollo y el backend los **rechaza** en `production`/`demo`. (Un contenedor ya creado conserva su configuración hasta que se recree.)

### `.env.example` y README

El ejemplo declara que todo es de desarrollo, documenta las variables nuevas y el README deja de mostrar el secreto fijo.

## Revisión de PostgreSQL para el despliegue

Antes de desplegar, con el proveedor elegido por el responsable:

- **Credenciales propias** (usuario con los mínimos privilegios que necesita la aplicación, no el superusuario) guardadas en un gestor de secretos o en las variables protegidas de la plataforma, nunca en git ni en imágenes.
- **Sin puerto público**: la base solo debe ser alcanzable desde el backend (red privada o interna de la plataforma). Si hay que administrarla desde fuera, por túnel/VPN.
- **TLS** en la conexión si el backend y la base no comparten red privada (`sslmode` en `DATABASE_URL`).
- Los fixtures y credenciales de las pruebas (`logistica_*`, contenedores propios de los tests) **no** se reutilizan como credenciales reales.

## Respaldo y recuperación (necesarios antes de desplegar)

Genérico, sin elegir proveedor; el responsable fija frecuencia y retención:

1. **Respaldo lógico periódico** con `pg_dump` (formato personalizado) de la base y de las **migraciones aplicadas** (`migrations/` ya está en git). Guardarlo cifrado y **fuera** del mismo servidor.
2. **Respaldo previo a cada migración** de producción.
3. **Prueba de restauración**: restaurar en una base nueva y aislada (`pg_restore`) y comprobar el arranque del backend contra ella. Un respaldo que nunca se restauró no es un respaldo.
4. **Recuperación**: parar el backend → restaurar en una base limpia → aplicar las migraciones pendientes → arrancar → verificar `/api/v1/auth/login` y un pedido conocido.
5. **Secretos**: guardar una copia del `JWT_SECRET` en el gestor de secretos. Cambiarlo invalida todas las sesiones (los usuarios vuelven a iniciar sesión); es el procedimiento para rotarlo.
6. Rotar **cualquier** credencial que se haya compartido fuera de un gestor de secretos antes de usarla en producción.

## Checklist antes de desplegar

- [ ] `NODE_ENV=production` (o `demo`).
- [ ] `JWT_SECRET` aleatorio de ≥ 32 caracteres (p. ej. `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`) en el gestor de secretos.
- [ ] `DATABASE_URL` con credenciales propias y base no expuesta.
- [ ] `CORS_ALLOWED_ORIGINS` con el dominio **real** de la web (lo define el responsable; no se inventó ninguno).
- [ ] `REALTIME_ALLOWED_ORIGINS` con ese mismo dominio (lista aparte).
- [ ] `SWAGGER_ENABLED` decidido por el responsable (por defecto apagado).
- [ ] Respaldo configurado y **restauración probada**.
- [ ] `SIMULATED_PAYMENTS_ENABLED` sin definir (el simulador solo funciona en `test`/`demo`).
- [ ] Base URL del backend acordada con el equipo móvil.

## Decisiones a confirmar con el responsable (no se adivinaron)

1. **Dominios de la web** para `CORS_ALLOWED_ORIGINS`/`REALTIME_ALLOWED_ORIGINS`: no se fijó ninguna URL productiva.
2. **Swagger en producción**: apagado por defecto; ¿se publica en `demo`? Se enciende con `SWAGGER_ENABLED=true`.
3. **Sin `NODE_ENV`** se asume desarrollo (con aviso) para no romper los entornos locales existentes. Si se prefiere fallar cerrado (tratarlo como producción), es un cambio de una línea en `resolveEnvironment`, pero exige que cada `.env` local defina `NODE_ENV=development`.
4. **Gestión de secretos y recuperación** según la infraestructura real.

## Pruebas

- Unitarias: `src/config/runtime-config.spec.ts` (22): secreto obligatorio/corto/conocido sin repetir el valor, secreto efímero en desarrollo, entornos, CORS (exactos, https, deduplicado, política), Swagger, PostgreSQL y puerto.
- E2E en PostgreSQL real con JWT reales, `test/production-config.e2e-spec.ts` (14): el arranque con configuración insegura falla sin revelar valores (sin secreto, secreto fijo antiguo o corto, credencial de desarrollo, sin orígenes, comodín); con configuración de producción un token firmado con el secreto fijo antiguo se rechaza, sin token/manipulado/usuario inexistente → 401, propiedad por objeto (el dueño sí, otro cliente no, también desde la web autorizada), roles ADMIN/CLIENT/DRIVER, cliente sin `Origin` (Flutter) conserva el servicio, CORS para la web autorizada y no para un origen ajeno, CORS no sustituye la autenticación, Swagger apagado por defecto en producción y activo con `SWAGGER_ENABLED=true` o en desarrollo.

## Riesgos y limitaciones

- `REALTIME_ALLOWED_ORIGINS` es una lista separada de `CORS_ALLOWED_ORIGINS`: hay que mantener ambas alineadas.
- No se validó una base real de producción (no existe) ni se ejecutó ningún despliegue.
- El respaldo y la recuperación quedan **documentados**, no automatizados: dependen del proveedor.
- `JWT_EXPIRES_IN` sigue en 24 h por defecto; no hay revocación individual de tokens (fuera de alcance).
