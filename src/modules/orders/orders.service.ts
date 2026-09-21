import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { OrderStatus, UpdateOrderStatusDto } from './dto/update-order-status.dto.js';

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
        scheduledDeliveryDate: dto.scheduledDeliveryDate ? new Date(dto.scheduledDeliveryDate) : null,
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

  async findOne(id: string) {
    const order = await this.prisma.order
      .where({ id })
      .include('items', (i) => i.include('product'))
      .include('zone')
      .first();

    if (!order) {
      throw new NotFoundException(`Pedido con ID '${id}' no encontrado`);
    }
    return order;
  }

  async updateStatus(id: string, dto: UpdateOrderStatusDto, user: AuthenticatedUser) {
    const order = await this.prisma.order.where({ id }).first();
    if (!order) {
      throw new NotFoundException(`Pedido con ID '${id}' no encontrado`);
    }

    if (user.role === 'DRIVER' && order.status === OrderStatus.PENDING) {
      throw new BadRequestException(
        'El pedido aún no ha sido asignado a una ruta por un administrador',
      );
    }

    const updated = await this.prisma.order
      .where({ id })
      .update({ status: dto.status });

    return updated;
  }
}
