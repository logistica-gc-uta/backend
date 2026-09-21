import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../database/prisma.service.js';
import { AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { OrderStatus } from './dto/update-order-status.dto.js';
import { OrdersService } from './orders.service.js';

describe('OrdersService', () => {
  let service: OrdersService;
  let prismaMock: any;
  let txMock: any;

  beforeEach(async () => {
    txMock = {
      orm: {
        public: {
          Product: {
            where: jest.fn().mockReturnValue({
              update: jest.fn().mockResolvedValue({ id: 'prod-1', stock: 8 }),
            }),
          },
          Order: {
            create: jest.fn().mockImplementation((data) =>
              Promise.resolve({
                id: 'order-uuid-1',
                ...data,
              }),
            ),
          },
          OrderItem: {
            create: jest.fn().mockImplementation((data) =>
              Promise.resolve({
                id: 'order-item-uuid-1',
                ...data,
              }),
            ),
          },
        },
      },
    };

    prismaMock = {
      zone: {
        where: jest.fn(),
      },
      product: {
        where: jest.fn(),
      },
      order: {
        where: jest.fn().mockReturnThis(),
        include: jest.fn().mockReturnThis(),
        first: jest.fn(),
        all: jest.fn(),
        update: jest.fn(),
      },
      client: {
        transaction: jest.fn((callback) => callback(txMock)),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        {
          provide: PrismaService,
          useValue: prismaMock,
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createOrder', () => {
    const validZone = { id: 'zone-1', name: 'Centro', code: 'CEN-01' };
    const validProduct = {
      id: 'prod-1',
      name: 'Laptop HP',
      price: 750.0,
      stock: 10,
    };

    const createDto = {
      zoneId: 'zone-1',
      deliveryAddress: 'Av. Los Chasquis 123',
      scheduledDeliveryDate: '2026-09-25T14:00:00.000Z',
      items: [
        {
          productId: 'prod-1',
          quantity: 2,
        },
      ],
    };

    it('Caso 1: Creación exitosa de orden con cálculo de total y descuento de stock', async () => {
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(validZone),
      });

      prismaMock.product.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(validProduct),
      });

      const result = await service.createOrder('user-1', createDto);

      expect(result).toBeDefined();
      expect(result.id).toBe('order-uuid-1');
      expect(result.userId).toBe('user-1');
      expect(result.zoneId).toBe('zone-1');
      expect(result.deliveryAddress).toBe('Av. Los Chasquis 123');
      expect(result.total).toBe(1500.0); // 750 * 2
      expect(result.status).toBe(OrderStatus.PENDING);

      // Descuento de stock en transacción
      expect(txMock.orm.public.Product.where).toHaveBeenCalledWith({ id: 'prod-1' });
      // Items creados
      expect(txMock.orm.public.OrderItem.create).toHaveBeenCalledWith({
        orderId: 'order-uuid-1',
        productId: 'prod-1',
        quantity: 2,
        price: 750.0,
      });
    });

    it('Caso 2: Error por stock insuficiente (BadRequestException)', async () => {
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(validZone),
      });

      prismaMock.product.where.mockReturnValue({
        first: jest.fn().mockResolvedValue({
          ...validProduct,
          stock: 1, // solo 1 disponible, pero se solicitan 2
        }),
      });

      await expect(service.createOrder('user-1', createDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('Caso 3: Error por zona inexistente (NotFoundException)', async () => {
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(null),
      });

      await expect(service.createOrder('user-1', createDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('Caso 4: Error por producto inexistente (NotFoundException)', async () => {
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(validZone),
      });

      prismaMock.product.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(null),
      });

      await expect(service.createOrder('user-1', createDto)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateStatus', () => {
    const mockOrder = {
      id: 'order-1',
      userId: 'user-1',
      zoneId: 'zone-1',
      status: OrderStatus.PENDING,
      total: 1500,
    };

    const adminUser: AuthenticatedUser = {
      userId: 'admin-id',
      email: 'admin@delivery.com',
      role: 'ADMIN',
    };

    const driverUser: AuthenticatedUser = {
      userId: 'driver-id',
      email: 'driver@delivery.com',
      role: 'DRIVER',
    };

    it('debe actualizar el estado del pedido válidamente por un ADMIN', async () => {
      prismaMock.order.first.mockResolvedValue(mockOrder);
      prismaMock.order.update.mockResolvedValue({
        ...mockOrder,
        status: OrderStatus.ASSIGNED,
      });

      const result = await service.updateStatus(
        'order-1',
        { status: OrderStatus.ASSIGNED },
        adminUser,
      );

      expect(result.status).toBe(OrderStatus.ASSIGNED);
    });

    it('debe lanzar BadRequestException si un DRIVER intenta actualizar un pedido en estado PENDING', async () => {
      prismaMock.order.first.mockResolvedValue(mockOrder);

      await expect(
        service.updateStatus('order-1', { status: OrderStatus.IN_TRANSIT }, driverUser),
      ).rejects.toThrow(
        new BadRequestException('El pedido aún no ha sido asignado a una ruta por un administrador'),
      );
    });

    it('debe permitir a un DRIVER actualizar un pedido que ya está ASSIGNED a IN_TRANSIT', async () => {
      prismaMock.order.first.mockResolvedValue({
        ...mockOrder,
        status: OrderStatus.ASSIGNED,
      });
      prismaMock.order.update.mockResolvedValue({
        ...mockOrder,
        status: OrderStatus.IN_TRANSIT,
      });

      const result = await service.updateStatus(
        'order-1',
        { status: OrderStatus.IN_TRANSIT },
        driverUser,
      );

      expect(result.status).toBe(OrderStatus.IN_TRANSIT);
    });

    it('debe lanzar NotFoundException si el pedido no existe al actualizar estado', async () => {
      prismaMock.order.first.mockResolvedValue(null);

      await expect(
        service.updateStatus('order-none', { status: OrderStatus.DELIVERED }, adminUser),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('findMyOrders', () => {
    it('debe retornar pedidos pertenecientes al usuario autenticado', async () => {
      const orders = [{ id: 'order-1', userId: 'user-1' }];
      prismaMock.order.all.mockResolvedValue(orders);

      const result = await service.findMyOrders('user-1');
      expect(result).toEqual(orders);
    });
  });

  describe('findAll', () => {
    it('debe retornar todos los pedidos para ADMIN', async () => {
      const orders = [{ id: 'order-1' }, { id: 'order-2' }];
      prismaMock.order.all.mockResolvedValue(orders);

      const result = await service.findAll();
      expect(result).toEqual(orders);
    });
  });

  describe('findOne', () => {
    it('debe retornar un pedido si existe', async () => {
      const order = { id: 'order-1' };
      prismaMock.order.first.mockResolvedValue(order);

      const result = await service.findOne('order-1');
      expect(result).toEqual(order);
    });

    it('debe lanzar NotFoundException si el pedido no existe', async () => {
      prismaMock.order.first.mockResolvedValue(null);

      await expect(service.findOne('invalid-id')).rejects.toThrow(NotFoundException);
    });
  });
});
