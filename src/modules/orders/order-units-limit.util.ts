import { HttpException, HttpStatus } from '@nestjs/common';

/** Código estable del rechazo por superar el máximo de unidades por pedido (#83). */
export const ORDER_UNITS_LIMIT_EXCEEDED = 'ORDER_UNITS_LIMIT_EXCEEDED';

/** Suma las cantidades de todas las líneas: no cuenta líneas, productos distintos ni paradas. */
export function totalOrderUnits(items: ReadonlyArray<{ quantity: number }>): number {
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

/**
 * Rechaza el pedido si la suma de unidades excede el máximo vigente. `null` significa sin límite (valor inicial de la
 * configuración). Un pedido de exactamente N unidades con máximo N se acepta; N+1 se rechaza con 422 y el máximo vigente.
 * Es una función pura: no toca stock, cobros ni comprobantes, así que el rechazo no deja efectos parciales.
 */
export function assertOrderUnitsWithinLimit(items: ReadonlyArray<{ quantity: number }>, maximumAllowed: number | null | undefined): void {
  if (maximumAllowed === null || maximumAllowed === undefined) return;
  const requestedUnits = totalOrderUnits(items);
  if (requestedUnits > maximumAllowed) {
    throw new HttpException(
      {
        error: {
          code: ORDER_UNITS_LIMIT_EXCEEDED,
          message: 'El total de unidades del pedido supera el máximo permitido',
          details: { requestedUnits, maximumAllowed },
        },
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
