import { createFakeOsrmFetch } from '../../../../test/fake-osrm.js';
import { planRoutes, type RoutingOrder } from '../algorithms/clarke-wright.js';
import { haversineKm } from '../algorithms/geo.util.js';
import { matrixDistance, pointKey, uniquePoints, type DistanceMatrix } from '../algorithms/matrix-distance.js';
import { RoutePlanner, planKey } from '../route-planner.js';
import { RoutePlanningService, ROAD_DISTANCE_METHOD } from '../route-planning.service.js';
import { RoadMetricsService } from './road-metrics.service.js';
import { DEFAULT_ROAD_CONFIG, RoadMetricsError, type RoadMatrix } from './road-metrics.types.js';

const depot = { lat: -1.241, lng: -78.619 };
const A = { lat: -1.236, lng: -78.628 };
const B = { lat: -1.232, lng: -78.612 };
const orders = (ids: [string, string]): RoutingOrder[] => [
  { id: ids[0], zoneId: 'z', deliveryDate: '2030-02-14', location: A },
  { id: ids[1], zoneId: 'z', deliveryDate: '2030-02-14', location: B },
];
/** Matriz asimétrica a propósito: ir depot→A→B→depot cuesta 3; el sentido contrario, 15. */
const asymmetric: DistanceMatrix = {
  points: [depot, A, B],
  distanceKm: [
    [0, 1, 5],
    [5, 0, 1],
    [1, 5, 0],
  ],
};

describe('Distancias sobre una matriz (#47)', () => {
  it('la matriz es direccional y un punto ausente falla en voz alta en lugar de dar cero', () => {
    const distance = matrixDistance(asymmetric);
    expect(distance(depot, A)).toBe(1);
    expect(distance(A, depot)).toBe(5);
    expect(() => distance(depot, { lat: 0, lng: 0 })).toThrow(/no está en la matriz/);
  });

  it('uniquePoints elimina coordenadas repetidas conservando el orden', () => {
    expect(uniquePoints([depot, A, { ...A }, B, depot])).toEqual([depot, A, B]);
    expect(pointKey(A)).toBe('-1.236000,-78.628000');
  });
});

describe('Clarke & Wright con distancias asimétricas (#47)', () => {
  it('con sentidos de calle recorre la visita en el sentido de menor costo real, sin importar los ids', () => {
    for (const ids of [['a', 'b'], ['b', 'a']] as [string, string][]) {
      const [route] = planRoutes(orders(ids), { depots: { z: depot }, capacity: 4, distance: matrixDistance(asymmetric), directional: true });
      expect(route!.orderIds).toEqual([ids[0], ids[1]]); // depot → A → B → depot
      expect(route!.totalDistance).toBe(3);
    }
  });

  it('sin el modo direccional el resultado con distancias simétricas es idéntico al histórico', () => {
    const input = orders(['a', 'b']);
    const base = planRoutes(input, { depots: { z: depot }, capacity: 4 });
    const directional = planRoutes(input, { depots: { z: depot }, capacity: 4, directional: true });
    expect(directional).toEqual(base);
  });
});

describe('RoutePlanner con matriz vial (#47)', () => {
  it('calcula con la matriz y es distinto a la línea recta; dos matrices distintas no comparten caché', async () => {
    const planner = new RoutePlanner(undefined);
    const input = orders(['a', 'b']);
    const road = await planner.plan(input, { depots: { z: depot }, capacity: 4, matrix: asymmetric });
    expect(road[0]!.totalDistance).toBe(3);
    const straight = await planner.plan(input, { depots: { z: depot }, capacity: 4 });
    expect(straight[0]!.totalDistance).toBeCloseTo(haversineKm(depot, A) + haversineKm(A, B) + haversineKm(B, depot), 6);

    const other: DistanceMatrix = { ...asymmetric, distanceKm: asymmetric.distanceKm.map((row) => row.map((km) => km * 2)) };
    expect(planKey(input, { depots: { z: depot }, matrix: asymmetric })).not.toBe(planKey(input, { depots: { z: depot }, matrix: other }));
    expect(planKey(input, { depots: { z: depot }, matrix: asymmetric })).not.toBe(planKey(input, { depots: { z: depot } }));
    expect((await planner.plan(input, { depots: { z: depot }, capacity: 4, matrix: other }))[0]!.totalDistance).toBe(6);
  });
});

