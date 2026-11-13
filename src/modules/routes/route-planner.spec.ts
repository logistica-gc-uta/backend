import { existsSync } from 'node:fs';
import path from 'node:path';
import { planRoutes, type RoutingOrder } from './algorithms/clarke-wright.js';
import { matrixDistance, matrixDuration, type DistanceMatrix } from './algorithms/matrix-distance.js';
import { RoutePlanner, planKey, resolveWorkerFile } from './route-planner.js';

const depots = { z1: { lat: -1.24, lng: -78.62 } };
const makeOrders = (count: number): RoutingOrder[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `o-${String(i).padStart(4, '0')}`,
    zoneId: 'z1',
    deliveryDate: '2030-02-14',
    location: { lat: -1.24 + (i % 17) * 0.002, lng: -78.62 + Math.floor(i / 17) * 0.002 },
  }));

describe('RoutePlanner (P-1 de #15): cálculo fuera del hilo, memoizado y sin duplicar trabajo', () => {
  it('da el mismo resultado que planRoutes', async () => {
    const orders = makeOrders(60);
    const planner = new RoutePlanner(undefined);
    expect(await planner.plan(orders, { depots, capacity: 4 })).toEqual(planRoutes(orders, { depots, capacity: 4 }));
  });

  it('la misma entrada se sirve de caché y cambiar un dato fuerza recálculo', async () => {
    const planner = new RoutePlanner(undefined);
    const orders = makeOrders(40);
    await planner.plan(orders, { depots, capacity: 4 });
    await planner.plan([...orders].reverse(), { depots, capacity: 4 }); // el orden de llegada no importa
    expect(planner.stats).toMatchObject({ computed: 1, cacheHits: 1 });

    const moved = orders.map((o, i) => (i === 0 ? { ...o, location: { lat: -1.5, lng: -78.5 } } : o));
    await planner.plan(moved, { depots, capacity: 4 });
    expect(planner.stats.computed).toBe(2);
  });

  it('las peticiones idénticas concurrentes comparten un solo cálculo', async () => {
    const planner = new RoutePlanner(undefined);
    const orders = makeOrders(80);
    const results = await Promise.all(Array.from({ length: 10 }, () => planner.plan(orders, { depots, capacity: 4 })));
    expect(planner.stats.computed).toBe(1);
    expect(planner.stats.joined).toBe(9);
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it('el resultado devuelto es una copia: modificarlo no contamina la caché', async () => {
    const planner = new RoutePlanner(undefined);
    const orders = makeOrders(20);
    const first = await planner.plan(orders, { depots, capacity: 4 });
    first[0]!.orderIds.push('basura');
    expect((await planner.plan(orders, { depots, capacity: 4 }))[0]!.orderIds).not.toContain('basura');
  });

  it('un error de datos se propaga y no queda en caché', async () => {
    const planner = new RoutePlanner(undefined);
    await expect(planner.plan(makeOrders(5), { depots: {}, capacity: 4 })).rejects.toThrow(/depósito/);
    await expect(planner.plan(makeOrders(5), { depots: {}, capacity: 4 })).rejects.toThrow(/depósito/);
  });

  it('la clave depende del contenido y no del orden, incluyendo horario, margen y durationS', () => {
    const orders = makeOrders(10);
    expect(planKey(orders, { depots, capacity: 4 })).toBe(planKey([...orders].reverse(), { depots, capacity: 4 }));
    expect(planKey(orders, { depots, capacity: 4 })).not.toBe(planKey(orders, { depots, capacity: 3 }));

    // scheduledAtMs
    const scheduled = orders.map((o, i) => ({ ...o, scheduledAtMs: i === 0 ? 0 : 1_000 }));
    expect(planKey(orders, { depots, capacity: 4 })).not.toBe(planKey(scheduled, { depots, capacity: 4 }));
    expect(planKey(scheduled, { depots, capacity: 4 })).not.toBe(
      planKey(
        scheduled.map((o, i) => (i === 0 ? { ...o, scheduledAtMs: 500 } : o)),
        { depots, capacity: 4 },
      ),
    );

    // timeWindowMarginMinutes
    expect(planKey(scheduled, { depots, capacity: 4 })).not.toBe(
      planKey(scheduled, { depots, capacity: 4, timeWindowMarginMinutes: 0 }),
    );
    expect(planKey(scheduled, { depots, capacity: 4, timeWindowMarginMinutes: 0 })).not.toBe(
      planKey(scheduled, { depots, capacity: 4, timeWindowMarginMinutes: 30 }),
    );

    // matrix.durationS
    const pts = [depots.z1, orders[0]!.location];
    const baseMatrix: DistanceMatrix = {
      points: pts,
      distanceKm: [
        [0, 1],
        [1, 0],
      ],
    };
    const withDur: DistanceMatrix = {
      ...baseMatrix,
      durationS: [
        [0, 120],
        [120, 0],
      ],
    };
    const diffDur: DistanceMatrix = {
      ...baseMatrix,
      durationS: [
        [0, 240],
        [240, 0],
      ],
    };
    expect(planKey(orders, { depots, matrix: baseMatrix })).not.toBe(planKey(orders, { depots, matrix: withDur }));
    expect(planKey(orders, { depots, matrix: withDur })).not.toBe(planKey(orders, { depots, matrix: diffDur }));
  });

  it('matrixDuration devuelve undefined si no hay durationS y falla si falta un punto', () => {
    const p0 = depots.z1;
    const p1 = { lat: -1.23, lng: -78.61 };
    const withoutDuration: DistanceMatrix = {
      points: [p0, p1],
      distanceKm: [
        [0, 1],
        [1, 0],
      ],
    };
    expect(matrixDuration(withoutDuration)).toBeUndefined();

    const withDuration: DistanceMatrix = {
      ...withoutDuration,
      durationS: [
        [0, 90],
        [150, 0],
      ],
    };
    const durationFn = matrixDuration(withDuration)!;
    expect(durationFn(p0, p1)).toBe(90);
    expect(durationFn(p1, p0)).toBe(150);
    expect(() => durationFn(p0, { lat: 0, lng: 0 })).toThrow(/no está en la matriz/);
  });

  it('RoutePlanner pasa timeWindowMarginMinutes, durationS y directional cuando hay matriz y coincide con planRoutes', async () => {
    const planner = new RoutePlanner(undefined);
    const pA = { lat: -1.23, lng: -78.62 };
    const pB = { lat: -1.25, lng: -78.63 };
    const pC = { lat: -1.26, lng: -78.64 };
    const scheduledOrders: RoutingOrder[] = [
      { id: 'a', zoneId: 'z1', deliveryDate: '2030-02-14', location: pA, scheduledAtMs: Date.parse('2030-02-14T10:00:00Z') },
      { id: 'b', zoneId: 'z1', deliveryDate: '2030-02-14', location: pB, scheduledAtMs: Date.parse('2030-02-14T10:25:00Z') },
      { id: 'c', zoneId: 'z1', deliveryDate: '2030-02-14', location: pC, scheduledAtMs: Date.parse('2030-02-14T10:50:00Z') },
    ];
    const matrix: DistanceMatrix = {
      points: [depots.z1, pA, pB, pC],
      distanceKm: [
        [0, 2, 4, 6],
        [2, 0, 1, 5],
        [4, 3, 0, 1],
        [6, 5, 3, 0],
      ],
      durationS: [
        [0, 300, 600, 900],
        [300, 0, 120, 800],
        [600, 400, 0, 100],
        [900, 800, 400, 0],
      ],
    };

    const viaPlanner = await planner.plan(scheduledOrders, {
      depots,
      capacity: 4,
      timeWindowMarginMinutes: 30,
      matrix,
    });
    const direct = planRoutes(scheduledOrders, {
      depots,
      capacity: 4,
      timeWindowMarginMinutes: 30,
      distance: matrixDistance(matrix),
      duration: matrixDuration(matrix),
      directional: true,
    });

    expect(viaPlanner).toEqual(direct);
    expect(viaPlanner.map((r) => r.orderIds)).toEqual([['a', 'b'], ['c']]);
    expect(viaPlanner[0]!.totalDistance).toBe(7); // depot->A(2) + A->B(1) + B->depot(4)
  });

  it('sin build compilado no hay worker (tests y desarrollo calculan en línea)', () => {
    expect(resolveWorkerFile(path.join(process.cwd(), 'node_modules', '.bin', 'jest'))).toBeUndefined();
  });

  const compiled = path.join(process.cwd(), 'dist', 'modules/routes/algorithms/plan-routes.worker.js');
  (existsSync(compiled) ? it : it.skip)('con el build compilado calcula en un worker thread y coincide con el cálculo en línea', async () => {
    const planner = new RoutePlanner(compiled);
    const orders = makeOrders(300);
    try {
      const routes = await planner.plan(orders, { depots, capacity: 4 });
      expect(planner.stats.workerRuns).toBe(1);
      expect(routes).toEqual(planRoutes(orders, { depots, capacity: 4 }));

      const pA = { lat: -1.23, lng: -78.62 };
      const pB = { lat: -1.25, lng: -78.63 };
      const scheduledOrders: RoutingOrder[] = [
        { id: 'wa', zoneId: 'z1', deliveryDate: '2030-02-14', location: pA, scheduledAtMs: Date.parse('2030-02-14T10:00:00Z') },
        { id: 'wb', zoneId: 'z1', deliveryDate: '2030-02-14', location: pB, scheduledAtMs: Date.parse('2030-02-14T10:40:00Z') },
      ];
      const matrix: DistanceMatrix = {
        points: [depots.z1, pA, pB],
        distanceKm: [
          [0, 2, 4],
          [2, 0, 1],
          [4, 1, 0],
        ],
        durationS: [
          [0, 200, 400],
          [200, 0, 100],
          [400, 100, 0],
        ],
      };
      const workerScheduled = await planner.plan(scheduledOrders, {
        depots,
        capacity: 4,
        timeWindowMarginMinutes: 30,
        matrix,
      });
      expect(workerScheduled).toEqual(
        planRoutes(scheduledOrders, {
          depots,
          capacity: 4,
          timeWindowMarginMinutes: 30,
          distance: matrixDistance(matrix),
          duration: matrixDuration(matrix),
          directional: true,
        }),
      );

      await expect(planner.plan(makeOrders(3), { depots: {}, capacity: 4 })).rejects.toThrow(/depósito/);
    } finally {
      await planner.close();
    }
  });
});
