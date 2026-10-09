import { BadRequestException } from '@nestjs/common';
import { OrderStatus } from './dto/update-order-status.dto.js';
import {
  canTransitionOrder,
  isTerminalStatus,
  ORDER_STATUS_TRANSITIONS,
  validateOrderTransition,
} from './order-status.policy.js';

describe('OrderStatusPolicy', () => {
  describe('Graph transition rules', () => {
    it('debe permitir PENDING -> ASSIGNED y PENDING -> CANCELLED', () => {
      expect(canTransitionOrder(OrderStatus.PENDING, OrderStatus.ASSIGNED)).toBe(true);
      expect(canTransitionOrder(OrderStatus.PENDING, OrderStatus.CANCELLED)).toBe(true);
    });

    it('debe permitir ASSIGNED -> IN_TRANSIT y ASSIGNED -> CANCELLED', () => {
      expect(canTransitionOrder(OrderStatus.ASSIGNED, OrderStatus.IN_TRANSIT)).toBe(true);
      expect(canTransitionOrder(OrderStatus.ASSIGNED, OrderStatus.CANCELLED)).toBe(true);
    });

    it('debe permitir IN_TRANSIT -> DELIVERED e IN_TRANSIT -> CANCELLED', () => {
      expect(canTransitionOrder(OrderStatus.IN_TRANSIT, OrderStatus.DELIVERED)).toBe(true);
      expect(canTransitionOrder(OrderStatus.IN_TRANSIT, OrderStatus.CANCELLED)).toBe(true);
    });

    it('debe marcar correctamente estados terminales (DELIVERED, CANCELLED) sin transiciones salientes', () => {
      expect(isTerminalStatus(OrderStatus.DELIVERED)).toBe(true);
      expect(isTerminalStatus(OrderStatus.CANCELLED)).toBe(true);
      expect(isTerminalStatus(OrderStatus.PENDING)).toBe(false);
      expect(isTerminalStatus(OrderStatus.ASSIGNED)).toBe(false);
      expect(isTerminalStatus(OrderStatus.IN_TRANSIT)).toBe(false);

      expect(ORDER_STATUS_TRANSITIONS[OrderStatus.DELIVERED]).toHaveLength(0);
      expect(ORDER_STATUS_TRANSITIONS[OrderStatus.CANCELLED]).toHaveLength(0);

      for (const target of Object.values(OrderStatus)) {
        expect(canTransitionOrder(OrderStatus.DELIVERED, target)).toBe(false);
        expect(canTransitionOrder(OrderStatus.CANCELLED, target)).toBe(false);
      }
    });

    it('no debe permitir transiciones inválidas ni auto-transiciones en el ciclo de vida', () => {
      // PENDING no puede saltar directamente a IN_TRANSIT ni DELIVERED
      expect(canTransitionOrder(OrderStatus.PENDING, OrderStatus.IN_TRANSIT)).toBe(false);
      expect(canTransitionOrder(OrderStatus.PENDING, OrderStatus.DELIVERED)).toBe(false);

      // ASSIGNED no puede saltar a DELIVERED ni volver a PENDING
      expect(canTransitionOrder(OrderStatus.ASSIGNED, OrderStatus.DELIVERED)).toBe(false);
      expect(canTransitionOrder(OrderStatus.ASSIGNED, OrderStatus.PENDING)).toBe(false);

      // IN_TRANSIT no puede retroceder a ASSIGNED ni a PENDING
      expect(canTransitionOrder(OrderStatus.IN_TRANSIT, OrderStatus.ASSIGNED)).toBe(false);
      expect(canTransitionOrder(OrderStatus.IN_TRANSIT, OrderStatus.PENDING)).toBe(false);

      // Auto-transiciones rechazadas
      expect(canTransitionOrder(OrderStatus.PENDING, OrderStatus.PENDING)).toBe(false);
      expect(canTransitionOrder(OrderStatus.ASSIGNED, OrderStatus.ASSIGNED)).toBe(false);
      expect(canTransitionOrder(OrderStatus.IN_TRANSIT, OrderStatus.IN_TRANSIT)).toBe(false);
      expect(canTransitionOrder(OrderStatus.DELIVERED, OrderStatus.DELIVERED)).toBe(false);
      expect(canTransitionOrder(OrderStatus.CANCELLED, OrderStatus.CANCELLED)).toBe(false);
    });
  });

  describe('validateOrderTransition', () => {
    it('no debe lanzar excepción en transiciones válidas', () => {
      expect(() => validateOrderTransition(OrderStatus.PENDING, OrderStatus.ASSIGNED)).not.toThrow();
      expect(() => validateOrderTransition(OrderStatus.PENDING, OrderStatus.CANCELLED)).not.toThrow();
      expect(() => validateOrderTransition(OrderStatus.ASSIGNED, OrderStatus.IN_TRANSIT)).not.toThrow();
      expect(() => validateOrderTransition(OrderStatus.ASSIGNED, OrderStatus.CANCELLED)).not.toThrow();
      expect(() => validateOrderTransition(OrderStatus.IN_TRANSIT, OrderStatus.DELIVERED)).not.toThrow();
      expect(() => validateOrderTransition(OrderStatus.IN_TRANSIT, OrderStatus.CANCELLED)).not.toThrow();
    });

    it('debe lanzar BadRequestException al intentar salir de un estado terminal', () => {
      expect(() => validateOrderTransition(OrderStatus.DELIVERED, OrderStatus.CANCELLED)).toThrow(
        BadRequestException,
      );
      expect(() => validateOrderTransition(OrderStatus.CANCELLED, OrderStatus.PENDING)).toThrow(
        BadRequestException,
      );
    });

    it('debe lanzar BadRequestException en transiciones prohibidas por el grafo', () => {
      expect(() => validateOrderTransition(OrderStatus.PENDING, OrderStatus.DELIVERED)).toThrow(
        BadRequestException,
      );
      expect(() => validateOrderTransition(OrderStatus.ASSIGNED, OrderStatus.PENDING)).toThrow(
        BadRequestException,
      );
      expect(() => validateOrderTransition(OrderStatus.IN_TRANSIT, OrderStatus.PENDING)).toThrow(
        BadRequestException,
      );
    });
  });
});