describe('RoadMetricsService (#47)', () => {
  const active = (fetchImpl: typeof fetch, extra = {}) => new RoadMetricsService({ ...DEFAULT_ROAD_CONFIG, engine: 'OSRM', baseUrl: 'http://osrm.test', ...extra }, fetchImpl);

  it('desactivado: no calcula matriz, no ofrece trazado y su estado indica línea recta', async () => {
    const service = new RoadMetricsService({ ...DEFAULT_ROAD_CONFIG });
    expect(service.active).toBe(false);
    expect(await service.matrixFor([depot, A])).toBeNull();
    await expect(service.geometry([depot, A])).rejects.toThrow(/ROAD_ENGINE=OSRM/);
    expect(await service.status()).toMatchObject({ engine: 'HAVERSINE', configured: false, available: true, profile: null });
  });

  it('activo y disponible: estado con latencia y perfil, sin exponer la URL', async () => {
    const status = await active(createFakeOsrmFetch()).status();
    expect(status).toMatchObject({ engine: 'OSRM', configured: true, available: true, profile: 'car' });
    expect(status.latencyMs).toEqual(expect.any(Number));
    expect(JSON.stringify(status)).not.toContain('osrm.test');
  });

  it('activo y caído: el estado informa la no disponibilidad en lugar de lanzar', async () => {
    const status = await active(createFakeOsrmFetch({ mode: 'server-error' })).status();
    expect(status).toMatchObject({ engine: 'OSRM', configured: true, available: false, latencyMs: null });
    expect(status.message).toContain('error de servidor');
    expect(await active(createFakeOsrmFetch(), { baseUrl: null }).status()).toMatchObject({ configured: false, available: false });
  });

  it('activo: la matriz y el trazado se piden al motor', async () => {
    const service = active(createFakeOsrmFetch());
    expect((await service.matrixFor([depot, A]))!.provider).toBe('OSRM');
    expect((await service.geometry([depot, A, depot])).coordinates).toHaveLength(3);
  });
});

