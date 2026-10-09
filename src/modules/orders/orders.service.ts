import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { toInstant } from '../../common/temporal.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { OrderStatus, UpdateOrderStatusDto } from './dto/update-order-status.dto.js';
import { validateOrderTransition } from './order-status.policy.js';

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async createOrder(userId: string, dto: CreateOrderDto) {
    // 1. Validar que la zona exista
    const zone = await this.prisma.zone.where({ id: dto.zoneId }).first();
    if (!zone) {
      throw new NotFoundException(`Zona con ID '${dto.zoneId}' no encontrada`);
    }

    // 2. Validar que cada producto exista y tenga stock suficiente
    const productQuantities = new Map<string, number>();
    for (const item of dto.items) {
      const current = productQuantities.get(item.productId) || 0;
      productQuantities.set(item.productId, current + item.quantity);
    }

    const productsToUpdate: Array<{
      id: string;
      price: number;
      name: string;
      quantity: number;
      newStock: number;
    }> = [];
    let totalOrder = 0;

    for (const [productId, quantity] of productQuantities.entries()) {
      const product = await this.prisma.product.where({ id: productId }).first();
      if (!product) {
        throw new NotFoundException(`Producto con ID '${productId}' no encontrado`);
      }
      if (product.stock < quantity) {
        throw new BadRequestException(
          `Stock insuficiente para el producto '${product.name}'. Solicitado: ${quantity}, Disponible: ${product.stock}`,
        );
      }
      totalOrder += product.price * quantity;
      productsToUpdate.push({
        id: product.id,
        price: product.price,
        name: product.name,
        quantity,
        newStock: product.stock - quantity,
      });
    }

    // 3. Ejecutar creación atómica en transacción
    return this.prisma.client.transaction(async (tx) => {
      // a. Descontar stock
      for (const item of productsToUpdate) {
        await tx.orm.public.Product.where({ id: item.id }).update({
          stock: item.newStock,
        });
      }

      // b. Crear la orden
      const order = await tx.orm.public.Order.create({
        userId,
        zoneId: dto.zoneId,
        deliveryAddress: dto.deliveryAddress,
        scheduledDeliveryDate: dto.scheduledDeliveryDate ? toInstant(dto.scheduledDeliveryDate) : null,
        status: OrderStatus.PENDING,
        total: totalOrder,
      });

      // c. Crear items asociados
      for (const item of dto.items) {
        const prodInfo = productsToUpdate.find((p) => p.id === item.productId)!;
        await tx.orm.public.OrderItem.create({
          orderId: order.id,
          productId: item.productId,
          quantity: item.quantity,
          price: prodInfo.price,
        });
      }

      return order;
    });
  }

  async findMyOrders(userId: string) {
    return this.prisma.order
      .where({ userId })
      .include('items', (i) => i.include('product'))
      .include('zone')
      .all();
  }

  async findAll() {
    return this.prisma.order
      .include('items', (i) => i.include('product'))
      .include('zone')
      .include('user')
      .all();
  }

  async findOne(id: string, user: AuthenticatedUser) {
    const order = await this.prisma.order
      .where({ id })
      .include('items', (i) => i.include('product'))
      .include('zone')
      .first();

    if (!order) {
      throw new NotFoundException(`Pedido con ID '${id}' no encontrado`);
    }

    if (user.role === 'ADMIN') {
      return order;
    }

    if (user.role === 'CLIENT') {
      if (order.userId !== user.userId) {
        throw new ForbiddenException('No tiene permisos para consultar este pedido');
      }
      return order;
    }

    if (user.role === 'DRIVER') {
      const driver = await this.prisma.driver.where({ userId: user.userId }).first();
      if (!driver) {
        throw new ForbiddenException('El usuario no tiene un perfil de repartidor asociado');
      }

      if (!order.routeId) {
        throw new ForbiddenException('El pedido no está asignado a ninguna ruta');
      }

      const route = await this.prisma.route.where({ id: order.routeId }).first();
      if (!route || route.driverId !== driver.id) {
        throw new ForbiddenException('No tiene permisos para consultar pedidos de otra ruta');
      }

      return order;
    }

    throw new ForbiddenException('Rol no autorizado para consultar pedidos');
  }

  async updateStatus(id: string, dto: UpdateOrderStatusDto, user: AuthenticatedUser) {
    const order = await this.prisma.order.where({ id }).first();
    if (!order) {
      throw new NotFoundException(`Pedido con ID '${id}' no encontrado`);
    }

    // 1. Validar transición de estado en el grafo centralizado de ciclo de vida
    validateOrderTransition(order.status as OrderStatus, dto.status);

    // 2. Control estricto de permisos y roles en mutaciones
    if (user.role === 'ADMIN') {
      if (dto.status === OrderStatus.ASSIGNED) {
        throw new BadRequestException(
          'La asignación de pedidos solo puede realizarse a través del endpoint de rutas',
        );
      }
      if (dto.status !== OrderStatus.CANCELLED) {
        throw new BadRequestException(
          'Los administradores solo pueden cancelar pedidos no terminales',
        );
      }
    } else if (user.role === 'DRIVER') {
      // Resolución de identidad User -> Driver -> Route -> Order
      const driver = await this.prisma.driver.where({ userId: user.userId }).first();
      if (!driver) {
        throw new ForbiddenException('El usuario no tiene un perfil de repartidor asociado');
      }

      if (!order.routeId) {
        throw new ForbiddenException('El pedido no está asignado a ninguna ruta');
      }

      const route = await this.prisma.route.where({ id: order.routeId }).first();
      if (!route || route.driverId !== driver.id) {
        throw new ForbiddenException('No tiene permisos para modificar pedidos de otra ruta');
      }

      // Restricción explícita acordada: Fail closed hasta que exista Route.IN_PROGRESS (#10)
      throw new ForbiddenException(
        'Las actualizaciones de estado por parte del repartidor están deshabilitadas hasta que se implemente la verificación de ruta en progreso (#10)',
      );
    } else {
      throw new ForbiddenException('Rol no autorizado para modificar el estado del pedido');
    }

    // 3. Mutación atómica condicional para mitigar carreras de estado stale
    const updated = await this.prisma.order
      .where({ id, status: order.status })
      .update({ status: dto.status });

    if (!updated) {
      throw new ConflictException(
        'El pedido fue modificado concurrentemente y ya no se encuentra en el estado esperado',
      );
    }

    return updated;
  }
}
