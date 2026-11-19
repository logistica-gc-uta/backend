import { ConflictException } from '@nestjs/common';

export const DEFAULT_VEHICLE_CAPACITY = 4;
export const MAX_ROUTE_STOPS = 4;
export const VEHICLE_CAPACITY_EXCEEDED_CODE = 'VEHICLE_CAPACITY_EXCEEDED' as const;

export function resolveVehicleCapacity(storedCapacity: number | null | undefined): number {
  if (storedCapacity === null || storedCapacity === undefined) {
    return DEFAULT_VEHICLE_CAPACITY;
  }
  if (!Number.isInteger(storedCapacity) || storedCapacity < 1) {
    return DEFAULT_VEHICLE_CAPACITY;
  }
  return storedCapacity;
}

/**
 * Computes indivisible product-unit demand for one order as the sum of its item quantities.
 * Legacy orders without items count as 1 unit (never 0) for backward compatibility.
 */
export function orderDemandUnits(
  items: ReadonlyArray<{ quantity?: number | null }> | null | undefined,
): number {
  if (!items || items.length === 0) return 1;
  let sum = 0;
  for (const item of items) {
    const qty = item.quantity;
    if (typeof qty === 'number' && Number.isFinite(qty) && qty > 0) {
      sum += qty;
    }
  }
  return sum > 0 ? sum : 1;
}

export function routeLoadUnits(orderDemands: readonly number[]): number {
  return orderDemands.reduce((sum, demand) => sum + demand, 0);
}

export function assertVehicleCapacity(requiredUnits: number, capacity: number): void {
  if (requiredUnits > capacity) {
    throw new ConflictException({
      statusCode: 409,
      message: `Route load (${requiredUnits} units) exceeds vehicle capacity (${capacity} units)`,
      error: 'Conflict',
      code: VEHICLE_CAPACITY_EXCEEDED_CODE,
      requiredUnits,
      capacity,
    });
  }
}
