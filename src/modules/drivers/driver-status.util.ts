import { ConflictException } from '@nestjs/common';

/** Motivo estable con el que la API rechaza asignar a un repartidor dado de baja (#82). */
export const DRIVER_INACTIVE = 'DRIVER_INACTIVE';

export function driverInactiveConflict(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    message: 'El repartidor está dado de baja y no puede recibir asignaciones',
    error: 'Conflict',
    code: DRIVER_INACTIVE,
  });
}

/**
 * Un repartidor sin la marca `isActive` (filas de pruebas o históricas) cuenta como activo: solo `false` explícito es una baja.
 * Se llama con la fila del repartidor YA bloqueada, dentro de la transacción que protege la asignación.
 */
export function isDriverInactive(driver: { isActive?: boolean | null } | null | undefined): boolean {
  return driver?.isActive === false;
}

export function assertDriverActive(driver: { isActive?: boolean | null } | null | undefined): void {
  if (isDriverInactive(driver)) throw driverInactiveConflict();
}
