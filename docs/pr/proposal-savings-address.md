## Descripción

Agrega a `GET /api/v1/route-proposals` lo que la interfaz web necesita para mostrar cada propuesta: el ahorro frente a no optimizar (por ruta y total del día), la dirección de entrega en cada parada y los motivos de exclusión como enum en Swagger. Los cambios son **aditivos**: no se quita ni renombra ningún campo existente.

## Issue relacionado

Refs #7

> El issue #7 del backend ya está cerrado. Este PR atiende lo acordado con quien consume la API desde el frontend (Kerly).

## Cambios realizados

- **Ahorro por propuesta:** `baselineKm` (km sin optimizar: un viaje depósito → pedido → depósito por cada pedido, con la misma distancia en línea recta), `savingsKm` y `savingsPercent`, junto al `totalDistanceKm` existente (km propuestos).
- **Ahorro del día:** `summary.baselineKm`, `plannedKm`, `savingsKm` y `savingsPercent`. Los totales suman lo mostrado en cada propuesta, y los pedidos excluidos no cuentan.
- **Coherencia en pantalla:** el ahorro se calcula a partir de los km ya redondeados (3 decimales), por lo que `baselineKm − totalDistanceKm = savingsKm` se cumple exactamente. Con línea base 0 el ahorro es 0 y nunca se divide entre 0.
- **`stops[].deliveryAddress`:** la dirección de cada pedido, para no consultar cada pedido por separado. El endpoint es solo ADMIN y no se agrega ningún dato del cliente (una prueba fija las claves exactas de una parada).
- **`excluded[].reasons`** documentado en Swagger como arreglo del enum `PlanningExclusionReason` con los 7 códigos, cada uno explicado. Una prueba fija la lista: si se agrega o cambia un código, falla como recordatorio de avisar a la interfaz.
- Pruebas unitarias, escenario de Newman y `docs/route-planning.md` actualizados (con el significado de `ADMINISTRATIVE_REVIEW_REQUIRED`).

## Pruebas realizadas

| Prueba | Resultado | Evidencia |
|---|---|---|
| Análisis estático | Aprobado | `pnpm run lint`: sin avisos nuevos; queda 1 aviso previo en `test/route-start.e2e-spec.ts:217` |
| Pruebas unitarias | Aprobado | Métricas de ahorro (11), servicio de propuestas con ahorro, totales, línea base 0, dirección y claves de la parada, y enum de códigos con el documento Swagger real. Archivos nuevos con 100 % de líneas |
| Pruebas de integración | Aprobado | Newman con PostgreSQL efímero (ver abajo). Los E2E con base real no cambian: los campos nuevos no afectan a `POST /routes` |
| Compilación | Aprobado | `pnpm run build`, exit 0 |
| Pruebas funcionales | Aprobado | Newman aislado: 104 solicitudes / 439 aserciones, 0 fallos |

Suite completa local (Windows, Node 26): 623 de 659 pruebas, cobertura global 91,6 % (el CI exige 80 %). Los 36 fallos son de las tres suites que dependen de `/bin/bash`, permisos, symlinks y de la resolución de TypeScript en Linux (`geolocation-migration.fixtures`, `run-newman-isolated` y `prisma-legacy-rawsql-compat`), que fallan igual sobre `main` sin estos cambios. El resultado en Linux queda a cargo del CI de este PR.

## Evidencias

Contrato, definición de la línea base y ejemplo de respuesta en [`docs/route-planning.md`](../route-planning.md). La carpeta `06-Planning` de la colección de Newman comprueba que cada parada trae su dirección y nada más, que el ahorro es coherente en cada propuesta, que el resumen del día suma las propuestas y que los motivos pertenecen al enum.

## Impacto técnico

**API / Contratos:** Solo se **agregan** campos a `GET /api/v1/route-proposals`: `baselineKm`, `savingsKm`, `savingsPercent` por propuesta; `baselineKm`, `plannedKm`, `savingsKm`, `savingsPercent` en `summary`; `deliveryAddress` en `stops[]`; y `reasons` pasa a documentarse como enum (los valores devueltos no cambian). Quien consuma la API puede tratar los campos nuevos como opcionales hasta integrarlos. El campo `confirmable` **ya no existe** desde el PR #25: todas las propuestas se pueden confirmar con `POST /routes` usando `zoneId`, `routeDate` y `orderIds`.

**Base de datos / Migraciones:** Sin cambios.

**Seguridad y permisos:** Sin cambios: solo ADMIN. `deliveryAddress` es un dato personal que ya está disponible para ADMIN en los pedidos; no se agrega el nombre ni el teléfono del cliente.

**Compatibilidad con otros componentes:** Los campos son aditivos. El benchmark ya fusionado (PR #28, `benchmarks/routing/`) mantiene su propia versión de estas funciones; podría reutilizar `route-metrics.ts` en un cambio posterior.

**Limitaciones conocidas:**
- La distancia es en línea recta (Haversine): rotularla como «distancia estimada en línea recta, no por calles».
- La línea base es deliberadamente simple: el ahorro no equivale al ahorro frente a una operación real.
- Una propuesta puede tener `savingsPercent` 0 (ruta de un solo pedido).

## Checklist de entrega

- [ ] Cumplí los criterios de aceptación del Issue (queda por confirmar «CI satisfactoria» y la revisión cruzada en este PR).
- [x] Implementé únicamente los cambios necesarios.
- [x] Ejecuté las pruebas correspondientes.
- [x] Verifiqué que el código compile correctamente.
