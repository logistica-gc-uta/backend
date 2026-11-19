import { ConflictException } from '@nestjs/common';
import {
  assertVehicleCapacity,
  DEFAULT_VEHICLE_CAPACITY,
  orderDemandUnits,
  resolveVehicleCapacity,
  routeLoadUnits,
  VEHICLE_CAPACITY_EXCEEDED_CODE,
} from './vehicle-capacity.js';

describe('vehicle-capacity', () => {
  it('resolves stored capacity or defaults to 4 when null/undefined', () => {
    expect(resolveVehicleCapacity(null)).toBe(DEFAULT_VEHICLE_CAPACITY);
    expect(resolveVehicleCapacity(undefined)).toBe(4);
    expect(resolveVehicleCapacity(6)).toBe(6);
    expect(resolveVehicleCapacity(1)).toBe(1);
  });

  it('sums OrderItem quantities and treats legacy itemless orders as 1 unit, never 0', () => {
    expect(orderDemandUnits([{ quantity: 2 }, { quantity: 1 }])).toBe(3);
    expect(orderDemandUnits([{ quantity: 5 }])).toBe(5);
    expect(orderDemandUnits([])).toBe(1);
    expect(orderDemandUnits(undefined)).toBe(1);
    expect(orderDemandUnits(null)).toBe(1);
  });

  it('sums route load and enforces vehicle capacity allowing exact fit', () => {
    expect(routeLoadUnits([3, 3])).toBe(6);
    expect(() => assertVehicleCapacity(4, 4)).not.toThrow();
    expect(() => assertVehicleCapacity(6, 6)).not.toThrow();

    let caught: unknown;
    try {
      assertVehicleCapacity(5, 4);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    expect(caught).toMatchObject({
      response: {
        statusCode: 409,
        error: 'Conflict',
        code: VEHICLE_CAPACITY_EXCEEDED_CODE,
        requiredUnits: 5,
        capacity: 4,
      },
    });
  });
});
