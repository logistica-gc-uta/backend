# Diseño del armado de rutas: algoritmo de Clarke & Wright

Documento de diseño del motor de asignación de rutas del Sistema de Gestión de Entregas y Rutas ("Logística de Última Milla"). Cubre el algoritmo elegido, por qué se eligió, cómo se integra con el backend y sus límites actuales.

Implementación: [`src/modules/routes/algorithms/clarke-wright.ts`](../src/modules/routes/algorithms/clarke-wright.ts).

## 1. Problema a resolver

Dado un conjunto de pedidos pendientes con una fecha de entrega y una ubicación, hay que agruparlos en rutas para los repartidores cumpliendo:

| Restricción | Origen |
|---|---|
| Máximo **4 pedidos por ruta** | Enunciado y regla de negocio de `RoutesService` |
| Todos los pedidos de una ruta son de la **misma zona** | Regla de negocio de `RoutesService` |
| Todos los pedidos de una ruta son de la **misma fecha** | Enunciado: el armado se dispara por fecha y zona |
| Minimizar la distancia total recorrida | Objetivo de eficiencia del enunciado |

Es una instancia del **VRP con capacidad (CVRP)**: un depósito por zona, capacidad fija por vehículo (4 paradas) y demanda unitaria por pedido.

## 2. Algoritmo elegido: heurística de ahorros (Savings)

Propuesto por Clarke y Wright (1964). Idea: partir de una ruta por pedido (depósito → pedido → depósito) y fusionar rutas cuando hacerlo ahorra distancia.

Para dos pedidos `i` y `j`, con `d(0, x)` la distancia del depósito a `x`:

```
ahorro(i, j) = d(0, i) + d(0, j) − d(i, j)
```

Es lo que se ahorra al visitar `j` justo después de `i` en lugar de hacer dos viajes separados al depósito.

### Procedimiento (por cada grupo zona + fecha)

1. Crear una ruta por pedido.
2. Calcular `ahorro(i, j)` para todo par y descartar los que no son positivos.
3. Ordenar de mayor a menor ahorro (desempate por id para ser determinista).
4. Recorrer la lista y fusionar la ruta de `i` con la de `j` si:
   - están en rutas distintas,
   - la suma de paradas **no supera la capacidad** (4),
   - `i` y `j` son **extremos** de sus rutas (no se puede insertar en medio de una ruta ya formada).
5. Orientar cada ruta final para que la primera parada sea la más cercana al depósito.

### Ejemplo

Depósito en `(0, 0)`, pedidos `A(10,0)`, `B(10,1)`, `C(-10,0)`:

- `ahorro(A, B) = 10 + 10.05 − 1 = 19.05` → se fusionan en una ruta.
- `ahorro(A, C) = 10 + 10 − 20 = 0` → no se fusionan: están a lados opuestos del depósito y unirlos no ahorra nada.

Resultado: ruta 1 = `[A, B]`, ruta 2 = `[C]`.

### Complejidad

`O(n² log n)` por grupo (n² pares, ordenados una vez). Medición local (Node 26, un solo grupo zona + fecha, coordenadas aleatorias):

| Pedidos en el grupo | Rutas | Tiempo |
|---|---|---|
| 1 000 | 250 | ~0,45 s |
| 3 000 | 750 | ~5,9 s |

El crecimiento es cuadrático. Como el armado se hace por zona y fecha, un grupo típico es mucho menor que el total del día, pero un día pico con miles de pedidos en una sola zona ya se nota. Si fuera necesario, se puede limitar los pares candidatos a los *k* vecinos más cercanos de cada pedido, lo que reduce el costo a casi lineal con una pérdida de calidad pequeña. Estas cifras se contrastarán en las pruebas de volumen y carga.

## 3. Por qué este algoritmo

Alternativas listadas en el enunciado y por qué no se eligieron como núcleo:

| Alternativa | Valoración |
|---|---|
| Vecino más cercano | Más simple, pero construye rutas de una en una de forma voraz y tiende a dejar pedidos lejanos para el final. Clarke & Wright mira todos los pares a la vez. |
| Puntaje ponderado (distancia, carga, prioridad) | Útil para decidir *a qué repartidor* ir, pero no arma las rutas por sí solo. Puede combinarse después. |
| Algoritmo húngaro | Resuelve asignación 1 a 1 (pedido ↔ repartidor). No modela rutas con varias paradas. |
| Heurísticas de inserción | Adecuadas para insertar un pedido nuevo en rutas existentes (ver §6), no para armar el lote inicial. |
| CVRP / VRPTW exactos o metaheurísticos | Mejores soluciones, pero requieren librerías o solvers externos y mucho más costo de implementación y prueba. Excesivo con capacidad de solo 4 paradas. |
| Clusterización geográfica previa | Ya se hace: se agrupa por zona y fecha antes de aplicar el algoritmo. |

