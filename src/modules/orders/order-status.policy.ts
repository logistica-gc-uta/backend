import { BadRequestException } from '@nestjs/common';
import { OrderStatus } from './dto/update-order-status.dto.js';

export const ORDER_STATUS_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  [OrderStatus.PENDING]: [OrderStatus.ASSIGNED, OrderStatus.CANCELLED],
  [OrderStatus.ASSIGNED]: [OrderStatus.IN_TRANSIT, OrderStatus.CANCELLED],
  [OrderStatus.IN_TRANSIT]: [OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [],
};

export function isTerminalStatus(status: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[status]?.length === 0;
}

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export function validateOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (isTerminalStatus(from)) {
    throw new BadRequestException(
      `No se puede realizar una transición desde el estado terminal '${from}'`,
    );
  }

  if (!canTransitionOrder(from, to)) {
    throw new BadRequestException(
      `Transición de estado inválida: no se permite cambiar de '${from}' a '${to}'`,
    );
  }
}