describe('RoutePlanningService con el motor vial (#47)', () => {
  const NOON = Temporal.Instant.from('2030-02-14T17:00:00Z');
  const zone = { id: 'z1', name: 'Zona', code: 'CEN-01', depotLat: depot.lat, depotLng: depot.lng };
  const order = (
    id: string,
    at: { lat: number; lng: number },
    scheduledDeliveryDate: Temporal.Instant = NOON,
  ) => ({
    id, zoneId: zone.id, zone, deliveryAddress: `Calle ${id}`, status: 'PENDING', requiresAdministrativeReview: false,
    scheduledDeliveryDate, deliveryLat: at.lat, deliveryLng: at.lng,
  });
  const build = (
    rows: any[],
    roads: RoadMetricsService,
    storeCoverage?: any,
    shopSettings?: any,
  ) => {
    const chain: any = { where: jest.fn(() => chain), include: jest.fn(() => chain), all: jest.fn(async () => rows) };
    const claimChain: any = { where: jest.fn(() => claimChain), all: jest.fn(async () => []) };
    const prisma: any = {
      order: chain,
      zone: { where: () => ({ first: async () => zone }) },
      client: { orm: { public: { OrderClaim: claimChain } }, transaction: jest.fn() },
    };
    return new RoutePlanningService(prisma, roads, storeCoverage, shopSettings);
  };
  const road = (fetchImpl: typeof fetch, extra = {}) => new RoadMetricsService({ ...DEFAULT_ROAD_CONFIG, engine: 'OSRM', baseUrl: 'http://osrm.test', ...extra }, fetchImpl);

  it('declara la procedencia vial y entrega distancias, duraciones estimadas y el contraste con la línea recta', async () => {
    const service = build([order('a', A), order('b', B)], road(createFakeOsrmFetch({ riverLng: -78.62, bridgeLat: -1.215 })));
    const result = await service.propose({ date: '2030-02-14' });

    expect(result.distanceMethod).toBe(ROAD_DISTANCE_METHOD);
    expect(result.roadMetrics).toMatchObject({ provider: 'OSRM', profile: 'car', distanceUnit: 'km', durationUnit: 's', directional: true, trafficAware: false, estimate: true });
    const [proposal] = result.proposals;
    expect(proposal!.totalDistanceKm).toBeGreaterThan(proposal!.straightLineKm!); // por calles es más largo que la línea recta
    expect(proposal!.totalDurationSeconds).toBeGreaterThan(0);
    expect(proposal!.stops.every((stop) => stop.legDistanceKm! > 0 && stop.legDurationSeconds! > 0)).toBe(true);
    expect(proposal!.returnLegDistanceKm).toBeGreaterThan(0);
    // La suma de los tramos es el total de la propuesta (con redondeo a metros).
    const legs = proposal!.stops.reduce((sum, stop) => sum + stop.legDistanceKm!, 0) + proposal!.returnLegDistanceKm!;
    expect(legs).toBeCloseTo(proposal!.totalDistanceKm, 2);
    expect(proposal!.geometry).toBeUndefined(); // el trazado solo se entrega si se pide
  });

  it('con includeGeometry entrega el trazado depósito → paradas → depósito para el mapa', async () => {
    const service = build([order('a', A), order('b', B)], road(createFakeOsrmFetch()));
    const { proposals } = await service.propose({ date: '2030-02-14', includeGeometry: true });
    expect(proposals[0]!.geometry!.type).toBe('LineString');
    expect(proposals[0]!.geometry!.coordinates).toHaveLength(proposals[0]!.stops.length + 2);
    expect(proposals[0]!.geometry!.coordinates[0]).toEqual([depot.lng, depot.lat]);
  });

  it('sin el motor vial la respuesta conserva su forma histórica (sin campos viales)', async () => {
    const service = build([order('a', A), order('b', B)], new RoadMetricsService({ ...DEFAULT_ROAD_CONFIG }));
    const result = await service.propose({ date: '2030-02-14' });
    expect(result.distanceMethod).toBe('HAVERSINE_STRAIGHT_LINE');
    expect(result.roadMetrics).toBeUndefined();
    expect(result.proposals[0]).not.toHaveProperty('totalDurationSeconds');
    expect(result.proposals[0]!.stops[0]).not.toHaveProperty('legDistanceKm');
  });

  it.each([
    ['server-error', 'ROAD_ENGINE_UNAVAILABLE', 503],
    ['incomplete', 'ROAD_ENGINE_BAD_RESPONSE', 502],
  ] as const)('si el motor falla (%s) no se propone nada: error %s', async (mode, code, status) => {
    const service = build([order('a', A), order('b', B)], road(createFakeOsrmFetch({ mode })));
    await expect(service.propose({ date: '2030-02-14' })).rejects.toMatchObject({ code, status });
  });

  it('un par sin recorrido nombra los pedidos afectados para que el ADMIN los revise', async () => {
    // Índices de la matriz: 0 = depósito, 1 = pedido a, 2 = pedido b. El pedido a queda aislado.
    const service = build([order('a', A), order('b', B)], road(createFakeOsrmFetch({ mode: 'no-route-pair', isolatedIndex: 1 })));
    const error = await service.propose({ date: '2030-02-14' }).catch((e) => e as RoadMetricsError);
    expect(error).toBeInstanceOf(RoadMetricsError);
    expect(error).toMatchObject({ code: 'ROAD_ROUTE_NOT_FOUND' });
    expect((error as RoadMetricsError).details.orderIds).toEqual(['a', 'b']);
  });

  it('un punto fuera de la red vial se atribuye a su pedido', async () => {
    const service = build([order('a', A), order('b', B)], road(createFakeOsrmFetch({ mode: 'far-point', isolatedIndex: 2 })));
    const error = (await service.propose({ date: '2030-02-14' }).catch((e) => e)) as RoadMetricsError;
    expect(error.code).toBe('ROAD_POINT_OFF_NETWORK');
    expect(error.details.orderIds).toEqual(['b']);
  });

  it('el estado del motor vial se consulta a través del servicio', async () => {
    expect(await build([], road(createFakeOsrmFetch())).roadEngineStatus()).toMatchObject({ engine: 'OSRM', available: true });
  });

  it('con OSRM activo agrupa primero por ventana horaria y no fusiona 10:00+10:20 con 15:00 aunque sean vecinos', async () => {
    const t1000 = Temporal.Instant.from('2030-02-14T10:00:00Z');
    const t1020 = Temporal.Instant.from('2030-02-14T10:20:00Z');
    const t1500 = Temporal.Instant.from('2030-02-14T15:00:00Z');
    const service = build(
      [
        order('a', B, t1000),
        order('b', { lat: -1.238, lng: -78.610 }, t1020),
        order('c', { lat: B.lat + 0.0001, lng: B.lng + 0.0001 }, t1500),
      ],
      road(createFakeOsrmFetch({ riverLng: -78.62, bridgeLat: -1.215 })),
    );

    const result = await service.propose({ date: '2030-02-14' });

    expect(result.distanceMethod).toBe(ROAD_DISTANCE_METHOD);
    expect(result.timeWindowMarginMinutes).toBe(30);
    expect(result.proposals).toHaveLength(2);
    expect(result.proposals[0]!.orderIds).toEqual(['a', 'b']);
    expect(result.proposals[1]!.orderIds).toEqual(['c']);
  });

  it('con OSRM activo pasa durationsS a RoutePlanner usando duración como costo primario y reporta totalDistanceKm en km', async () => {
    const C = { lat: -1.239, lng: -78.605 };
    const t1000 = Temporal.Instant.from('2030-02-14T10:00:00Z');
    const customMatrix: RoadMatrix = {
      provider: 'OSRM',
      profile: 'car',
      distanceUnit: 'm',
      durationUnit: 's',
      points: [depot, A, B, C],
      // Distancias favorecen unir A+C (distSaving 1.5 km) sobre A+B (distSaving 0 km).
      distancesM: [
        [0, 1000, 1000, 1000],
        [1000, 0, 2000, 500],
        [1000, 2000, 0, 3000],
        [1000, 500, 3000, 0],
      ],
      // Duraciones favorecen unir A+B (durSaving 900s > 0) mientras A+C tiene durSaving -200s < 0.
      durationsS: [
        [0, 500, 500, 500],
        [500, 0, 100, 1200],
        [500, 100, 0, 1200],
        [500, 1200, 1200, 0],
      ],
      snapDistancesM: [0, 1, 2, 4],
      maxSnapDistanceM: 4,
    };
    const roadsMock: any = {
      active: true,
      matrixFor: jest.fn(async () => customMatrix),
    };
    const service = build([order('a', A, t1000), order('b', B, t1000), order('c', C, t1000)], roadsMock);

    const result = await service.propose({ date: '2030-02-14' });

    expect(roadsMock.matrixFor).toHaveBeenCalledTimes(1);
    expect(result.proposals).toHaveLength(2);
    const paired = result.proposals.find((p) => p.orderIds.length === 2)!;
    expect(paired.orderIds).toEqual(['a', 'b']);
    expect(paired.totalDurationSeconds).toBe(1100);
    expect(paired.totalDistanceKm).toBe(4);
  });

  it('con OSRM activo y StoreCoverage configurado usa la ubicación de la tienda como origen en matriz y geometría', async () => {
    const storeLocation = { lat: -1.24908, lng: -78.61675 };
    const storeCoverage: any = {
      getCoverage: jest.fn(async () => ({
        configured: true,
        location: storeLocation,
        coverage: { type: 'Polygon', coordinates: [] },
        updatedAt: '2030-02-14T00:00:00.000Z',
        updatedById: null,
      })),
    };
    const service = build([order('a', B)], road(createFakeOsrmFetch()), storeCoverage);

    const result = await service.propose({ date: '2030-02-14', includeGeometry: true });

    expect(result.proposals[0]!.depot).toEqual(storeLocation);
    expect(result.proposals[0]!.geometry!.coordinates[0]).toEqual([storeLocation.lng, storeLocation.lat]);
  });
});
