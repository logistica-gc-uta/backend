# Planificación de rutas: propuestas Clarke & Wright (#7)

Conecta la heurística [`planRoutes()`](../src/modules/routes/algorithms/clarke-wright.ts) con PostgreSQL mediante un endpoint administrativo de **solo lectura**. Su diseño está en [clarke-wright.md](./clarke-wright.md).

## Contrato del equipo: proponer ≠ persistir ≠ asignar ≠ iniciar

| Paso | Operación | Persiste | Estado |
| --- | --- | --- | --- |
| 1. Proponer | `GET /api/v1/route-proposals?date=YYYY-MM-DD` (este issue) | No | Propuesta temporal |
| 2. Confirmar | `POST /api/v1/routes` | Sí | Ruta `DRAFT` + reservas de pedidos |
| 3. Asignar | `POST /api/v1/routes/:id/assign` | Sí | `ASSIGNED` + reserva de repartidor |
| 4. Iniciar | `POST /api/v1/routes/:id/start` | Sí | `IN_PROGRESS` |

Este issue implementa **solo el paso 1**. Los pasos 2 y 3 ya existen (#10) y se reutilizan sin cambios: la propuesta no escribe nada, y por eso no necesita transacciones ni idempotencia propias. Si entre la propuesta y la confirmación cambia algo (otro admin reservó un pedido, se canceló, etc.), la confirmación lo detecta bajo bloqueo y responde 409.

## Endpoint

`GET /api/v1/route-proposals` — solo rol **ADMIN** (JWT + guard de rol).

| Parámetro | Obligatorio | Descripción |
| --- | --- | --- |
| `date` | Sí | Día calendario `YYYY-MM-DD` en `America/Guayaquil` (misma política que `GET /drivers/me/routes`). |
| `zoneId` | No | UUID de una zona, para limitar la propuesta. |

Respuestas: `200` propuesta · `400` fecha ausente/inválida, `zoneId` no UUID o parámetro desconocido · `401` sin autenticar · `403` rol distinto de ADMIN · `404` zona inexistente · `422` demasiados pedidos planificables en una zona.

> Se sirve en `/route-proposals` y no en `/routes/proposals` para que `GET /routes/:id` nunca pueda capturar la ruta.

### Qué pedidos se consideran

Se seleccionan los pedidos **`PENDING`** con `scheduledDeliveryDate` dentro del día indicado. De ellos se planifican los que cumplen **todo** lo siguiente; los demás aparecen en `excluded` con sus razones, **nunca se ocultan**:

| Razón de exclusión | Significado |
| --- | --- |
| `MISSING_DELIVERY_COORDINATES` | El destino no tiene coordenadas |
| `INVALID_DELIVERY_COORDINATES` | Las coordenadas del destino están mal formadas o fuera de rango |
| `MISSING_ZONE` | El pedido no tiene zona asociada y tampoco hay cobertura global de tienda (`StoreCoverage`) configurada |
| `MISSING_ZONE_DEPOT_COORDINATES` | La zona no tiene depósito y tampoco hay `StoreCoverage` configurada |
| `INVALID_ZONE_DEPOT_COORDINATES` | El depósito de la zona tiene coordenadas inválidas |
| `ACTIVE_ROUTE_CLAIM` | Ya está reservado por otra propuesta confirmada (ruta `DRAFT`) |
| `ADMINISTRATIVE_REVIEW_REQUIRED` | **El administrador debe revisarlo a mano.** Ocurre cuando una entrega falló (visita fallida): el pedido no se replanifica hasta que un ADMIN intervenga y acuerde una nueva fecha |

Estos 7 códigos se publican en Swagger como el enum `PlanningExclusionReason` (`excluded[].reasons` es un arreglo de ese enum), y la interfaz web los traduce a texto. Una prueba fija la lista: si se agrega o cambia un código, la prueba falla como recordatorio de **avisar a quien consume la API**.

La elegibilidad geográfica reutiliza `evaluatePlanningEligibility` (#9), por lo que el criterio es el mismo que ve el frontend.

### Qué garantiza cada propuesta

- Máximo **4 paradas** (`capacity`). Las rutas de 1 a 3 paradas son válidas cuando no hay otros pedidos compatibles dentro del margen horario.
- **Todos los pedidos de una propuesta** comparten grupo operativo (`zoneId` igual, o `zoneId: null` agrupados por tienda común) y **día solicitado**.
- **Agrupación por ventana horaria (#48):** dentro de cada grupo y día calendario, se agrupan únicamente pedidos con horas programadas compatibles según los extremos del grupo (`max(hora) − min(hora) <= timeWindowMarginMinutes`, inclusivo, sin encadenar vecinos). El margen se lee de `ShopBusinessSettings.routePlanning.timeWindowMarginMinutes` (por defecto **30 minutos**, configurable entre 5 y 180 minutos en `GET/PATCH /api/v1/admin/shop-settings`). Por ejemplo, con margen de `30` min y pedidos a las `10:00`, `10:25` y `10:50`, `10:00` y `10:25` comparten ruta (`25 <= 30`) mientras que `10:50` abre otra (`10:50 − 10:00 = 50 > 30`).
- **Prioridad cronológica de paradas (#48):** dentro de cada ruta propuesta, las paradas se ordenan primero por hora programada ascendente (`scheduledDeliveryDate`), y ante empates horarios por métrica vial/distancia e identificador.
- **Origen y retorno común de tienda (#48, #49):** cuando `StoreCoverage` está configurado (`GET /api/v1/store-coverage` con `configured: true`), todas las propuestas salen y regresan a `storeCoverage.location` (`depot`), y los pedidos sin zona (`zoneId: null`) generan propuestas con `zoneId: null` y `zoneCode: null`. Solo cuando `StoreCoverage` no está configurado se usa el depósito configurado en la zona (`zone.depotLat`/`depotLng`).
- `orderIds` y `stops[].sequence` van en el orden de visita (`stopOrder = sequence`).
- Un pedido aparece en una sola propuesta.
- Es determinista: los mismos datos dan la misma propuesta.

### Trazabilidad de la distancia y métricas viales (#47, #48)

- Con `ROAD_ENGINE` desactivado (`distanceMethod = HAVERSINE_STRAIGHT_LINE`): la distancia es en **línea recta**, no por carretera. No modela tráfico, cierres de calles ni tiempos de viaje.
- Con `ROAD_ENGINE=OSRM` activo (`distanceMethod = OSRM_ROAD_NETWORK`): las propuestas priorizan primero las ventanas horarias compatibles y, dentro de cada ventana, usan la **duración vial estimada de OSRM** (`durationsS`, sin tráfico en vivo ni ETA garantizado) como costo principal de ahorro y ordenación, y la **distancia vial** (`distancesM` en km) como desempate y para reportar `totalDistanceKm` y `legDistanceKm`. Si OSRM falla o responde incompleto (`503`, `502`, `422`), la consulta falla cerrada sin persistir nada ni degradar silenciosamente a línea recta.
- `totalDistanceKm` es el recorrido ida y vuelta depósito → paradas → depósito, redondeado a 3 decimales.

### Ahorro frente a no optimizar

Cada propuesta y el resumen del día comparan la ruta propuesta con una **línea base**: un viaje independiente depósito → pedido → depósito por cada pedido, calculado con **la misma distancia en línea recta**.

| Campo | Dónde | Significado |
| --- | --- | --- |
| `baselineKm` | propuesta y `summary` | Km sin optimizar (línea base) |
| `totalDistanceKm` / `plannedKm` | propuesta / `summary` | Km propuestos (ida y vuelta al depósito) |
| `savingsKm` | propuesta y `summary` | `baselineKm − km propuestos` |
| `savingsPercent` | propuesta y `summary` | Ahorro sobre la línea base, con 2 decimales |

- Los km llevan 3 decimales. `savingsKm` y `savingsPercent` se calculan **a partir de los km ya redondeados**, así que `baselineKm − totalDistanceKm = savingsKm` se cumple exactamente en pantalla.
- Los totales del día **suman lo mostrado en cada propuesta**, de modo que la suma que ve el usuario siempre cuadra. Los pedidos excluidos no cuentan.
- Una ruta de un solo pedido ahorra 0. Si la línea base es 0 (pedidos en el depósito) el ahorro es 0 y nunca se divide entre 0.
- Es un ahorro **en línea recta frente a una línea base deliberadamente simple**; no equivale al ahorro frente a una operación real. Rotúlese como «distancia estimada en línea recta, no por calles».

### Confirmación: mismo día de negocio y ventana horaria

La planificación agrupa por zona, día `America/Guayaquil` y ventana horaria compatible (`max − min <= timeWindowMarginMinutes`), de modo que horas alejadas (por ejemplo `15:00Z` y `18:00Z` con margen `30` min) nunca se mezclan en una misma ruta. `POST /routes` acepta cada propuesta tal cual: exige que todos sus pedidos pertenezcan al **mismo día de negocio** que `routeDate` (ver [route-assignment.md](./route-assignment.md)).

- `scheduledInstants`: instantes distintos de los pedidos, en orden cronológico.
- `routeDate`: el instante programado **más temprano** de la propuesta; es el valor a enviar a `POST /routes`. Cualquier instante de ese mismo día sería aceptado.

Los límites del día son la medianoche local de Guayaquil, no la UTC: `2026-10-11T04:59:59Z` es el 10 de octubre y `2026-10-11T05:00:00Z` es el 11.

## Ejemplo

`GET /api/v1/route-proposals?date=2030-02-14` con `Authorization: Bearer <token ADMIN>`:

```json
{
  "date": "2030-02-14",
  "timeZone": "America/Guayaquil",
  "capacity": 4,
  "timeWindowMarginMinutes": 30,
  "distanceMethod": "HAVERSINE_STRAIGHT_LINE",
  "proposals": [
    {
      "zoneId": "2f782f43-6ec2-41ff-875f-c4c93d303fa4",
      "zoneCode": "CEN-01",
      "depot": { "lat": -1.241, "lng": -78.619 },
      "orderIds": ["8b1d…", "c07e…", "1f3a…", "a94c…"],
      "stops": [
        {
          "sequence": 1,
          "orderId": "8b1d…",
          "location": { "lat": -1.2412, "lng": -78.6188 },
          "deliveryAddress": "Av. Los Chasquis y Río Guayllabamba, Ambato",
          "scheduledDeliveryDate": "2030-02-14T15:00:00Z"
        }
      ],
      "totalDistanceKm": 1.274,
      "baselineKm": 5.096,
      "savingsKm": 3.822,
      "savingsPercent": 75,
      "scheduledInstants": ["2030-02-14T15:00:00Z"],
      "routeDate": "2030-02-14T15:00:00Z"
    }
  ],
  "excluded": [
    { "orderId": "5d2b…", "zoneId": "2f78…", "reasons": ["MISSING_DELIVERY_COORDINATES"] }
  ],
  "summary": {
    "candidateOrders": 6, "plannedOrders": 5, "excludedOrders": 1, "routes": 2,
    "baselineKm": 5.896, "plannedKm": 2.074, "savingsKm": 3.822, "savingsPercent": 64.82
  }
}
```

El ejemplo está abreviado: solo muestra una de las dos propuestas y una de sus paradas. Cada parada trae `deliveryAddress` (sin nombre ni datos del cliente).

Para confirmar una propuesta: `POST /api/v1/routes` con `{ "zoneId", "routeDate", "orderIds" }` tomados de la propuesta (`zoneId` es opcional y puede ser `null` en propuestas sin zona basadas en `StoreCoverage`).

## Límite de tamaño

El algoritmo crece de forma cuadrática. Medido en una máquina de desarrollo: ~0,45 s con 1 000 pedidos en una zona y ~5,9 s con 3 000. Para no bloquear el servidor, una zona con más de **2 000** pedidos planificables en el día responde `422`; se debe acotar la consulta. Estas cifras se contrastarán en las pruebas de volumen y carga.

## Base de datos y migraciones

**Sin cambios de esquema ni migraciones**: se usan las coordenadas de `Order`/`Zone` ya creadas en #9 y las reservas de #10. Entorno limpio reproducible:

```bash
docker compose up -d
pnpm prisma db migrate
pnpm run seed
```

Para tener pedidos de demostración con coordenadas (DEMO/TEST) sin tocar los registros existentes:

```bash
pnpm run seed:planning-demo
```

## Pruebas

- **Jest unitarias:** servicio (agrupación, exclusiones, día `America/Guayaquil`, límites, solo lectura, determinismo, errores), controlador (rol ADMIN, ruta) y validación del DTO.
- **Newman (API real + PostgreSQL aislado):** carpeta `06-Planning` de la colección, con ADMIN, rol sin permiso, sin token, fechas inválidas, zona inexistente y comprobación de que no se persiste nada.

```bash
bash test/run-newman-isolated.sh --report
```

## Pendiente fuera de este issue

- Tráfico en vivo o tiempos garantizados de llegada (ETA en tiempo real).
