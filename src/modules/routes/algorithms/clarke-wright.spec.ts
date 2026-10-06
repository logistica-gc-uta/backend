import { type RoutingOrder, planRoutes } from './clarke-wright.js';
import { type GeoPoint } from './geo.util.js';

// Distancia euclídea sobre un plano: hace los escenarios fáciles de razonar.
const euclid = (a: GeoPoint, b: GeoPoint) => Math.hypot(a.lat - b.lat, a.lng - b.lng);

const DEPOT: GeoPoint = { lat: 0, lng: 0 };
const depots = { Z1: DEPOT, Z2: DEPOT };

const order = (id: string, lat: number, lng: number, zoneId = 'Z1', deliveryDate = '2030-02-14'): RoutingOrder => ({
  id,
  zoneId,
  deliveryDate,
  location: { lat, lng },
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
});
