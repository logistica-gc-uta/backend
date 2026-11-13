import { type RoutingOrder, planRoutes } from './clarke-wright.js';
import { type GeoPoint } from './geo.util.js';

// Distancia euclídea sobre un plano: hace los escenarios fáciles de razonar.
const euclid = (a: GeoPoint, b: GeoPoint) => Math.hypot(a.lat - b.lat, a.lng - b.lng);

const DEPOT: GeoPoint = { lat: 0, lng: 0 };
const depots = { Z1: DEPOT, Z2: DEPOT };

const atUtc = (hhmm: string) => Date.parse(`2030-02-14T${hhmm}:00Z`);

const order = (
  id: string,
  lat: number,
  lng: number,
  zoneId = 'Z1',
  deliveryDate = '2030-02-14',
  scheduledAtMs?: number,
): RoutingOrder => ({
  id,
  zoneId,
  deliveryDate,
  location: { lat, lng },
  ...(scheduledAtMs !== undefined ? { scheduledAtMs } : {}),
});

const plan = (orders: RoutingOrder[], capacity?: number) =>
  planRoutes(orders, { depots, distance: euclid, capacity });

describe('planRoutes (Clarke & Wright)', () => {
  it('sin pedidos devuelve sin rutas', () => {
    expect(plan([])).toEqual([]);
  });

  it('un pedido genera una ruta de una parada', () => {
    const [route] = plan([order('a', 3, 4)]);

    expect(route!.orderIds).toEqual(['a']);
    expect(route!.totalDistance).toBeCloseTo(10); // 5 de ida + 5 de vuelta
  });

  it('agrupa 4 pedidos cercanos en una sola ruta', () => {
    const routes = plan([order('a', 10, 0), order('b', 10, 1), order('c', 10, 2), order('d', 10, 3)]);

    expect(routes).toHaveLength(1);
    expect(routes[0]!.orderIds).toHaveLength(4);
  });

  it('con puntos alineados logra el recorrido óptimo y parte por la parada más cercana', () => {
    const [route] = plan([order('lejos', 30, 0), order('medio', 20, 0), order('cerca', 10, 0)]);

    // Sobre un mismo rayo, cualquier tour mide 2 x la distancia al punto más lejano.
    expect(route!.totalDistance).toBeCloseTo(60);
    expect(route!.orderIds[0]).toBe('cerca');
    expect([...route!.orderIds].sort((a, b) => a.localeCompare(b))).toEqual(['cerca', 'lejos', 'medio']);
  });

  it('nunca supera la capacidad: 5 pedidos en el mismo punto dan 2 rutas (4 + 1)', () => {
    const routes = plan(['a', 'b', 'c', 'd', 'e'].map((id) => order(id, 10, 10)));

    expect(routes.map((r) => r.orderIds.length).sort((a, b) => a - b)).toEqual([1, 4]);
  });

  it('respeta una capacidad personalizada', () => {
    const orders = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, k) => order(id, 10, k * 0.1));
    const routes = plan(orders, 2);

    expect(routes).toHaveLength(3);
    routes.forEach((r) => expect(r.orderIds.length).toBeLessThanOrEqual(2));
  });

  it('no une pedidos que están en lados opuestos del depósito (ahorro nulo)', () => {
    const routes = plan([order('norte', 10, 0), order('sur', -10, 0)]);

    expect(routes).toHaveLength(2);
  });

  it('fusiona primero los pedidos más cercanos entre sí (mayor ahorro) antes que los lejanos', () => {
    // Con capacidad 2, cada cluster llena su ruta con su vecino antes de poder cruzar al otro lado.
    const routes = plan([order('n1', 50, 0), order('n2', 50, 1), order('s1', -50, 0), order('s2', -50, 1)], 2);

    expect(routes).toHaveLength(2);
    const sets = routes.map((r) => [...r.orderIds].sort());
    expect(sets).toContainEqual(['n1', 'n2']);
    expect(sets).toContainEqual(['s1', 's2']);
  });

  it('no mezcla zonas ni fechas distintas', () => {
    const routes = plan([
      order('a', 10, 0, 'Z1', '2030-02-14'),
      order('b', 10, 0.1, 'Z2', '2030-02-14'),
      order('c', 10, 0.2, 'Z1', '2030-02-15'),
    ]);

    expect(routes).toHaveLength(3);
    expect(new Set(routes.map((r) => `${r.zoneId}|${r.deliveryDate}`)).size).toBe(3);
  });

  it('mejora la distancia frente a una ruta por pedido', () => {
    const orders = [order('a', 10, 0), order('b', 10, 1), order('c', 11, 0), order('d', 11, 1)];
    const routes = plan(orders);

    const naive = orders.reduce((sum, o) => sum + 2 * euclid(DEPOT, o.location), 0);
    const planned = routes.reduce((sum, r) => sum + r.totalDistance, 0);
    expect(planned).toBeLessThan(naive);
  });

  it('es determinista: no depende del orden de entrada', () => {
    const orders = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, k) => order(id, 5 + (k % 3) * 7, k * 0.8));

    const forward = plan(orders);
    const backward = plan([...orders].reverse());

    expect(backward).toEqual(forward);
  });

  it('usa la función de distancia inyectada', () => {
    const distance = jest.fn(euclid);
    planRoutes([order('a', 1, 1), order('b', 1, 2)], { depots, distance });

    expect(distance).toHaveBeenCalled();
  });

  it('usa Haversine por defecto con coordenadas reales (Ambato)', () => {
    const ambato = { lat: -1.2491, lng: -78.6167 };
    const routes = planRoutes(
      [
        { id: 'a', zoneId: 'Z1', deliveryDate: '2030-02-14', location: { lat: -1.24, lng: -78.62 } },
        { id: 'b', zoneId: 'Z1', deliveryDate: '2030-02-14', location: { lat: -1.241, lng: -78.621 } },
      ],
      { depots: { Z1: ambato } },
    );

    expect(routes).toHaveLength(1);
    expect(routes[0]!.totalDistance).toBeGreaterThan(0);
    expect(routes[0]!.totalDistance).toBeLessThan(10);
  });

  it('rechaza pedidos duplicados', () => {
    expect(() => plan([order('a', 1, 1), order('a', 2, 2)])).toThrow('duplicado');
  });

  it('rechaza una zona sin depósito', () => {
    expect(() => plan([order('a', 1, 1, 'ZX')])).toThrow("zona 'ZX'");
  });

  it.each([0, -1, 2.5, Number.NaN])('rechaza una capacidad inválida (%p)', (capacity) => {
    expect(() => plan([order('a', 1, 1)], capacity)).toThrow('capacidad');
  });

  it('propiedad: con 300 pedidos aleatorios cada pedido aparece una sola vez y ninguna ruta pasa de 4', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const orders = Array.from({ length: 300 }, (_, k) =>
      order(`o${String(k).padStart(3, '0')}`, rand() * 100 - 50, rand() * 100 - 50, rand() < 0.5 ? 'Z1' : 'Z2'),
    );

    const routes = plan(orders);

    const ids = routes.flatMap((r) => r.orderIds);
    expect(ids).toHaveLength(300);
    expect(new Set(ids).size).toBe(300);
    routes.forEach((r) => {
      expect(r.orderIds.length).toBeGreaterThanOrEqual(1);
      expect(r.orderIds.length).toBeLessThanOrEqual(4);
    });
    const naive = orders.reduce((sum, o) => sum + 2 * euclid(DEPOT, o.location), 0);
    expect(routes.reduce((sum, r) => sum + r.totalDistance, 0)).toBeLessThan(naive);
  });

  describe('S1 — agrupación por ventana horaria con extremos (max - min <= marginMs)', () => {
    it('no encadena vecinos: 10:00, 10:25 y 10:50 con margen 30 min -> [10:00, 10:25] y [10:50]', () => {
      const orders = [
        order('c', 10, 0, 'Z1', '2030-02-14', atUtc('10:50')),
        order('b', 10, 0, 'Z1', '2030-02-14', atUtc('10:25')),
        order('a', 10, 0, 'Z1', '2030-02-14', atUtc('10:00')),
      ];

      const routes = planRoutes(orders, { depots, distance: euclid, timeWindowMarginMinutes: 30 });

      expect(routes.map((r) => r.orderIds)).toEqual([['a', 'b'], ['c']]);
    });

    it('el borde del margen es inclusivo: 10:00 + 10:30 se agrupan, 10:00 + 10:31 se separan', () => {
      const inclusive = planRoutes(
        [
          order('a', 10, 0, 'Z1', '2030-02-14', atUtc('10:00')),
          order('b', 10, 0, 'Z1', '2030-02-14', atUtc('10:30')),
        ],
        { depots, distance: euclid, timeWindowMarginMinutes: 30 },
      );
      expect(inclusive.map((r) => r.orderIds)).toEqual([['a', 'b']]);

      const exclusive = planRoutes(
        [
          order('a', 10, 0, 'Z1', '2030-02-14', atUtc('10:00')),
          order('b', 10, 0, 'Z1', '2030-02-14', atUtc('10:31')),
        ],
        { depots, distance: euclid, timeWindowMarginMinutes: 30 },
      );
      expect(exclusive.map((r) => r.orderIds)).toEqual([['a'], ['b']]);
    });

    it('margen 0 agrupa solo instantes idénticos y separa cualquier diferencia', () => {
      const routes = planRoutes(
        [
          order('a', 10, 0, 'Z1', '2030-02-14', atUtc('10:00')),
          order('b', 10, 0, 'Z1', '2030-02-14', atUtc('10:00')),
          order('c', 10, 0, 'Z1', '2030-02-14', atUtc('10:01')),
        ],
        { depots, distance: euclid, timeWindowMarginMinutes: 0 },
      );

      expect(routes.map((r) => r.orderIds)).toEqual([['a', 'b'], ['c']]);
    });

    it('pedidos sin horario quedan en un subgrupo separado al final sin mezclarse con los programados', () => {
      const routes = planRoutes(
        [
          order('u', 10, 0),
          order('a', 10, 0, 'Z1', '2030-02-14', atUtc('10:00')),
          order('b', 10, 0, 'Z1', '2030-02-14', atUtc('10:15')),
        ],
        { depots, distance: euclid, timeWindowMarginMinutes: 30 },
      );

      expect(routes.map((r) => r.orderIds)).toEqual([['a', 'b'], ['u']]);
    });

    it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rechaza timeWindowMarginMinutes inválido (%p)',
      (timeWindowMarginMinutes) => {
        expect(() =>
          planRoutes([order('a', 1, 1)], { depots, distance: euclid, timeWindowMarginMinutes }),
        ).toThrow('margen');
      },
    );

    it('rechaza scheduledAtMs no finito', () => {
      expect(() =>
        planRoutes([order('a', 1, 1, 'Z1', '2030-02-14', Number.NaN)], {
          depots,
          distance: euclid,
          timeWindowMarginMinutes: 30,
        }),
      ).toThrow('Instante');
    });
  });

  describe('S2 — duración vial como costo primario y distancia como desempate (totalDistance en km)', () => {
    const key = (p: GeoPoint) => `${p.lat},${p.lng}`;
    const tableFn = (costs: Record<string, number>) => (a: GeoPoint, b: GeoPoint) => {
      if (key(a) === key(b)) return 0;
      return costs[`${key(a)}->${key(b)}`] ?? 9999;
    };

    it('prioriza ahorro de duración sobre ahorro de distancia y reporta totalDistance en km', () => {
      const distance = tableFn({
        '0,0->1,0': 5, '1,0->0,0': 5,
        '0,0->2,0': 5, '2,0->0,0': 5,
        '0,0->3,0': 5, '3,0->0,0': 5,
        '1,0->2,0': 1, '2,0->1,0': 1, // menor distancia: ahorro dist = 9
        '2,0->3,0': 3, '3,0->2,0': 3, // mayor distancia: ahorro dist = 7
        '1,0->3,0': 10, '3,0->1,0': 10,
      });
      const duration = tableFn({
        '0,0->1,0': 600, '1,0->0,0': 600,
        '0,0->2,0': 600, '2,0->0,0': 600,
        '0,0->3,0': 600, '3,0->0,0': 600,
        '1,0->2,0': 1100, '2,0->1,0': 1100, // calle lenta: ahorro dur = 100
        '2,0->3,0': 100, '3,0->2,0': 300,   // vía rápida direccional: ahorro dur = 1000
        '1,0->3,0': 1200, '3,0->1,0': 1200,
      });

      const orders = [order('a', 1, 0), order('b', 2, 0), order('c', 3, 0)];
      const routes = planRoutes(orders, { depots, capacity: 2, distance, duration, directional: true });

      expect(routes).toEqual([
        { zoneId: 'Z1', deliveryDate: '2030-02-14', orderIds: ['a'], totalDistance: 10 },
        { zoneId: 'Z1', deliveryDate: '2030-02-14', orderIds: ['b', 'c'], totalDistance: 13 },
      ]);
    });

    it('cuando el ahorro de duración empata (incluso en 0), desempata con el ahorro de distancia', () => {
      const distance = tableFn({
        '0,0->1,0': 10, '1,0->0,0': 10,
        '0,0->2,0': 10, '2,0->0,0': 10,
        '0,0->3,0': 10, '3,0->0,0': 10,
        '1,0->2,0': 2, '2,0->1,0': 2,   // ahorro dist = 18
        '2,0->3,0': 10, '3,0->2,0': 10, // ahorro dist = 10
        '1,0->3,0': 20, '3,0->1,0': 20, // ahorro dist = 0
      });
      const duration = tableFn({
        '0,0->1,0': 300, '1,0->0,0': 300,
        '0,0->2,0': 300, '2,0->0,0': 300,
        '0,0->3,0': 300, '3,0->0,0': 300,
        '1,0->2,0': 600, '2,0->1,0': 600, // ahorro dur = 0
        '2,0->3,0': 600, '3,0->2,0': 600, // ahorro dur = 0
        '1,0->3,0': 600, '3,0->1,0': 600, // ahorro dur = 0
      });

      const routes = planRoutes([order('a', 1, 0), order('b', 2, 0), order('c', 3, 0)], {
        depots,
        capacity: 2,
        distance,
        duration,
        directional: true,
      });

      expect(routes.map((r) => r.orderIds)).toEqual([['a', 'b'], ['c']]);
    });
  });

  describe('S3 — orden cronológico de paradas, capacidad y optimización intra-instante', () => {
    it('visita primero el pedido programado más temprano aunque otro esté más cerca del depósito', () => {
      const routes = planRoutes(
        [
          order('cercaTarde', 10, 0, 'Z1', '2030-02-14', atUtc('10:20')),
          order('lejosTemprano', 30, 0, 'Z1', '2030-02-14', atUtc('10:00')),
        ],
        { depots, distance: euclid, timeWindowMarginMinutes: 30 },
      );

      expect(routes).toHaveLength(1);
      expect(routes[0]!.orderIds).toEqual(['lejosTemprano', 'cercaTarde']);
      expect(routes[0]!.totalDistance).toBeCloseTo(60); // 0->30 + 30->10 + 10->0
    });

    it('dentro de un mismo instante optimiza la permutación exacta del recorrido completo y desempata lexicográficamente', () => {
      const key = (p: GeoPoint) => `${p.lat},${p.lng}`;
      const duration = (x: GeoPoint, y: GeoPoint) => {
        const table: Record<string, number> = {
          '0,0->1,0': 1,
          '1,0->2,0': 1,
          '2,0->3,0': 100, // a -> b -> c cuesta 103
          '0,0->2,0': 2,
          '2,0->1,0': 1,
          '1,0->3,0': 2,   // b -> a -> c cuesta 6
          '3,0->0,0': 1,
        };
        return key(x) === key(y) ? 0 : (table[`${key(x)}->${key(y)}`] ?? 500);
      };

      const routes = planRoutes(
        [
          order('c', 3, 0, 'Z1', '2030-02-14', atUtc('10:15')),
          order('b', 2, 0, 'Z1', '2030-02-14', atUtc('10:00')),
          order('a', 1, 0, 'Z1', '2030-02-14', atUtc('10:00')),
        ],
        { depots, distance: euclid, duration, directional: true, timeWindowMarginMinutes: 30 },
      );

      expect(routes).toHaveLength(1);
      expect(routes[0]!.orderIds).toEqual(['b', 'a', 'c']);

      // Con costos empatados dentro del mismo instante, desempata por orderIds lexicográfico.
      const tied = planRoutes(
        [
          order('z', 10, 0, 'Z1', '2030-02-14', atUtc('10:00')),
          order('a', 10, 0, 'Z1', '2030-02-14', atUtc('10:00')),
        ],
        { depots, distance: euclid, timeWindowMarginMinutes: 30 },
      );
      expect(tied[0]!.orderIds).toEqual(['a', 'z']);
    });

    it('con buckets grandes (>120 permutaciones, p. ej. capacidad 6) usa respaldo greedy determinista', () => {
      const orders = [60, 40, 20, 50, 30, 10].map((lat, idx) =>
        order(`o${idx}`, lat, 0, 'Z1', '2030-02-14', atUtc('10:00')),
      );

      const routes = planRoutes(orders, { depots, capacity: 6, distance: euclid, timeWindowMarginMinutes: 30 });

      expect(routes).toHaveLength(1);
      expect(routes[0]!.orderIds).toEqual(['o5', 'o2', 'o4', 'o1', 'o3', 'o0']);
      expect(routes[0]!.totalDistance).toBeCloseTo(120);
    });

    it('respeta la capacidad máxima por defecto (4) dentro de una misma ventana horaria y ordena rutas por hora más temprana', () => {
      const orders = [
        order('a-tarde', 10, 0, 'Z1', '2030-02-14', atUtc('12:00')),
        order('z1', 10, 0, 'Z1', '2030-02-14', atUtc('10:00')),
        order('z2', 10, 0, 'Z1', '2030-02-14', atUtc('10:00')),
        order('z3', 10, 0, 'Z1', '2030-02-14', atUtc('10:00')),
        order('z4', 10, 0, 'Z1', '2030-02-14', atUtc('10:00')),
        order('z5', 10, 0, 'Z1', '2030-02-14', atUtc('10:00')),
      ];

      const routes = planRoutes(orders, { depots, distance: euclid, timeWindowMarginMinutes: 30 });

      expect(routes).toHaveLength(3);
      expect(routes.every((r) => r.orderIds.length <= 4)).toBe(true);
      expect(routes[2]!.orderIds).toEqual(['a-tarde']);
      expect(routes).toEqual(
        planRoutes([...orders].reverse(), { depots, distance: euclid, timeWindowMarginMinutes: 30 }),
      );
    });
  });
});
