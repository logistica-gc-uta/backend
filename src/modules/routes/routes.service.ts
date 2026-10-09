import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { nowInstant } from '../../common/temporal.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import { OrderStatus } from '../orders/dto/update-order-status.dto.js';
import { canTransitionOrder } from '../orders/order-status.policy.js';
import { AssignRouteDto } from './dto/assign-route.dto.js';

@Injectable()
export class RoutesService {
  constructor(private readonly prisma: PrismaService) {}

  async assignRoute(dto: AssignRouteDto) {
    // 1. Regla de Negocio Crítica: Máximo 4 pedidos por ruta/repartidor
    if (dto.orderIds.length > 4) {
      throw new BadRequestException(
        'No se pueden asignar más de 4 pedidos a una ruta/repartidor',
      );
    }

    if (!dto.orderIds || dto.orderIds.length === 0) {
      throw new BadRequestException('Debe incluir al menos un pedido');
    }

    // 2. Validar existencia y disponibilidad del repartidor
    const driver = await this.prisma.driver.where({ id: dto.driverId }).first();
    if (!driver) {
      throw new NotFoundException(`Repartidor con ID '${dto.driverId}' no encontrado`);
    }

    if (!driver.isAvailable) {
      throw new BadRequestException('El repartidor no está disponible');
    }

    // 3. Validar existencia de la zona
    const zone = await this.prisma.zone.where({ id: dto.zoneId }).first();
    if (!zone) {
      throw new NotFoundException(`Zona con ID '${dto.zoneId}' no encontrada`);
    }

    // 4. Validar que todas las órdenes pertenezcan a la zona y existan
    for (const orderId of dto.orderIds) {
      const order = await this.prisma.order.where({ id: orderId }).first();
      if (!order) {
        throw new NotFoundException(`Pedido con ID '${orderId}' no encontrado`);
      }

      if (order.zoneId !== dto.zoneId) {
        throw new BadRequestException(
          `El pedido con ID '${orderId}' no pertenece a la zona especificada`,
        );
      }

      if (!canTransitionOrder(order.status as OrderStatus, OrderStatus.ASSIGNED)) {
        throw new BadRequestException(
          `El pedido con ID '${orderId}' no está en estado PENDING`,
        );
      }
    }

    // 5. Crear la ruta y asignar los pedidos de forma atómica en transacción
    return this.prisma.client.transaction(async (tx) => {
      // a. Validar atómicamente disponibilidad del chofer y marcarlo como no disponible
      const currentDriver = await tx.orm.public.Driver.where({ id: dto.driverId }).first();
      if (!currentDriver || !currentDriver.isAvailable) {
        throw new ConflictException('El repartidor ya no está disponible');
      }

      await tx.orm.public.Driver.where({ id: dto.driverId }).update({
        isAvailable: false,
      });

      // b. Crear la ruta
      const route = await tx.orm.public.Route.create({
        driverId: dto.driverId,
        zoneId: dto.zoneId,
        date: nowInstant(),
      });

      // c. Verificar atómicamente que cada pedido siga siendo asignable según el ciclo de vida y asignar stopOrder secuencial
      let currentStop = 1;
      for (const orderId of dto.orderIds) {
        const currentOrder = await tx.orm.public.Order.where({ id: orderId }).first();
        if (!currentOrder || !canTransitionOrder(currentOrder.status as OrderStatus, OrderStatus.ASSIGNED)) {
          throw new ConflictException(
            `El pedido con ID '${orderId}' ya no se encuentra en estado PENDING para ser asignado`,
          );
        }

        await tx.orm.public.Order.where({ id: orderId }).update({
          routeId: route.id,
          status: OrderStatus.ASSIGNED,
          stopOrder: currentStop++,
        });
      }

      return route;
    });
  }

  async findAll() {
    return this.prisma.route
      .include('driver', (d) => d.include('user'))
      .include('zone')
      .include('orders')
      .all();
  }

  async findOne(id: string) {
    const route = await this.prisma.route
      .where({ id })
      .include('driver', (d) => d.include('user'))
      .include('zone')
      .include('orders')
      .first();

    if (!route) {
      throw new NotFoundException(`Ruta con ID '${id}' no encontrada`);
    }
    return route;
  }
}
