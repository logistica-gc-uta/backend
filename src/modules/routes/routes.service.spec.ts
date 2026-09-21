import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../database/prisma.service.js';
import { RoutesService } from './routes.service.js';

describe('RoutesService', () => {
  let service: RoutesService;
  let prismaMock: any;
  let txMock: any;

  beforeEach(async () => {
    txMock = {
      orm: {
        public: {
          Driver: {
            where: jest.fn().mockReturnValue({
              first: jest.fn().mockResolvedValue({ id: 'driver-1', isAvailable: true }),
              update: jest.fn().mockResolvedValue({ id: 'driver-1', isAvailable: false }),
            }),
          },
          Route: {
            create: jest.fn().mockImplementation((data) =>
              Promise.resolve({
                id: 'route-uuid-123',
                ...data,
              }),
            ),
          },
          Order: {
            where: jest.fn().mockImplementation((filter: { id: string }) => ({
              first: jest.fn().mockResolvedValue({ id: filter.id, status: 'PENDING' }),
              update: jest.fn().mockResolvedValue({ status: 'ASSIGNED' }),
            })),
          },
        },
      },
    };

    prismaMock = {
      driver: {
        where: jest.fn(),
      },
      zone: {
        where: jest.fn(),
      },
      order: {
        where: jest.fn(),
      },
      route: {
        include: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        all: jest.fn(),
        first: jest.fn(),
      },
      client: {
        transaction: jest.fn((callback) => callback(txMock)),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoutesService,
        {
          provide: PrismaService,
          useValue: prismaMock,
        },
      ],
    }).compile();

    service = module.get<RoutesService>(RoutesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('assignRoute (Regla de negocio: máx. 4 pedidos por repartidor/ruta)', () => {
    const validDriver = {
      id: 'driver-1',
      userId: 'user-driver-1',
      vehicle: 'Camión Isuzu',
      isAvailable: true,
    };

    const validZone = {
      id: 'zone-1',
      name: 'Centro',
      code: 'CEN-01',
    };

    const mockPendingOrder = (id: string, zoneId = 'zone-1') => ({
      id,
      userId: 'client-1',
      zoneId,
      status: 'PENDING',
      total: 100,
    });

    it('Caso 1: debe asignar exitosamente rutas con 1, 2, 3 y 4 pedidos y asignar stopOrder secuencial', async () => {
      prismaMock.driver.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(validDriver),
      });
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(validZone),
      });

      for (const count of [1, 2, 3, 4]) {
        const orderIds = Array.from({ length: count }, (_, i) => `order-${i + 1}`);

        prismaMock.order.where.mockImplementation((filter: { id: string }) => ({
          first: jest.fn().mockResolvedValue(mockPendingOrder(filter.id)),
        }));

        const updateOrderMock = jest.fn().mockResolvedValue({ status: 'ASSIGNED' });
        txMock.orm.public.Order.where.mockImplementation((filter: { id: string }) => ({
          first: jest.fn().mockResolvedValue(mockPendingOrder(filter.id)),
          update: updateOrderMock,
        }));

        const result = await service.assignRoute({
          driverId: 'driver-1',
          zoneId: 'zone-1',
          orderIds,
        });

        expect(result).toBeDefined();
        expect(result.id).toBe('route-uuid-123');
        expect(result.driverId).toBe('driver-1');
        expect(result.zoneId).toBe('zone-1');

        // Verifica que se marcó al chofer como no disponible
        expect(txMock.orm.public.Driver.where).toHaveBeenCalledWith({ id: 'driver-1' });

        // Verifica que se asignó stopOrder secuencial (1..count)
        for (let idx = 0; idx < count; idx++) {
          expect(updateOrderMock).toHaveBeenCalledWith(
            expect.objectContaining({
              routeId: 'route-uuid-123',
              status: 'ASSIGNED',
              stopOrder: idx + 1,
            }),
          );
        }
      }
    });

    it('Caso 2: debe lanzar BadRequestException si se intentan asignar 5 o más pedidos', async () => {
      const orderIds5 = ['ord-1', 'ord-2', 'ord-3', 'ord-4', 'ord-5'];

      await expect(
        service.assignRoute({
          driverId: 'driver-1',
          zoneId: 'zone-1',
          orderIds: orderIds5,
        }),
      ).rejects.toThrow(
        new BadRequestException(
          'No se pueden asignar más de 4 pedidos a una ruta/repartidor',
        ),
      );
    });

    it('Caso 2b: debe lanzar BadRequestException si no se incluye ningún pedido', async () => {
      await expect(
        service.assignRoute({
          driverId: 'driver-1',
          zoneId: 'zone-1',
          orderIds: [],
        }),
      ).rejects.toThrow(
        new BadRequestException(
          'Debe incluir al menos un pedido',
        ),
      );
    });

    it('Caso 3: debe lanzar BadRequestException si el chofer no está disponible', async () => {
      prismaMock.driver.where.mockReturnValue({
        first: jest.fn().mockResolvedValue({
          ...validDriver,
          isAvailable: false,
        }),
      });

      await expect(
        service.assignRoute({
          driverId: 'driver-1',
          zoneId: 'zone-1',
          orderIds: ['order-1'],
        }),
      ).rejects.toThrow(new BadRequestException('El repartidor no está disponible'));
    });

    it('Caso 3b: debe lanzar ConflictException si el chofer deja de estar disponible dentro de la transacción', async () => {
      prismaMock.driver.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(validDriver),
      });
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(validZone),
      });
      prismaMock.order.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(mockPendingOrder('order-1')),
      });

      txMock.orm.public.Driver.where.mockReturnValue({
        first: jest.fn().mockResolvedValue({ id: 'driver-1', isAvailable: false }),
      });

      await expect(
        service.assignRoute({
          driverId: 'driver-1',
          zoneId: 'zone-1',
          orderIds: ['order-1'],
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('Caso 4: debe lanzar BadRequestException si algún pedido no está en estado PENDING previamente', async () => {
      prismaMock.driver.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(validDriver),
      });
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(validZone),
      });

      prismaMock.order.where.mockImplementation((filter: { id: string }) => {
        if (filter.id === 'order-assigned') {
          return {
            first: jest.fn().mockResolvedValue({
              id: 'order-assigned',
              zoneId: 'zone-1',
              status: 'ASSIGNED',
            }),
          };
        }
        return {
          first: jest.fn().mockResolvedValue(mockPendingOrder(filter.id)),
        };
      });

      await expect(
        service.assignRoute({
          driverId: 'driver-1',
          zoneId: 'zone-1',
          orderIds: ['order-1', 'order-assigned'],
        }),
      ).rejects.toThrow(
        new BadRequestException(
          "El pedido con ID 'order-assigned' no está en estado PENDING",
        ),
      );
    });

    it('Caso 4b: debe lanzar ConflictException si un pedido cambia de estado dentro de la transacción', async () => {
      prismaMock.driver.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(validDriver),
      });
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(validZone),
      });
      prismaMock.order.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(mockPendingOrder('order-1')),
      });

      // En la transacción atómica, la orden ya no es PENDING
      txMock.orm.public.Order.where.mockReturnValue({
        first: jest.fn().mockResolvedValue({ id: 'order-1', status: 'IN_TRANSIT' }),
      });

      await expect(
        service.assignRoute({
          driverId: 'driver-1',
          zoneId: 'zone-1',
          orderIds: ['order-1'],
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('Caso adicional: debe rechazar si la orden no pertenece a la zona especificada', async () => {
      prismaMock.driver.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(validDriver),
      });
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(validZone),
      });

      prismaMock.order.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(mockPendingOrder('order-1', 'zone-diferente')),
      });

      await expect(
        service.assignRoute({
          driverId: 'driver-1',
          zoneId: 'zone-1',
          orderIds: ['order-1'],
        }),
      ).rejects.toThrow(
        new BadRequestException(
          "El pedido con ID 'order-1' no pertenece a la zona especificada",
        ),
      );
    });

    it('Caso adicional: debe lanzar NotFoundException si el pedido no existe', async () => {
      prismaMock.driver.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(validDriver),
      });
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(validZone),
      });

      prismaMock.order.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.assignRoute({
          driverId: 'driver-1',
          zoneId: 'zone-1',
          orderIds: ['order-inexistente'],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('Caso adicional: debe lanzar NotFoundException si la zona no existe', async () => {
      prismaMock.driver.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(validDriver),
      });
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.assignRoute({
          driverId: 'driver-1',
          zoneId: 'non-existent-zone',
          orderIds: ['order-1'],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('Caso adicional: debe lanzar NotFoundException si el chofer no existe', async () => {
      prismaMock.driver.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.assignRoute({
          driverId: 'non-existent-driver',
          zoneId: 'zone-1',
          orderIds: ['order-1'],
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('findAll', () => {
    it('debe retornar todas las rutas con relaciones incluidas', async () => {
      const mockRoutes = [
        { id: 'route-1', driver: {}, zone: {}, orders: [] },
      ];
      prismaMock.route.all.mockResolvedValue(mockRoutes);

      const result = await service.findAll();
      expect(result).toEqual(mockRoutes);
    });
  });

  describe('findOne', () => {
    it('debe retornar una ruta por su ID', async () => {
      const mockRoute = { id: 'route-1', driver: {}, zone: {}, orders: [] };
      prismaMock.route.first.mockResolvedValue(mockRoute);

      const result = await service.findOne('route-1');
      expect(result).toEqual(mockRoute);
    });

    it('debe lanzar NotFoundException si la ruta no existe', async () => {
      prismaMock.route.first.mockResolvedValue(null);

      await expect(service.findOne('invalid-id')).rejects.toThrow(NotFoundException);
    });
  });
});
