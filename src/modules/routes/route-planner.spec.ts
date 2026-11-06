import { existsSync } from 'node:fs';
import path from 'node:path';
import { planRoutes, type RoutingOrder } from './algorithms/clarke-wright.js';
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

  it('la clave depende del contenido y no del orden', () => {
    const orders = makeOrders(10);
    expect(planKey(orders, { depots, capacity: 4 })).toBe(planKey([...orders].reverse(), { depots, capacity: 4 }));
    expect(planKey(orders, { depots, capacity: 4 })).not.toBe(planKey(orders, { depots, capacity: 3 }));
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
      await expect(planner.plan(makeOrders(3), { depots: {}, capacity: 4 })).rejects.toThrow(/depósito/);
    } finally {
      await planner.close();
    }
  });
});
