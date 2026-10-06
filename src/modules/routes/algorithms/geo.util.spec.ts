import { haversineKm } from './geo.util.js';

describe('haversineKm', () => {
  it('devuelve 0 para el mismo punto', () => {
    const p = { lat: -1.2491, lng: -78.6167 };
    expect(haversineKm(p, p)).toBe(0);
  });

  it('un grado de latitud equivale a ~111.19 km', () => {
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111.19, 1);
  });

  it('es simétrica', () => {
    const a = { lat: -1.2491, lng: -78.6167 };
    const b = { lat: -1.2, lng: -78.5 };
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 10);
  });
});