Razones a favor de Clarke & Wright:

- Resuelve **de forma nativa el CVRP**, que es el escenario descrito en el enunciado.
- Es **lógica pura en TypeScript**: sin ML ni dependencias, lo que la hace completamente verificable con Jest (cubierta al 100 %).
- Es **determinista**: mismas entradas, mismo resultado, sin importar el orden de llegada. Eso hace reproducibles las pruebas de volumen y carga.
- Es una heurística clásica y ampliamente documentada para el CVRP. Esta versión no se ha comparado contra una solución óptima; esa comparación queda para el informe de pruebas.

## 4. Diseño e interfaz

La función `planRoutes(orders, options)` es pura: no accede a la base de datos ni al reloj.

```ts
planRoutes(
  orders: RoutingOrder[],            // { id, zoneId, deliveryDate, location: {lat, lng} }
  options: {
    depots: Record<string, GeoPoint>, // depósito de cada zona
    capacity?: number,                // por defecto 4
    distance?: (a, b) => number,      // por defecto Haversine (km)
  },
): PlannedRoute[]                     // { zoneId, deliveryDate, orderIds, totalDistance }
```

- `orderIds` viene ordenado: el índice + 1 es el `stopOrder` que ya usa `Order` en la base de datos.
- La **distancia es inyectable**, de modo que se puede sustituir por distancias reales por carretera (OSRM, Google, etc.) sin tocar el algoritmo.
- Valida su entrada: capacidad entera ≥ 1, pedidos sin duplicar y depósito definido para cada zona.

## 5. Flujo previsto en el sistema

```
Disparador (acción del admin o proceso programado)
      │
      ▼
Obtener pedidos PENDING de una fecha  ──►  planRoutes()  ──►  rutas propuestas
                                                                   │
                                  asignar cada ruta a un repartidor disponible
                                                                   │
                                   crear Route + marcar pedidos ASSIGNED (transacción)
```

El servicio actual `RoutesService.assignRoute` ya implementa el último paso de forma atómica; el motor reemplazará la selección manual de pedidos que hoy hace el administrador.

## 6. Alcance actual y trabajo pendiente

Esta entrega implementa y prueba **el algoritmo**. Todavía **no está conectado a la API**. Pendiente:

1. **Coordenadas.** `Order` solo guarda `deliveryAddress` (texto) y `Zone` no tiene depósito. Se necesita `latitude`/`longitude` en `Order` y coordenadas del depósito en `Zone` (migración de esquema, a acordar con el equipo). Mientras tanto el algoritmo se prueba con coordenadas sintéticas y distancia inyectable.
2. **Endpoint de armado** por fecha y zona, y el disparador (manual o programado).
3. **Pedidos de último momento.** Si llega un pedido con rutas ya armadas, se aplicará una inserción de menor costo: insertarlo en la ruta existente donde menos aumente la distancia, siempre que tenga menos de 4 paradas; si ninguna tiene espacio, generar una ruta nueva.
4. **Concurrencia.** Evitar que dos solicitudes simultáneas asignen el mismo pedido o repartidor. `assignRoute` revalida dentro de una transacción, pero falta bloqueo explícito a nivel de fila (`SELECT … FOR UPDATE`) y pruebas de carga que lo demuestren.
5. **Ventanas de tiempo.** El enunciado menciona la hora aproximada de entrega. Esta versión agrupa solo por fecha; incorporar ventanas horarias (VRPTW) sería una extensión posterior.

## 7. Limitaciones conocidas

- Es una **heurística**: no garantiza el óptimo global.
- Con Haversine mide línea recta, no el recorrido real por calles.
- Un pedido cuyo ahorro con todos los demás sea nulo o negativo queda en una ruta propia, aunque quepa en una ruta con espacio libre.
- Solo se unen rutas por sus extremos, como en la formulación original del algoritmo.

## 8. Pruebas

[`clarke-wright.spec.ts`](../src/modules/routes/algorithms/clarke-wright.spec.ts) cubre: entrada vacía, un pedido, capacidad (4, 5 y capacidad personalizada), pedidos en lados opuestos del depósito, separación por zona y fecha, mejora frente a una ruta por pedido, determinismo ante el orden de entrada, distancia inyectada, validaciones de entrada y una prueba de propiedad con 300 pedidos aleatorios (cada pedido aparece una sola vez y ninguna ruta supera 4).

```bash
pnpm test clarke-wright
```

## 9. Referencia

G. Clarke y J. W. Wright, "Scheduling of vehicles from a central depot to a number of delivery points," *Operations Research*, vol. 12, no. 4, pp. 568-581, 1964.
