import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../src/database/prisma.service.js';
import { Role } from '../src/modules/auth/dto/register.dto.js';
import { OrderStatus } from '../src/modules/orders/dto/update-order-status.dto.js';

export interface UserFixture {
  id: string;
  name: string;
  email: string;
  role: Role;
  token: string;
}

export interface DriverFixture {
  id: string;
  userId: string;
  vehicle: string;
  isAvailable: boolean;
}

export interface ZoneFixture {
  id: string;
  name: string;
  code: string;
}

export interface ProductFixture {
  id: string;
  name: string;
  price: number;
  stock: number;
}

export interface RouteFixture {
  id: string;
  driverId: string;
  zoneId: string;
}

export interface OrderFixture {
  id: string;
  userId: string;
  zoneId: string;
  routeId: string | null;
  status: OrderStatus;
  total: number;
  deliveryAddress: string;
}

export class SecurityFixtureManager {
  private readonly createdOrderItemIds: string[] = [];
  private readonly createdOrderIds: string[] = [];
  private readonly createdRouteIds: string[] = [];
  private readonly createdDriverIds: string[] = [];
  private readonly createdUserIds: string[] = [];
  private readonly createdProductIds: string[] = [];
  private readonly createdZoneIds: string[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async createUser(role: Role, prefix: string): Promise<UserFixture> {
    const unique = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const email = `test-sec-${prefix}-${unique}@delivery.test`;
    const passwordHash = await bcrypt.hash('secret123', 10);

    const user = await this.prisma.user.create({
      name: `Sec User ${prefix} ${unique}`,
      email,
      password: passwordHash,
      role,
    });

    this.createdUserIds.push(user.id);

    const token = this.jwtService.sign({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role as Role,
      token,
    };
  }

  createForgedToken(fakeUserId: string, role: Role = Role.CLIENT): string {
    return this.jwtService.sign({
      sub: fakeUserId,
      email: `forged-${fakeUserId}@delivery.test`,
      role,
    });
  }

  async createDriver(userId: string): Promise<DriverFixture> {
    const driver = await this.prisma.driver.create({
      userId,
      vehicle: `Sec-Van-${randomUUID().slice(0, 6)}`,
      isAvailable: true,
    });
    this.createdDriverIds.push(driver.id);
    return {
      id: driver.id,
      userId: driver.userId,
      vehicle: driver.vehicle,
      isAvailable: driver.isAvailable,
    };
  }

  async createZone(): Promise<ZoneFixture> {
    const unique = `${Date.now()}-${randomUUID().slice(0, 6)}`;
    const zone = await this.prisma.zone.create({
      name: `Sec Zone ${unique}`,
      code: `SZ-${unique.slice(-8)}`,
    });
    this.createdZoneIds.push(zone.id);
    return {
      id: zone.id,
      name: zone.name,
      code: zone.code,
    };
  }

  async createProduct(stock = 50, price = 100): Promise<ProductFixture> {
    const unique = `${Date.now()}-${randomUUID().slice(0, 6)}`;
    const product = await this.prisma.product.create({
      name: `Sec Product ${unique}`,
      description: 'Test security product',
      price,
      stock,
    });
    this.createdProductIds.push(product.id);
    return {
      id: product.id,
      name: product.name,
      price: product.price,
      stock: product.stock,
    };
  }

  async createRoute(driverId: string, zoneId: string): Promise<RouteFixture> {
    const route = await this.prisma.route.create({
      driverId,
      zoneId,
    });
    this.createdRouteIds.push(route.id);
    return {
      id: route.id,
      driverId: route.driverId,
      zoneId: route.zoneId,
    };
  }

  async createOrder(
    userId: string,
    zoneId: string,
    routeId: string | null = null,
    status: OrderStatus = OrderStatus.PENDING,
  ): Promise<OrderFixture> {
    const order = await this.prisma.order.create({
      userId,
      zoneId,
      routeId: routeId ?? null,
      status,
      total: 150,
      deliveryAddress: `Av. Seguridad ${randomUUID().slice(0, 6)}`,
    });
    this.createdOrderIds.push(order.id);
    return {
      id: order.id,
      userId: order.userId,
      zoneId: order.zoneId,
      routeId: order.routeId,
      status: order.status as OrderStatus,
      total: order.total,
      deliveryAddress: order.deliveryAddress,
    };
  }

  async createOrderItem(orderId: string, productId: string, quantity = 1, price = 100): Promise<string> {
    const item = await this.prisma.orderItem.create({
      orderId,
      productId,
      quantity,
      price,
    });
    this.createdOrderItemIds.push(item.id);
    return item.id;
  }

  async getOrderSnapshot(id: string) {
    return this.prisma.order.where({ id }).first();
  }

  /**
   * Limpia estricta y exclusivamente los registros creados durante esta suite.
   * Ejecuta eliminaciones en orden inverso de relaciones de clave foránea.
   * Nunca reinicia semillas ni trunca tablas existentes.
   */
  async cleanup(): Promise<void> {
    // 1. OrderItems
    for (const id of this.createdOrderItemIds) {
      try {
        await this.prisma.orderItem.where({ id }).delete();
      } catch {
        // Ignorar si ya fue eliminado
      }
    }

    // 2. Orders
    for (const id of this.createdOrderIds) {
      try {
        await this.prisma.order.where({ id }).delete();
      } catch {
        // Ignorar si ya fue eliminado
      }
    }

    // 3. Routes
    for (const id of this.createdRouteIds) {
      try {
        await this.prisma.route.where({ id }).delete();
      } catch {
        // Ignorar si ya fue eliminado
      }
    }

    // 4. Drivers
    for (const id of this.createdDriverIds) {
      try {
        await this.prisma.driver.where({ id }).delete();
      } catch {
        // Ignorar si ya fue eliminado
      }
    }

    // 5. Users
    for (const id of this.createdUserIds) {
      try {
        await this.prisma.user.where({ id }).delete();
      } catch {
        // Ignorar si ya fue eliminado
      }
    }

    // 6. Products
    for (const id of this.createdProductIds) {
      try {
        await this.prisma.product.where({ id }).delete();
      } catch {
        // Ignorar si ya fue eliminado
      }
    }

    // 7. Zones
    for (const id of this.createdZoneIds) {
      try {
        await this.prisma.zone.where({ id }).delete();
      } catch {
        // Ignorar si ya fue eliminado
      }
    }
  }
}
