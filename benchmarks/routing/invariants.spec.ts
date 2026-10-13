import { type PlannedRoute, type RoutingOrder, planRoutes } from '../../src/modules/routes/algorithms/clarke-wright.js';
import { haversineKm as DISTANCE } from '../../src/modules/routes/algorithms/geo.util.js';
import { DELIVERY_DATE, DEPOT, ZONE_ID } from './datasets.js';
import { verifyProposal } from './invariants.js';

const depots = { [ZONE_ID]: DEPOT };
const order = (id: string, lat: number, lng: number, zoneId = ZONE_ID, deliveryDate = DELIVERY_DATE): RoutingOrder => ({
  id,
  zoneId,
  deliveryDate,
  location: { lat, lng },
});

describe('verifyProposal', () => {
  const orders = [order('a', DEPOT.lat + 0.01, DEPOT.lng), order('b', DEPOT.lat + 0.02, DEPOT.lng)];
  const good = (): PlannedRoute[] => planRoutes(orders, { depots, distance: DISTANCE });
  const check = (routes: PlannedRoute[], list = orders) => verifyProposal({ orders: list, routes, depots, distance: DISTANCE });

  it('acepta una propuesta válida', () => {
    expect(check(good())).toEqual([]);
  });

  it('detecta pedidos duplicados, inexistentes y sin ruta', () => {
    const dup: PlannedRoute[] = [{ ...good()[0]!, orderIds: ['a', 'a'] }];
    expect(check(dup).join('|')).toContain("pedido duplicado 'a'");
    expect(check(dup).join('|')).toContain("pedido sin ruta 'b'");
    const ghost: PlannedRoute[] = [{ ...good()[0]!, orderIds: ['a', 'b', 'zzz'] }];
    expect(check(ghost).join('|')).toContain("pedido inexistente 'zzz'");
  });

  it('detecta rutas que superan la capacidad y rutas vacías', () => {
    const many = Array.from({ length: 5 }, (_, i) => order(`m${i}`, DEPOT.lat + 0.01, DEPOT.lng));
    const route: PlannedRoute = { zoneId: ZONE_ID, deliveryDate: DELIVERY_DATE, orderIds: many.map((o) => o.id), totalDistance: 0 };
    expect(check([route], many).join('|')).toContain('supera la capacidad');
    expect(check([{ ...route, orderIds: [] }], many).join('|')).toContain('vacía');
  });

  it('detecta rutas que mezclan zona o fecha', () => {
    const mixed = [order('a', DEPOT.lat + 0.01, DEPOT.lng, 'Z1'), order('b', DEPOT.lat + 0.01, DEPOT.lng, 'Z2', '2030-02-15')];
    const route: PlannedRoute = { zoneId: 'Z1', deliveryDate: DELIVERY_DATE, orderIds: ['a', 'b'], totalDistance: 0 };
    const result = verifyProposal({ orders: mixed, routes: [route], depots: { Z1: DEPOT, Z2: DEPOT }, distance: DISTANCE }).join('|');
    expect(result).toContain('mezcla zonas');
    expect(result).toContain('mezcla fechas');
  });

  it('detecta una distancia informada que no coincide con las coordenadas', () => {
    const lying: PlannedRoute[] = [{ ...good()[0]!, totalDistance: good()[0]!.totalDistance + 1 }];
    expect(check(lying).join('|')).toContain('recalculada');
  });
});
