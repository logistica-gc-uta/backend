import type { RoutingOrder } from '../../src/modules/routes/algorithms/clarke-wright.js';
import type { GeoPoint } from '../../src/modules/routes/algorithms/geo.util.js';
import { DISTANCE, depotsFor, plan, shuffled, signature } from './common.js';
import { DELIVERY_DATE, DEPOT, ZONE_ID, generateDataset } from './datasets.js';
import { verifyProposal } from './invariants.js';
import { type Depots, deterministicMetrics } from './metrics.js';

export interface EdgeCaseResult {
  id: string;
  description: string;
  expected: string;
  observed: string;
  pass: boolean;
}

const at = (dLat: number, dLng: number): GeoPoint => ({ lat: DEPOT.lat + dLat, lng: DEPOT.lng + dLng });
const makeOrder = (id: string, location: GeoPoint, zoneId = ZONE_ID, deliveryDate = DELIVERY_DATE): RoutingOrder => ({
  id,
  zoneId,
  deliveryDate,
  location,
});
const depotsOf = (...zones: string[]): Depots => Object.fromEntries(zones.map((zone) => [zone, DEPOT]));

interface EdgeCaseDefinition {
  id: string;
  description: string;
  expected: string;
  run: () => { pass: boolean; observed: string };
}

const edgeCases: EdgeCaseDefinition[] = [
  {
    id: 'EDGE-01-empty',
    description: 'Sin pedidos',
    expected: '0 rutas, 0 km y ahorro 0 % (sin NaN)',
    run: () => {
      const routes = plan([], depotsOf(ZONE_ID));
      const m = deterministicMetrics([], routes, depotsOf(ZONE_ID), DISTANCE);
      return {
        pass: routes.length === 0 && m.plannedKm === 0 && m.baselineKm === 0 && m.savingsPercent === 0,
        observed: `${routes.length} rutas, ${m.plannedKm} km, ahorro ${m.savingsPercent} %`,
      };
    },
  },
  {
    id: 'EDGE-02-single-order',
    description: 'Un solo pedido',
    expected: '1 ruta de 1 parada y ahorro 0 %',
    run: () => {
      const orders = [makeOrder('a', at(0.01, 0.01))];
      const routes = plan(orders, depotsOf(ZONE_ID));
      const m = deterministicMetrics(orders, routes, depotsOf(ZONE_ID), DISTANCE);
      return { pass: routes.length === 1 && routes[0]!.orderIds.length === 1 && m.savingsPercent === 0, observed: `${routes.length} ruta(s), ahorro ${m.savingsPercent} %` };
    },
  },
  {
    id: 'EDGE-03-duplicate-coordinates',
    description: '8 pedidos en las mismas coordenadas',
    expected: '2 rutas de 4 paradas y ahorro 75 %',
    run: () => {
      const orders = Array.from({ length: 8 }, (_, i) => makeOrder(`d${i}`, at(0.02, 0.02)));
      const routes = plan(orders, depotsOf(ZONE_ID));
      const m = deterministicMetrics(orders, routes, depotsOf(ZONE_ID), DISTANCE);
      const sizes = routes.map((r) => r.orderIds.length).join('+');
      return { pass: routes.length === 2 && sizes === '4+4' && Math.abs(m.savingsPercent - 75) < 1e-6, observed: `${routes.length} rutas (${sizes}), ahorro ${m.savingsPercent} %` };
    },
  },
  {
    id: 'EDGE-04-capacity-4-orders',
    description: '4 pedidos cercanos (límite exacto de capacidad)',
    expected: '1 ruta de 4 paradas',
    run: () => {
      const orders = [0, 1, 2, 3].map((i) => makeOrder(`c${i}`, at(0.02, 0.02 + i * 0.001)));
      const routes = plan(orders, depotsOf(ZONE_ID));
      return { pass: routes.length === 1 && routes[0]!.orderIds.length === 4, observed: `${routes.length} ruta(s): ${routes.map((r) => r.orderIds.length).join('+')}` };
    },
  },
  {
    id: 'EDGE-05-capacity-5-orders',
    description: '5 pedidos cercanos (uno por encima de la capacidad)',
    expected: '2 rutas (4 + 1), ninguna con más de 4',
    run: () => {
      const orders = [0, 1, 2, 3, 4].map((i) => makeOrder(`c${i}`, at(0.02, 0.02 + i * 0.001)));
      const routes = plan(orders, depotsOf(ZONE_ID));
      const sizes = routes.map((r) => r.orderIds.length).sort((a, b) => a - b).join('+');
      return { pass: sizes === '1+4', observed: `${routes.length} rutas (${sizes})` };
    },
  },
  {
    id: 'EDGE-06-zones-and-dates',
    description: '18 pedidos en 3 zonas y 2 fechas',
    expected: '6 rutas, ninguna mezcla zona o fecha, sin duplicados',
    run: () => {
      const orders: RoutingOrder[] = [];
      for (const zone of ['Z1', 'Z2', 'Z3']) {
        for (const date of ['2030-02-14', '2030-02-15']) {
          for (let i = 0; i < 3; i++) orders.push(makeOrder(`${zone}-${date}-${i}`, at(0.01 + i * 0.001, 0.01), zone, date));
        }
      }
      const depots = depotsOf('Z1', 'Z2', 'Z3');
      const routes = plan(orders, depots);
      const violations = verifyProposal({ orders, routes, depots, distance: DISTANCE });
      return { pass: routes.length === 6 && violations.length === 0, observed: `${routes.length} rutas, ${violations.length} violaciones` };
    },
  },
  {
    id: 'EDGE-07-missing-depot',
    description: 'Zona sin depósito',
    expected: 'Error explícito (no se inventa un depósito)',
    run: () => {
      try {
        plan([makeOrder('a', at(0.01, 0.01), 'ZX')], depotsOf(ZONE_ID));
        return { pass: false, observed: 'no lanzó error' };
      } catch (error) {
        const message = (error as Error).message;
        return { pass: /depósito/.test(message), observed: message };
      }
    },
  },
  {
    id: 'EDGE-08-orders-at-depot',
    description: 'Pedidos exactamente en el depósito (línea base de 0 km)',
    expected: 'ahorro 0 % finito: no se divide entre 0',
    run: () => {
      const orders = [0, 1, 2].map((i) => makeOrder(`p${i}`, { ...DEPOT }));
      const routes = plan(orders, depotsOf(ZONE_ID));
      const m = deterministicMetrics(orders, routes, depotsOf(ZONE_ID), DISTANCE);
      return { pass: m.baselineKm === 0 && m.savingsPercent === 0 && Number.isFinite(m.savingsPercent), observed: `base ${m.baselineKm} km, ahorro ${m.savingsPercent} %, ${routes.length} rutas` };
    },
  },
  {
    id: 'EDGE-09-opposite-sides',
    description: 'Dos pedidos en lados opuestos del depósito',
    expected: '2 rutas (unirlos no ahorra distancia)',
    run: () => {
      const orders = [makeOrder('n', at(0.02, 0)), makeOrder('s', at(-0.02, 0))];
      const routes = plan(orders, depotsOf(ZONE_ID));
      return { pass: routes.length === 2, observed: `${routes.length} rutas` };
    },
  },
  {
    id: 'EDGE-10-order-invariance',
    description: '100 pedidos con la entrada en otro orden',
    expected: 'resultado idéntico',
    run: () => {
      const dataset = generateDataset('uniform', 100, 7);
      const depots = depotsFor(dataset.orders, dataset.depot);
      const same = signature(plan(dataset.orders, depots)) === signature(plan(shuffled(dataset.orders, 7), depots));
      return { pass: same, observed: same ? 'idéntico' : 'distinto' };
    },
  },
  {
    id: 'EDGE-11-invalid-capacity',
    description: 'Capacidad 0',
    expected: 'Error explícito',
    run: () => {
      try {
        plan([makeOrder('a', at(0.01, 0.01))], depotsOf(ZONE_ID), 0);
        return { pass: false, observed: 'no lanzó error' };
      } catch (error) {
        return { pass: /capacidad/.test((error as Error).message), observed: (error as Error).message };
      }
    },
  },
  {
    id: 'EDGE-12-duplicate-order-id',
    description: 'Dos pedidos con el mismo id',
    expected: 'Error explícito (sin duplicación silenciosa)',
    run: () => {
      try {
        plan([makeOrder('a', at(0.01, 0.01)), makeOrder('a', at(0.02, 0.02))], depotsOf(ZONE_ID));
        return { pass: false, observed: 'no lanzó error' };
      } catch (error) {
        return { pass: /duplicado/.test((error as Error).message), observed: (error as Error).message };
      }
    },
  },
];

export function runEdgeCases(): EdgeCaseResult[] {
  return edgeCases.map(({ id, description, expected, run }) => ({ id, description, expected, ...run() }));
}
