import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
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
      driver: {
        where: jest.fn(),
      },
      route: {
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

    it('Regresión: persiste scheduledDeliveryDate como Temporal.Instant (no Date) y null si se omite', async () => {
      prismaMock.zone.where.mockReturnValue({ first: jest.fn().mockResolvedValue(validZone) });
      prismaMock.product.where.mockReturnValue({ first: jest.fn().mockResolvedValue(validProduct) });

      await service.createOrder('user-1', createDto);
      const withDate = txMock.orm.public.Order.create.mock.calls[0][0];
      expect(withDate.scheduledDeliveryDate).toBeInstanceOf(Temporal.Instant);
      expect(withDate.scheduledDeliveryDate.toString()).toBe('2026-09-25T14:00:00Z');

      const { scheduledDeliveryDate: _omit, ...dtoWithoutDate } = createDto;
      await service.createOrder('user-1', dtoWithoutDate);
      const withoutDate = txMock.orm.public.Order.create.mock.calls[1][0];
      expect(withoutDate.scheduledDeliveryDate).toBeNull();
    });

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

      expect(txMock.orm.public.Product.where).toHaveBeenCalledWith({ id: 'prod-1' });
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
          stock: 1,
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

  describe('findOne (Control de acceso IDOR/BOLA por rol e identidad JWT)', () => {
    const sampleOrder = {
      id: 'order-1',
      userId: 'client-1',
      zoneId: 'zone-1',
      routeId: 'route-1',
      status: OrderStatus.PENDING,
      total: 1500,
    };

    const adminUser: AuthenticatedUser = {
      userId: 'admin-1',
      email: 'admin@delivery.com',
      role: 'ADMIN',
    };

    const ownerClient: AuthenticatedUser = {
      userId: 'client-1',
      email: 'client1@delivery.com',
      role: 'CLIENT',
    };

    const foreignClient: AuthenticatedUser = {
      userId: 'client-foreign',
      email: 'foreign@delivery.com',
      role: 'CLIENT',
    };

    const assignedDriverUser: AuthenticatedUser = {
      userId: 'user-driver-1',
      email: 'driver1@delivery.com',
      role: 'DRIVER',
    };

    const foreignDriverUser: AuthenticatedUser = {
      userId: 'user-driver-2',
      email: 'driver2@delivery.com',
      role: 'DRIVER',
    };

    it('ADMIN debe poder leer cualquier pedido globalmente', async () => {
      prismaMock.order.first.mockResolvedValue(sampleOrder);

      const result = await service.findOne('order-1', adminUser);
      expect(result).toEqual(sampleOrder);
    });

    it('CLIENT debe poder leer sus propios pedidos', async () => {
      prismaMock.order.first.mockResolvedValue(sampleOrder);

      const result = await service.findOne('order-1', ownerClient);
      expect(result).toEqual(sampleOrder);
    });

    it('CLIENT debe ser rechazado con ForbiddenException si intenta leer pedidos ajenos (IDOR/BOLA)', async () => {
      prismaMock.order.first.mockResolvedValue(sampleOrder);

      await expect(service.findOne('order-1', foreignClient)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('DRIVER debe poder leer el pedido si está asignado a su ruta activa (User -> Driver -> Route -> Order)', async () => {
      prismaMock.order.first.mockResolvedValue(sampleOrder);
      prismaMock.driver.where.mockReturnValue({
        first: jest.fn().mockResolvedValue({ id: 'driver-1', userId: 'user-driver-1' }),
      });
      prismaMock.route.where.mockReturnValue({
        first: jest.fn().mockResolvedValue({ id: 'route-1', driverId: 'driver-1' }),
      });

      const result = await service.findOne('order-1', assignedDriverUser);
      expect(result).toEqual(sampleOrder);
    });

    it('DRIVER debe ser rechazado con ForbiddenException si el pedido no está asignado a ninguna ruta', async () => {
      prismaMock.order.first.mockResolvedValue({ ...sampleOrder, routeId: null });
      prismaMock.driver.where.mockReturnValue({
        first: jest.fn().mockResolvedValue({ id: 'driver-1', userId: 'user-driver-1' }),
      });

      await expect(service.findOne('order-1', assignedDriverUser)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('DRIVER debe ser rechazado con ForbiddenException si el pedido pertenece a una ruta de otro repartidor', async () => {
      prismaMock.order.first.mockResolvedValue(sampleOrder);
      prismaMock.driver.where.mockReturnValue({
        first: jest.fn().mockResolvedValue({ id: 'driver-2', userId: 'user-driver-2' }),
      });
      prismaMock.route.where.mockReturnValue({
        first: jest.fn().mockResolvedValue({ id: 'route-1', driverId: 'driver-1' }),
      });

      await expect(service.findOne('order-1', foreignDriverUser)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('DRIVER debe ser rechazado con ForbiddenException si el usuario no tiene perfil de chofer', async () => {
      prismaMock.order.first.mockResolvedValue(sampleOrder);
      prismaMock.driver.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(null),
      });

      await expect(service.findOne('order-1', assignedDriverUser)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('debe lanzar NotFoundException si el pedido no existe', async () => {
      prismaMock.order.first.mockResolvedValue(null);

      await expect(service.findOne('order-none', adminUser)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateStatus (Ciclo de vida centralizado y permisos estrictos)', () => {
    const pendingOrder = {
      id: 'order-1',
      userId: 'client-1',
      zoneId: 'zone-1',
      routeId: 'route-1',
      status: OrderStatus.PENDING,
      total: 1500,
    };

    const assignedOrder = {
      ...pendingOrder,
      status: OrderStatus.ASSIGNED,
    };

    const inTransitOrder = {
      ...pendingOrder,
      status: OrderStatus.IN_TRANSIT,
    };

    const deliveredOrder = {
      ...pendingOrder,
      status: OrderStatus.DELIVERED,
    };

    const cancelledOrder = {
      ...pendingOrder,
      status: OrderStatus.CANCELLED,
    };

    const adminUser: AuthenticatedUser = {
      userId: 'admin-id',
      email: 'admin@delivery.com',
      role: 'ADMIN',
    };

    const assignedDriverUser: AuthenticatedUser = {
      userId: 'driver-id',
      email: 'driver@delivery.com',
      role: 'DRIVER',
    };

    const foreignDriverUser: AuthenticatedUser = {
      userId: 'foreign-driver-id',
      email: 'foreigndriver@delivery.com',
      role: 'DRIVER',
    };

    it('ADMIN puede cancelar pedidos no terminales (PENDING -> CANCELLED)', async () => {
      prismaMock.order.first.mockResolvedValue(pendingOrder);
      prismaMock.order.update.mockResolvedValue({
        ...pendingOrder,
        status: OrderStatus.CANCELLED,
      });

      const result = await service.updateStatus(
        'order-1',
        { status: OrderStatus.CANCELLED },
        adminUser,
      );

      expect(result.status).toBe(OrderStatus.CANCELLED);
    });

    it('ADMIN puede cancelar pedidos no terminales (ASSIGNED -> CANCELLED e IN_TRANSIT -> CANCELLED)', async () => {
      prismaMock.order.first.mockResolvedValue(assignedOrder);
      prismaMock.order.update.mockResolvedValue({
        ...assignedOrder,
        status: OrderStatus.CANCELLED,
      });

      const res1 = await service.updateStatus(
        'order-1',
        { status: OrderStatus.CANCELLED },
        adminUser,
      );
      expect(res1.status).toBe(OrderStatus.CANCELLED);

      prismaMock.order.first.mockResolvedValue(inTransitOrder);
      prismaMock.order.update.mockResolvedValue({
        ...inTransitOrder,
        status: OrderStatus.CANCELLED,
      });

      const res2 = await service.updateStatus(
        'order-1',
        { status: OrderStatus.CANCELLED },
        adminUser,
      );
      expect(res2.status).toBe(OrderStatus.CANCELLED);
    });

    it('ADMIN es rechazado con BadRequestException si intenta asignar pedidos vía updateStatus (asignación exclusiva en rutas)', async () => {
      prismaMock.order.first.mockResolvedValue(pendingOrder);

      await expect(
        service.updateStatus('order-1', { status: OrderStatus.ASSIGNED }, adminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('ADMIN es rechazado si intenta cambiar el pedido a estados distintos de CANCELLED (ej. IN_TRANSIT, DELIVERED)', async () => {
      prismaMock.order.first.mockResolvedValue(assignedOrder);

      await expect(
        service.updateStatus('order-1', { status: OrderStatus.IN_TRANSIT }, adminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('ADMIN es rechazado con BadRequestException si intenta cancelar un pedido en estado terminal (DELIVERED o CANCELLED)', async () => {
      prismaMock.order.first.mockResolvedValue(deliveredOrder);

      await expect(
        service.updateStatus('order-1', { status: OrderStatus.CANCELLED }, adminUser),
      ).rejects.toThrow(BadRequestException);

      prismaMock.order.first.mockResolvedValue(cancelledOrder);

      await expect(
        service.updateStatus('order-1', { status: OrderStatus.CANCELLED }, adminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('DRIVER escrituras fallan CLOSED con ForbiddenException (bloqueado hasta que exista Route.IN_PROGRESS en #10)', async () => {
      prismaMock.order.first.mockResolvedValue(assignedOrder);
      prismaMock.driver.where.mockReturnValue({
        first: jest.fn().mockResolvedValue({ id: 'driver-1', userId: 'driver-id' }),
      });
      prismaMock.route.where.mockReturnValue({
        first: jest.fn().mockResolvedValue({ id: 'route-1', driverId: 'driver-1' }),
      });

      await expect(
        service.updateStatus('order-1', { status: OrderStatus.IN_TRANSIT }, assignedDriverUser),
      ).rejects.toThrow(ForbiddenException);
    });

    it('DRIVER rechazado con ForbiddenException si intenta modificar un pedido de otra ruta (cross-driver write)', async () => {
      prismaMock.order.first.mockResolvedValue(assignedOrder);
      prismaMock.driver.where.mockReturnValue({
        first: jest.fn().mockResolvedValue({ id: 'driver-2', userId: 'foreign-driver-id' }),
      });
      prismaMock.route.where.mockReturnValue({
        first: jest.fn().mockResolvedValue({ id: 'route-1', driverId: 'driver-1' }),
      });

      await expect(
        service.updateStatus('order-1', { status: OrderStatus.IN_TRANSIT }, foreignDriverUser),
      ).rejects.toThrow(ForbiddenException);
    });

    it('DRIVER rechazado con ForbiddenException si el pedido no tiene ruta asignada', async () => {
      prismaMock.order.first.mockResolvedValue({ ...assignedOrder, routeId: null });
      prismaMock.driver.where.mockReturnValue({
        first: jest.fn().mockResolvedValue({ id: 'driver-1', userId: 'driver-id' }),
      });

      await expect(
        service.updateStatus('order-1', { status: OrderStatus.IN_TRANSIT }, assignedDriverUser),
      ).rejects.toThrow(ForbiddenException);
    });

    it('CLIENT es rechazado con ForbiddenException al intentar modificar estado', async () => {
      prismaMock.order.first.mockResolvedValue(assignedOrder);
      const clientUser: AuthenticatedUser = {
        userId: 'client-1',
        email: 'c@c.com',
        role: 'CLIENT',
      };

      await expect(
        service.updateStatus('order-1', { status: OrderStatus.CANCELLED }, clientUser),
      ).rejects.toThrow(ForbiddenException);
    });

    it('debe detectar y prevenir concurrencia stale si la actualización atómica condicional no afecta filas', async () => {
      prismaMock.order.first.mockResolvedValue(pendingOrder);
      // Simula que la actualización condicional devuelve null (carrera donde el estado cambió entre lectura y escritura)
      prismaMock.order.update.mockResolvedValue(null);

      await expect(
        service.updateStatus('order-1', { status: OrderStatus.CANCELLED }, adminUser),
      ).rejects.toThrow(ConflictException);
    });

    it('debe lanzar NotFoundException si el pedido no existe al actualizar estado', async () => {
      prismaMock.order.first.mockResolvedValue(null);

      await expect(
        service.updateStatus('order-none', { status: OrderStatus.CANCELLED }, adminUser),
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
});
