import { type GeoPoint, haversineKm } from './geo.util.js';
import { independentTripsKm, roundKm, roundPercent, savingsFigures } from './route-metrics.js';

const DEPOT: GeoPoint = { lat: 0, lng: 0 };
// 0,1 grado de latitud ≈ 11,1195 km
const AT_11_KM: GeoPoint = { lat: 0.1, lng: 0 };

describe('redondeo', () => {
  it('roundKm redondea a 3 decimales y roundPercent a 2', () => {
    expect(roundKm(1.23456)).toBe(1.235);
    expect(roundKm(0.0004)).toBe(0);
    expect(roundPercent(33.33333)).toBe(33.33);
    expect(roundPercent(66.666)).toBe(66.67);
  });
});

describe('independentTripsKm', () => {
  it('suma ida y vuelta al depósito por cada parada', () => {
    const d = haversineKm(DEPOT, AT_11_KM);
    expect(independentTripsKm([AT_11_KM, AT_11_KM, AT_11_KM], DEPOT)).toBeCloseTo(6 * d, 9);
  });

  it('sin paradas es 0', () => {
    expect(independentTripsKm([], DEPOT)).toBe(0);
  });

  it('usa la función de distancia indicada', () => {
    const constant = jest.fn(() => 5);
    expect(independentTripsKm([AT_11_KM, AT_11_KM], DEPOT, constant)).toBe(20);
    expect(constant).toHaveBeenCalledTimes(2);
  });

  it('un pedido en el depósito no aporta distancia', () => {
    expect(independentTripsKm([DEPOT], DEPOT)).toBe(0);
  });
});

describe('savingsFigures', () => {
  it('calcula el ahorro en km y en porcentaje a partir de los valores redondeados', () => {
    expect(savingsFigures(100, 25)).toEqual({ baselineKm: 100, plannedKm: 25, savingsKm: 75, savingsPercent: 75 });
  });

  it('cumple exactamente baseline − propuesto = ahorro con los valores mostrados', () => {
    // 10,0004 y 4,2126 se muestran como 10 y 4,213: el ahorro debe ser 5,787 y no 5,7878.
    const figures = savingsFigures(10.0004, 4.2126);
    expect(figures.baselineKm).toBe(10);
    expect(figures.plannedKm).toBe(4.213);
    expect(figures.savingsKm).toBe(5.787);
    expect(roundKm(figures.baselineKm - figures.plannedKm)).toBe(figures.savingsKm);
  });

  it('con línea base 0 el ahorro es 0 y nunca NaN ni infinito', () => {
    const figures = savingsFigures(0, 0);
    expect(figures).toEqual({ baselineKm: 0, plannedKm: 0, savingsKm: 0, savingsPercent: 0 });
    expect(Number.isFinite(figures.savingsPercent)).toBe(true);
    expect(savingsFigures(0.0004, 0).savingsPercent).toBe(0);
  });

  it('una ruta de un solo pedido no ahorra nada', () => {
    const d = haversineKm(DEPOT, AT_11_KM);
    expect(savingsFigures(independentTripsKm([AT_11_KM], DEPOT), 2 * d)).toMatchObject({ savingsKm: 0, savingsPercent: 0 });
  });

  it('cuatro pedidos en el mismo punto ahorran 75 %', () => {
    const d = haversineKm(DEPOT, AT_11_KM);
    const base = independentTripsKm([AT_11_KM, AT_11_KM, AT_11_KM, AT_11_KM], DEPOT);
    expect(savingsFigures(base, 2 * d).savingsPercent).toBe(75);
  });

  it('el ahorro puede ser negativo si la ruta propuesta es peor que la línea base (no se oculta)', () => {
    expect(savingsFigures(10, 12)).toMatchObject({ savingsKm: -2, savingsPercent: -20 });
  });
});
