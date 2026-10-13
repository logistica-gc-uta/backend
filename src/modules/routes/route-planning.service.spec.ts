import { BadRequestException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { haversineKm } from './algorithms/geo.util.js';
import { roundKm } from './algorithms/route-metrics.js';
import {
  DISTANCE_METHOD,
  ExclusionReason,
  MAX_ORDERS_PER_ZONE,
  PLANNING_TIME_ZONE,
  RoutePlanningService,
} from './route-planning.service.js';

const DAY = '2030-02-14';
const NOON = Temporal.Instant.from('2030-02-14T17:00:00Z');
const AFTERNOON = Temporal.Instant.from('2030-02-14T20:00:00Z');

const zone = (id: string, code: string, depot: [number, number] | null = [-1.241, -78.619]) => ({
  id,
  name: `Zona ${code}`,
  code,
  depotLat: depot ? depot[0] : null,
  depotLng: depot ? depot[1] : null,
});

const order = (id: string, z: ReturnType<typeof zone>, overrides: Record<string, unknown> = {}) => ({
  id,
  zoneId: z.id,
  zone: z,
  status: 'PENDING',
  requiresAdministrativeReview: false,
  scheduledDeliveryDate: NOON,
  deliveryLat: -1.2491,
  deliveryLng: -78.6167,
  ...overrides,
});

describe('RoutePlanningService', () => {
  let service: RoutePlanningService;
  let orders: any[];
  let claims: any[];
  let zonesById: Record<string, unknown>;
  let captured: { gte?: unknown; lt?: unknown; filters: unknown[] };
  let claimQueryArgs: unknown[];
  let writes: jest.Mock;

  beforeEach(() => {
    orders = [];
    claims = [];
    zonesById = {};
    captured = { filters: [] };
    claimQueryArgs = [];
    writes = jest.fn();

    const orderChain: any = {
      where: jest.fn((arg: unknown) => {
        if (typeof arg === 'function') {
          (arg as (o: unknown) => void)({
            scheduledDeliveryDate: {
              gte: (v: unknown) => (captured.gte = v),
              lt: (v: unknown) => (captured.lt = v),
            },
          });
        } else {
          captured.filters.push(arg);
        }
        return orderChain;
      }),
      include: jest.fn(() => orderChain),
      all: jest.fn(async () => orders),
    };
    const claimChain: any = {
      where: jest.fn((arg: unknown) => {
        if (typeof arg === 'function') {
          (arg as (c: unknown) => void)({
            orderId: { in: (ids: string[]) => claimQueryArgs.push(ids) },
          });
        } else {
          claimQueryArgs.push(arg);
        }
        return claimChain;
      }),
      all: jest.fn(async () => claims),
    };
    const prisma: any = {
      order: orderChain,
      zone: { where: ({ id }: { id: string }) => ({ first: async () => zonesById[id] ?? null }) },
      client: {
        orm: { public: { OrderClaim: claimChain } },
        transaction: writes,
      },
    };
    service = new RoutePlanningService(prisma);
  });

  it('propone 2 rutas (4 + 1) para 5 pedidos de una zona y usa el instante programado como routeDate', async () => {
    const z = zone('z1', 'CEN-01');
    orders = ['a', 'b', 'c', 'd', 'e'].map((id) => order(id, z));

    const result = await service.propose({ date: DAY });

    expect(result.date).toBe(DAY);
    expect(result.timeZone).toBe(PLANNING_TIME_ZONE);
    expect(result.distanceMethod).toBe(DISTANCE_METHOD);
    expect(result.capacity).toBe(4);
    expect(result.proposals.map((p) => p.orderIds.length).sort((x, y) => x - y)).toEqual([1, 4]);
    for (const proposal of result.proposals) {
      expect(proposal.zoneId).toBe('z1');
      expect(proposal.zoneCode).toBe('CEN-01');
      expect(proposal.depot).toEqual({ lat: -1.241, lng: -78.619 });
      expect(proposal.routeDate).toBe('2030-02-14T17:00:00Z');
      expect(proposal.totalDistanceKm).toBeGreaterThan(0);
      expect(proposal.stops.map((s) => s.sequence)).toEqual(proposal.orderIds.map((_, i) => i + 1));
    }
    expect(result.summary).toMatchObject({ candidateOrders: 5, plannedOrders: 5, excludedOrders: 0, routes: 2 });
  });

  it('cada pedido aparece en una sola ruta y ninguna supera 4 paradas', async () => {
    const z = zone('z1', 'CEN-01');
    orders = Array.from({ length: 37 }, (_, i) =>
      order(`o${String(i).padStart(2, '0')}`, z, {
        deliveryLat: -1.24 - (i % 7) * 0.004,
        deliveryLng: -78.62 - Math.floor(i / 7) * 0.004,
      }),
    );

    const { proposals } = await service.propose({ date: DAY });

    const ids = proposals.flatMap((p) => p.orderIds);
    expect(ids).toHaveLength(37);
    expect(new Set(ids).size).toBe(37);
    proposals.forEach((p) => expect(p.orderIds.length).toBeLessThanOrEqual(4));
  });

  it('separa las propuestas por zona', async () => {
    const z1 = zone('z1', 'CEN-01');
    const z2 = zone('z2', 'FIC-02', [-1.249, -78.632]);
    orders = [order('a', z1), order('b', z2), order('c', z1)];

    const { proposals } = await service.propose({ date: DAY });

    expect(proposals).toHaveLength(2);
    for (const p of proposals) {
      const expectedZone = p.zoneId;
      expect(p.orderIds.every((id) => orders.find((o) => o.id === id).zoneId === expectedZone)).toBe(true);
    }
  });

  it('agrupa pedidos del mismo día a distinta hora y propone el instante más temprano como routeDate', async () => {
    const z = zone('z1', 'CEN-01');
    orders = [order('tarde', z, { scheduledDeliveryDate: AFTERNOON }), order('temprano', z)];

    const { proposals } = await service.propose({ date: DAY });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.orderIds).toHaveLength(2);
    expect(proposals[0]!.scheduledInstants).toEqual(['2030-02-14T17:00:00Z', '2030-02-14T20:00:00Z']);
    expect(proposals[0]!.routeDate).toBe('2030-02-14T17:00:00Z');
  });

  it('ordena los instantes cronológicamente aunque difieran en formato o longitud', async () => {
    const z = zone('z1', 'CEN-01');
    const withSeconds = Temporal.Instant.from('2030-02-14T09:30:15Z');
    orders = [order('a', z, { scheduledDeliveryDate: NOON }), order('b', z, { scheduledDeliveryDate: withSeconds })];

    const { proposals } = await service.propose({ date: DAY });

    expect(proposals[0]!.scheduledInstants).toEqual(['2030-02-14T09:30:15Z', '2030-02-14T17:00:00Z']);
    expect(proposals[0]!.routeDate).toBe('2030-02-14T09:30:15Z');
  });

  describe('ahorro frente a la línea base (cada pedido por separado, ida y vuelta al depósito)', () => {
    // Depósito en (0, 0) y pedidos en (0,1; 0): 11,1195 km en línea recta.
    const ORIGIN = zone('z1', 'CEN-01', [0, 0]);
    const at = (id: string, z = ORIGIN, lat = 0.1) => order(id, z, { deliveryLat: lat, deliveryLng: 0 });
    const d = haversineKm({ lat: 0, lng: 0 }, { lat: 0.1, lng: 0 });

    it('calcula la línea base, el ahorro en km y el porcentaje por propuesta', async () => {
      orders = ['a', 'b', 'c', 'd'].map((id) => at(id));

      const { proposals } = await service.propose({ date: DAY });

      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.baselineKm).toBe(roundKm(8 * d)); // 4 viajes de ida y vuelta
      expect(proposals[0]!.totalDistanceKm).toBe(roundKm(2 * d)); // una sola salida
      expect(proposals[0]!.savingsKm).toBe(roundKm(roundKm(8 * d) - roundKm(2 * d)));
      expect(proposals[0]!.savingsPercent).toBe(75);
    });

    it('una ruta de un solo pedido no ahorra y no divide entre 0', async () => {
      orders = [at('solo')];

      const { proposals, summary } = await service.propose({ date: DAY });

      expect(proposals[0]!.savingsKm).toBe(0);
      expect(proposals[0]!.savingsPercent).toBe(0);
      expect(summary.savingsPercent).toBe(0);
    });

    it('con pedidos en el depósito la línea base es 0 y el ahorro es 0, nunca NaN', async () => {
      orders = [at('x', ORIGIN, 0), at('y', ORIGIN, 0)];

      const { proposals, summary } = await service.propose({ date: DAY });

      expect(proposals.every((p) => p.baselineKm === 0 && p.savingsKm === 0 && p.savingsPercent === 0)).toBe(true);
      expect(summary).toMatchObject({ baselineKm: 0, plannedKm: 0, savingsKm: 0, savingsPercent: 0 });
    });

    it('los totales del día son la suma de lo mostrado por propuesta y cuadran entre sí', async () => {
      orders = ['a', 'b', 'c', 'd', 'e'].map((id) => at(id)); // 4 + 1

      const { proposals, summary } = await service.propose({ date: DAY });

      const sum = (pick: (p: (typeof proposals)[number]) => number) => roundKm(proposals.reduce((acc, p) => acc + pick(p), 0));
      expect(proposals).toHaveLength(2);
      expect(summary.baselineKm).toBe(sum((p) => p.baselineKm));
      expect(summary.plannedKm).toBe(sum((p) => p.totalDistanceKm));
      expect(summary.savingsKm).toBe(roundKm(summary.baselineKm - summary.plannedKm));
      expect(summary.baselineKm).toBe(roundKm(10 * d));
      expect(summary.plannedKm).toBe(roundKm(4 * d));
      expect(summary.savingsPercent).toBe(60);
    });

    it('no cuenta los pedidos excluidos en la línea base del día', async () => {
      orders = [at('ok'), order('sin-coords', ORIGIN, { deliveryLat: null, deliveryLng: null })];

      const { summary } = await service.propose({ date: DAY });

      expect(summary.plannedOrders).toBe(1);
      expect(summary.baselineKm).toBe(roundKm(2 * d));
    });

    it('sin pedidos todas las cifras de ahorro son 0', async () => {
      const { summary } = await service.propose({ date: DAY });

      expect(summary).toMatchObject({ baselineKm: 0, plannedKm: 0, savingsKm: 0, savingsPercent: 0 });
    });
  });

  it('excluye y explica los pedidos no planificables en lugar de ocultarlos', async () => {
    const z = zone('z1', 'CEN-01');
    const noDepot = zone('z2', 'HUA-03', null);
    orders = [
      order('ok', z),
      order('sin-coords', z, { deliveryLat: null, deliveryLng: null }),
      order('coords-invalidas', z, { deliveryLat: 200, deliveryLng: 0 }),
      order('sin-depot', noDepot),
      order('reservado', z),
      order('revision', z, { requiresAdministrativeReview: true }),
    ];
    claims = [{ orderId: 'reservado' }];

    const result = await service.propose({ date: DAY });

    expect(result.proposals.flatMap((p) => p.orderIds)).toEqual(['ok']);
    const byId = Object.fromEntries(result.excluded.map((e) => [e.orderId, e.reasons]));
    expect(byId['sin-coords']).toEqual(['MISSING_DELIVERY_COORDINATES']);
    expect(byId['coords-invalidas']).toEqual(['INVALID_DELIVERY_COORDINATES']);
    expect(byId['sin-depot']).toEqual(['MISSING_ZONE_DEPOT_COORDINATES']);
    expect(byId['reservado']).toEqual([ExclusionReason.ACTIVE_ROUTE_CLAIM]);
    expect(byId['revision']).toEqual([ExclusionReason.ADMINISTRATIVE_REVIEW_REQUIRED]);
    expect(result.summary).toMatchObject({ candidateOrders: 6, plannedOrders: 1, excludedOrders: 5, routes: 1 });
    const excludedIds = result.excluded.map((e) => e.orderId);
    expect(excludedIds).toEqual(excludedIds.toSorted((a, b) => a.localeCompare(b)));
  });

  it('acumula varias razones de exclusión para un mismo pedido', async () => {
    const z = zone('z1', 'CEN-01');
    orders = [order('x', z, { deliveryLat: null, deliveryLng: null, requiresAdministrativeReview: true })];
    claims = [{ orderId: 'x' }];

    const { excluded } = await service.propose({ date: DAY });

    expect(excluded[0]!.reasons).toEqual([
      'MISSING_DELIVERY_COORDINATES',
      ExclusionReason.ACTIVE_ROUTE_CLAIM,
      ExclusionReason.ADMINISTRATIVE_REVIEW_REQUIRED,
    ]);
  });

  it('sin pedidos devuelve una respuesta vacía y no consulta reservas', async () => {
    const result = await service.propose({ date: DAY });

    expect(result.proposals).toEqual([]);
    expect(result.excluded).toEqual([]);
    expect(result.summary).toMatchObject({ candidateOrders: 0, plannedOrders: 0, excludedOrders: 0, routes: 0 });
    expect(claimQueryArgs).toEqual([]);
  });

  it('consulta solo PENDING dentro del día calendario de America/Guayaquil', async () => {
    await service.propose({ date: DAY });

    expect(captured.filters).toContainEqual({ status: 'PENDING' });
    expect((captured.gte as Temporal.Instant).toString()).toBe('2030-02-14T05:00:00Z');
    expect((captured.lt as Temporal.Instant).toString()).toBe('2030-02-15T05:00:00Z');
  });

  it('solo considera reservas activas (releasedAt nulo)', async () => {
    const z = zone('z1', 'CEN-01');
    orders = [order('a', z)];

    await service.propose({ date: DAY });

    expect(claimQueryArgs).toContainEqual(['a']);
    expect(claimQueryArgs).toContainEqual({ releasedAt: null });
  });

  it('filtra por zona cuando se indica zoneId', async () => {
    zonesById['z1'] = zone('z1', 'CEN-01');

    await service.propose({ date: DAY, zoneId: 'z1' });

    expect(captured.filters).toContainEqual({ zoneId: 'z1' });
  });

  it('responde 404 si la zona indicada no existe', async () => {
    await expect(service.propose({ date: DAY, zoneId: 'no-existe' })).rejects.toThrow(NotFoundException);
  });

  it.each(['2030-02-30', '14-02-2030', '2030-2-14', 'mañana', ''])('rechaza la fecha inválida %p con 400', async (date) => {
    await expect(service.propose({ date })).rejects.toThrow(BadRequestException);
  });

  it('rechaza con 422 una zona con demasiados pedidos planificables', async () => {
    const z = zone('z1', 'CEN-01');
    orders = Array.from({ length: MAX_ORDERS_PER_ZONE + 1 }, (_, i) => order(`o${i}`, z));

    await expect(service.propose({ date: DAY })).rejects.toThrow(UnprocessableEntityException);
  });

  it('es de solo lectura: no abre transacciones ni escribe', async () => {
    const z = zone('z1', 'CEN-01');
    orders = [order('a', z), order('b', z)];

    await service.propose({ date: DAY });

    expect(writes).not.toHaveBeenCalled();
  });

  it('es determinista: el orden de los pedidos devueltos por la BD no cambia el resultado', async () => {
    const z = zone('z1', 'CEN-01');
    const base = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) =>
      order(id, z, { deliveryLat: -1.24 - i * 0.003, deliveryLng: -78.62 + (i % 2) * 0.004 }),
    );
    orders = base;
    const forward = await service.propose({ date: DAY });
    orders = [...base].reverse();
    const backward = await service.propose({ date: DAY });

    expect(backward).toEqual(forward);
  });
});
