import { HttpException } from '@nestjs/common';
import { assertOrderUnitsWithinLimit, ORDER_UNITS_LIMIT_EXCEEDED, totalOrderUnits } from './order-units-limit.util.js';

describe('Máximo de unidades por pedido (#83)', () => {
  const items = (...quantities: number[]) => quantities.map((quantity, i) => ({ productId: `p${i}`, quantity }));

  it('suma las cantidades de todas las líneas, no cuenta líneas ni productos', () => {
    expect(totalOrderUnits(items(3, 4, 5))).toBe(12);
    expect(totalOrderUnits(items(12))).toBe(12);
  });

  it('sin límite configurado (null o ausente) acepta cualquier total', () => {
    expect(() => assertOrderUnitsWithinLimit(items(1000, 1000), null)).not.toThrow();
    expect(() => assertOrderUnitsWithinLimit(items(1000, 1000), undefined)).not.toThrow();
  });

  it('acepta por debajo y exactamente en el máximo', () => {
    expect(() => assertOrderUnitsWithinLimit(items(4, 5), 10)).not.toThrow();
    expect(() => assertOrderUnitsWithinLimit(items(4, 6), 10)).not.toThrow();
  });

  it('rechaza N+1 con 422, código estable y el máximo vigente', () => {
    let error: HttpException | undefined;
    try {
      assertOrderUnitsWithinLimit(items(4, 7), 10);
    } catch (e) {
      error = e as HttpException;
    }
    expect(error).toBeInstanceOf(HttpException);
    expect(error!.getStatus()).toBe(422);
    expect(error!.getResponse()).toEqual({
      error: { code: ORDER_UNITS_LIMIT_EXCEEDED, message: expect.any(String), details: { requestedUnits: 11, maximumAllowed: 10 } },
    });
  });

  it('dos productos que cumplen individualmente el máximo por SKU se rechazan si la suma excede el total', () => {
    expect(() => assertOrderUnitsWithinLimit(items(10, 10), 15)).toThrow(HttpException);
  });
});
