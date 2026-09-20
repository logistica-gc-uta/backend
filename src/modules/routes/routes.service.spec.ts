import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../database/prisma.service.js';
import { RoutesService } from './routes.service.js';

describe('RoutesService', () => {
  let service: RoutesService;
  let prismaMock: any;

  beforeEach(async () => {
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
      client: {
        transaction: jest.fn((callback) => {
          const tx = {
            orm: {
              public: {
                Route: {
                  create: jest.fn().mockImplementation((data) =>
                    Promise.resolve({
                      id: 'route-uuid-123',
                      ...data,
                    }),
                  ),
                },
                Order: {
                  where: jest.fn().mockReturnValue({
                    update: jest.fn().mockResolvedValue({ status: 'ASSIGNED' }),
                  }),
                },
              },
            },
          };
          return callback(tx);
        }),
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

    it('Caso 1: debe asignar exitosamente rutas con 1, 2, 3 y 4 pedidos', async () => {
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

        const result = await service.assignRoute({
          driverId: 'driver-1',
          zoneId: 'zone-1',
          orderIds,
        });

        expect(result).toBeDefined();
        expect(result.id).toBe('route-uuid-123');
        expect(result.driverId).toBe('driver-1');
        expect(result.zoneId).toBe('zone-1');
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

      const orderIds6 = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'];
      await expect(
        service.assignRoute({
          driverId: 'driver-1',
          zoneId: 'zone-1',
          orderIds: orderIds6,
        }),
      ).rejects.toThrow(BadRequestException);
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

    it('Caso 4: debe lanzar BadRequestException si algún pedido no está en estado PENDING', async () => {
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
});
