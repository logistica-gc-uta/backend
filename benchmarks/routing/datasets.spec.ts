import { type GeoPoint, haversineKm } from '../../src/modules/routes/algorithms/geo.util.js';
import { BOX_DEGREES, DELIVERY_DATE, DEPOT, ZONE_ID, generateDataset } from './datasets.js';

describe('datasets', () => {
  it('son reproducibles: misma semilla, mismos pedidos', () => {
    expect(generateDataset('uniform', 50, 9)).toEqual(generateDataset('uniform', 50, 9));
    expect(generateDataset('clustered', 50, 9)).toEqual(generateDataset('clustered', 50, 9));
  });

  it('cambian con la semilla y con el tipo', () => {
    expect(generateDataset('uniform', 20, 1).orders).not.toEqual(generateDataset('uniform', 20, 2).orders);
    expect(generateDataset('uniform', 20, 1).orders).not.toEqual(generateDataset('clustered', 20, 1).orders);
  });

  it('respetan el tamaño pedido, con ids únicos, una zona, una fecha y coordenadas con 6 decimales', () => {
    const { orders } = generateDataset('clustered', 120, 3);
    expect(orders).toHaveLength(120);
    expect(new Set(orders.map((o) => o.id)).size).toBe(120);
    expect(new Set(orders.map((o) => o.zoneId))).toEqual(new Set([ZONE_ID]));
    expect(new Set(orders.map((o) => o.deliveryDate))).toEqual(new Set([DELIVERY_DATE]));
    for (const { location } of orders) {
      expect(Math.round(location.lat * 1e6) / 1e6).toBe(location.lat);
      expect(Math.round(location.lng * 1e6) / 1e6).toBe(location.lng);
    }
  });

  it('los uniformes caen dentro de la caja alrededor del depósito', () => {
    for (const { location } of generateDataset('uniform', 300, 5).orders) {
      expect(Math.abs(location.lat - DEPOT.lat)).toBeLessThanOrEqual(BOX_DEGREES + 1e-6);
      expect(Math.abs(location.lng - DEPOT.lng)).toBeLessThanOrEqual(BOX_DEGREES + 1e-6);
    }
  });

  it('los agrupados están más concentrados que los uniformes (menor distancia al vecino más cercano)', () => {
    const meanNearest = (points: GeoPoint[]) =>
      points.reduce((sum, p, i) => sum + Math.min(...points.filter((_, j) => j !== i).map((q) => haversineKm(p, q))), 0) / points.length;
    const uniform = generateDataset('uniform', 200, 4).orders.map((o) => o.location);
    const clustered = generateDataset('clustered', 200, 4).orders.map((o) => o.location);
    expect(meanNearest(clustered)).toBeLessThan(meanNearest(uniform));
  });

  it('cero pedidos es válido y un tamaño inválido se rechaza', () => {
    expect(generateDataset('uniform', 0, 1).orders).toEqual([]);
    expect(() => generateDataset('uniform', -1, 1)).toThrow('entero no negativo');
    expect(() => generateDataset('uniform', 2.5, 1)).toThrow('entero no negativo');
  });
});
