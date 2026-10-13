import { type RoutingOrder, planRoutes } from '../../src/modules/routes/algorithms/clarke-wright.js';
import { haversineKm as DISTANCE } from '../../src/modules/routes/algorithms/geo.util.js';
import { DELIVERY_DATE, DEPOT, ZONE_ID } from './datasets.js';
import { deterministicMetrics, independentTripsKm, savingsPercent, utilization } from './metrics.js';

const depots = { [ZONE_ID]: DEPOT };
const order = (id: string, lat: number, lng: number, zoneId = ZONE_ID, deliveryDate = DELIVERY_DATE): RoutingOrder => ({
  id,
  zoneId,
  deliveryDate,
  location: { lat, lng },
});

describe('métricas', () => {
  it('la línea base es la suma de viajes independientes de ida y vuelta', () => {
    const orders = [order('a', DEPOT.lat + 1, DEPOT.lng)];
    expect(independentTripsKm(orders, depots, DISTANCE)).toBeCloseTo(2 * 111.19, 1);
  });

  it('la línea base exige depósito para cada zona', () => {
    expect(() => independentTripsKm([order('a', 0, 0, 'ZX')], depots, DISTANCE)).toThrow('depósito');
  });

  it('el ahorro nunca divide entre 0 ni devuelve NaN', () => {
    expect(savingsPercent(0, 0)).toBe(0);
    expect(savingsPercent(0, 5)).toBe(0);
    expect(savingsPercent(-1, 1)).toBe(0);
    expect(savingsPercent(Number.NaN, 1)).toBe(0);
    expect(Number.isFinite(savingsPercent(0, 0))).toBe(true);
  });

  it('calcula el ahorro porcentual', () => {
    expect(savingsPercent(100, 25)).toBe(75);
    expect(savingsPercent(100, 100)).toBe(0);
  });

  it('la utilización es pedidos / (rutas × capacidad) y 0 sin rutas', () => {
    expect(utilization(5, 2, 4)).toBe(0.625);
    expect(utilization(0, 0, 4)).toBe(0);
  });

  it('las métricas deterministas de un caso conocido coinciden con el cálculo a mano', () => {
    const orders = [0, 1, 2, 3].map((i) => order(`p${i}`, DEPOT.lat + 0.02, DEPOT.lng));
    const routes = planRoutes(orders, { depots, distance: DISTANCE });
    const m = deterministicMetrics(orders, routes, depots, DISTANCE);
    expect(m.routes).toBe(1);
    expect(m.minimumRoutes).toBe(1);
    expect(m.utilization).toBe(1);
    expect(m.averageStopsPerRoute).toBe(4);
    expect(m.savingsPercent).toBeCloseTo(75, 6);
  });
});
