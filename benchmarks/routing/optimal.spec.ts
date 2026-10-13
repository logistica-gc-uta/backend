import type { RoutingOrder } from '../../src/modules/routes/algorithms/clarke-wright.js';
import { haversineKm as DISTANCE } from '../../src/modules/routes/algorithms/geo.util.js';
import { DEPOT, ZONE_ID, generateDataset } from './datasets.js';
import { independentTripsKm } from './metrics.js';
import { MAX_EXACT_ORDERS, optimalPlanKm } from './optimal.js';

const depots = { [ZONE_ID]: DEPOT };

describe('solución exacta (instancias pequeñas)', () => {
  // Fuerza bruta independiente: todas las particiones en rutas y todas las permutaciones.
  function bruteForce(orders: RoutingOrder[], capacity: number): number {
    const permutations = <T,>(items: T[]): T[][] =>
      items.length <= 1 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
    const routeCost = (stops: RoutingOrder[]) =>
      Math.min(
        ...permutations(stops).map((perm) => {
          let km = DISTANCE(DEPOT, perm[0]!.location);
          for (let k = 1; k < perm.length; k++) km += DISTANCE(perm[k - 1]!.location, perm[k]!.location);
          return km + DISTANCE(perm[perm.length - 1]!.location, DEPOT);
        }),
      );
    const best = (remaining: RoutingOrder[]): number => {
      if (remaining.length === 0) return 0;
      const [first, ...others] = remaining;
      let min = Infinity;
      for (let mask = 0; mask < 1 << others.length; mask++) {
        const group = [first!, ...others.filter((_, i) => mask & (1 << i))];
        if (group.length > capacity) continue;
        const rest = others.filter((_, i) => !(mask & (1 << i)));
        min = Math.min(min, routeCost(group) + best(rest));
      }
      return min;
    };
    return best(orders);
  }

  it.each([1, 2, 3, 4, 5, 6])('coincide con la fuerza bruta para %i pedidos', (n) => {
    for (let seed = 1; seed <= 5; seed++) {
      const { orders } = generateDataset('uniform', n, seed);
      for (const capacity of [1, 2, 4]) {
        expect(optimalPlanKm(orders, DEPOT, capacity, DISTANCE)).toBeCloseTo(bruteForce(orders, capacity), 9);
      }
    }
  });

  it('sin pedidos cuesta 0 y con capacidad 1 es la suma de viajes independientes', () => {
    expect(optimalPlanKm([], DEPOT, 4, DISTANCE)).toBe(0);
    const { orders } = generateDataset('uniform', 6, 2);
    expect(optimalPlanKm(orders, DEPOT, 1, DISTANCE)).toBeCloseTo(independentTripsKm(orders, depots, DISTANCE), 9);
  });

  it('rechaza tamaños y capacidades fuera de rango', () => {
    expect(() => optimalPlanKm(generateDataset('uniform', MAX_EXACT_ORDERS + 1, 1).orders, DEPOT, 4, DISTANCE)).toThrow('como máximo');
    expect(() => optimalPlanKm([], DEPOT, 0, DISTANCE)).toThrow('capacidad');
  });
});
