import { RouteProgressService } from '../routes/route-progress.service.js';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BUSINESS_TIME_ZONE } from '../../common/temporal.util.js';
import { legacyPriceCents, MAX_JSON_CENTS } from '../../common/money-cents.util.js';
import { CreateAdminOrderDto } from './dto/create-admin-order.dto.js';
import { assertDeliveryFuture, deliveryClock, parseDeliveryTiming } from './order-delivery.util.js';
import { ListAdminOrdersDto } from './dto/list-admin-orders.dto.js';
import { projectOrder } from './order-response.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import {
  OrderStatus,
  UpdateOrderStatusDto,
} from './dto/update-order-status.dto.js';
import {
  evaluatePlanningEligibility,
  validateCoordinatePair,
} from './order-geography.util.js';
import { validateOrderTransition } from './order-status.policy.js';
import { consolidateOrderItems, lockInventoryProduct } from './order-inventory.util.js';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly progress: RouteProgressService,
  ) {}

  async createOrder(userId: string, dto: CreateOrderDto) {
    const owner = await this.registeredOwner(userId);
    const order = await this.persistOrder(dto, {
      userId: owner.id, createdById: userId, recipientType: 'REGISTERED_CLIENT',
      recipientName: this.recipientText(owner.name, 120, 'name'), recipientPhone: null,
      deliveryWindowStart: null, deliveryWindowEnd: null,
    });
    return projectOrder(order, false);
  }

  private recipientText(value: string, max: number, field: string): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
      throw new BadRequestException(`Invalid recipient ${field}`);
    }
    return value.trim();
  }

  private async registeredOwner(id: string) {
    const owner = await this.prisma.user.where({ id }).select('id', 'name', 'role').first();
    if (!owner) throw new NotFoundException('Registered client not found');
    if (owner.role !== 'CLIENT') throw new BadRequestException('Registered owner must be a CLIENT');
    return owner;
  }

  async createAdminOrder(actorId: string, dto: CreateAdminOrderDto) {
    const { deliveryWindowStart: start, deliveryWindowEnd: end } = parseDeliveryTiming(dto, true);

    let ownerId: string | null = null;
    let name: string;
    if (dto.recipient.type === 'REGISTERED_CLIENT') {
      const owner = await this.registeredOwner(dto.recipient.clientId);
      ownerId = owner.id;
      name = owner.name;
    } else if (dto.recipient.type === 'GUEST') {
      name = dto.recipient.name;
    } else {
      throw new BadRequestException('Unknown recipient type');
    }
    const phone = dto.recipient.contactPhone === undefined ? null :
      this.recipientText(dto.recipient.contactPhone, 40, 'phone');
    if (dto.recipient.type === 'GUEST' && phone === null) throw new BadRequestException('Guest contact is required');
    const order = await this.persistOrder(dto, {
      userId: ownerId, createdById: actorId, recipientType: dto.recipient.type,
      recipientName: this.recipientText(name, 120, 'name'), recipientPhone: phone,
      deliveryWindowStart: start, deliveryWindowEnd: end,
    }, true);
    return projectOrder(order, true);
  }

  private async persistOrder(dto: CreateOrderDto, metadata: {
    userId: string | null; createdById: string; recipientType: 'REGISTERED_CLIENT' | 'GUEST';
    recipientName: string; recipientPhone: string | null;
    deliveryWindowStart: Temporal.Instant | null; deliveryWindowEnd: Temporal.Instant | null;
  }, requireGeography = false) {
    const timing = parseDeliveryTiming(dto, requireGeography);
    const coords = validateCoordinatePair(
      dto.deliveryLat,
      dto.deliveryLng,
      'delivery',
    );

    // 1. Validar que la zona exista
    const zone = await this.prisma.zone.where({ id: dto.zoneId }).first();
    if (!zone) {
      throw new NotFoundException(`Zona con ID '${dto.zoneId}' no encontrada`);
    }

    if (requireGeography && !evaluatePlanningEligibility(dto, zone).planningEligibility.eligible) {
      throw new BadRequestException('Confirmed delivery coordinates and configured zone depot are required');
    }

    const consolidated = consolidateOrderItems(dto.items);
    return this.prisma.client.transaction(async (tx) => {
      // One authoritative advancing clock, including the initial deadline check.
      assertDeliveryFuture(timing, await deliveryClock(tx, this.prisma.client.raw));
      let totalOrder = 0;
      let subtotalCents = 0n;
      const reserved = [];
      for (const { productId, quantity } of consolidated) {
        const product = await lockInventoryProduct(tx, this.prisma.client.raw, productId);
        // Every lock can wait, including later products after earlier reservations.
        const lockedAt = await deliveryClock(tx, this.prisma.client.raw);
        assertDeliveryFuture(timing, lockedAt);
        if (product.stock < quantity) {
          throw new BadRequestException(
            `Stock insuficiente para el producto '${product.name}'. Solicitado: ${quantity}, Disponible: ${product.stock}`,
          );
        }
        await tx.orm.public.Product.where({ id: productId }).update({ stock: product.stock - quantity, updatedAt: lockedAt });
        const unitPriceCents = legacyPriceCents(product.price);
        subtotalCents += unitPriceCents * BigInt(quantity);
        if (subtotalCents > BigInt(MAX_JSON_CENTS)) {
          throw new BadRequestException('Order subtotal exceeds supported cent range');
        }
        totalOrder += product.price * quantity;
        reserved.push({ productId, quantity, price: product.price, unitPriceCents });
      }

      // b. Crear la orden
      const order = await tx.orm.public.Order.create({
        ...metadata,
        zoneId: dto.zoneId,
        deliveryAddress: dto.deliveryAddress,
        deliveryLat: coords.lat,
        deliveryLng: coords.lng,
        scheduledDeliveryDate: timing.scheduledDeliveryDate,
        status: OrderStatus.PENDING,
        total: totalOrder,
        subtotalCents,
      });

      // c. Crear items asociados
      const items = [];
      for (const item of reserved) {
        items.push(await tx.orm.public.OrderItem.create({ orderId: order.id, ...item }));
      }

      // Last validation after actual item writes; throwing rolls back everything.
      // A small check-to-COMMIT interval remains; this is not a commit-time guard.
      assertDeliveryFuture(timing, await deliveryClock(tx, this.prisma.client.raw));
      return { ...order, items };
    });
  }

  async findMyOrders(userId: string) {
    const orders = await this.prisma.order
      .where({ userId })
      .include('items', (i) => i.include('product'))
      .include('zone')
      .all();
    return orders.map((order) => projectOrder(order, false));
  }

  async findAll(dto: ListAdminOrdersDto = new ListAdminOrdersDto()) {
    let query = this.prisma.order;
    if (dto.zoneId !== undefined) query = query.where({ zoneId: dto.zoneId });
    if (dto.status !== undefined) query = query.where({ status: dto.status });
    if (dto.date !== undefined) {
      let start: Temporal.Instant;
      let end: Temporal.Instant;
      try {
        const date = Temporal.PlainDate.from(dto.date, { overflow: 'reject' });
        start = date.toZonedDateTime(BUSINESS_TIME_ZONE).toInstant();
        end = date.add({ days: 1 }).toZonedDateTime(BUSINESS_TIME_ZONE).toInstant();
      } catch { throw new BadRequestException('Invalid scheduled business day'); }
      query = query.where((order) => order.scheduledDeliveryDate.gte(start))
        .where((order) => order.scheduledDeliveryDate.lt(end));
    }
    const counts = await query.aggregate((aggregate) => ({ total: aggregate.count() }));
    const orders = await query
      .orderBy([(order) => order.scheduledDeliveryDate.asc(), (order) => order.id.asc()])
      .limit(dto.pageSize).offset((dto.page - 1) * dto.pageSize)
      .include('items', (i) => i.include('product'))
      .include('zone')
      .include('user', (user) => user.select('id', 'name'))
      .all();
    return { items: orders.map((order) => projectOrder(order, true)), total: counts.total, page: dto.page, pageSize: dto.pageSize };
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
      return projectOrder(order, true);
    }

    if (user.role === 'CLIENT') {
      if (order.userId !== user.userId) {
        throw new ForbiddenException(
          'No tiene permisos para consultar este pedido',
        );
      }
      return projectOrder(order, false);
    }

    if (user.role === 'DRIVER') {
      const driver = await this.prisma.driver
        .where({ userId: user.userId })
        .first();
      if (!driver) {
        throw new ForbiddenException(
          'El usuario no tiene un perfil de repartidor asociado',
        );
      }

      if (!order.routeId) {
        throw new ForbiddenException(
          'El pedido no está asignado a ninguna ruta',
        );
      }

      const route = await this.prisma.route
        .where({ id: order.routeId })
        .first();
      if (!route || route.driverId !== driver.id) {
        throw new ForbiddenException(
          'No tiene permisos para consultar pedidos de otra ruta',
        );
      }

      return projectOrder(order, true);
    }

    throw new ForbiddenException('Rol no autorizado para consultar pedidos');
  }

  async updateStatus(
    id: string,
    dto: UpdateOrderStatusDto,
    user: AuthenticatedUser,
  ) {
    const order = await this.prisma.order.where({ id }).first();
    if (!order) {
      throw new NotFoundException(`Pedido con ID '${id}' no encontrado`);
    }

    // 1. Control estricto de permisos y pertenencia (autorización precede al grafo)
    if (user.role === 'CLIENT') {
      throw new ForbiddenException(
        'Rol no autorizado para modificar el estado del pedido',
      );
    }

    if (user.role === 'DRIVER') {
      const updated = await this.progress.updateOrder(id, user.userId, dto.status);
      return projectOrder(updated, true);
    }

    if (user.role === 'ADMIN') {
      // 2. Validar transición de estado en el grafo centralizado (solo tras autorizar)
      validateOrderTransition(order.status as OrderStatus, dto.status);

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
    } else {
      throw new ForbiddenException(
        'Rol no autorizado para modificar el estado del pedido',
      );
    }

    return projectOrder(await this.progress.cancelOrder(id), true);
  }
}
