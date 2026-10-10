import { RouteHistoryService } from '../routes/route-history.service.js';
const historyMock = { project: jest.fn(async (routes: any[]) => routes) };
import { RouteAvailabilityService } from '../routes/route-availability.service.js';
const availabilityMock = {
  effective: jest
    .fn()
    .mockResolvedValue({ isAvailable: true, blockingRouteIds: [] }),
};
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../database/prisma.service.js';
import { DriversService } from './drivers.service.js';

describe('DriversService', () => {
  let service: DriversService;
  let prismaMock: any;

  beforeEach(async () => {
    prismaMock = {
      driver: {
        include: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DriversService,
        { provide: RouteAvailabilityService, useValue: availabilityMock },
        { provide: RouteHistoryService, useValue: historyMock },
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<DriversService>(DriversService);
  });

  it('findAll debe listar los repartidores incluyendo su usuario', async () => {
    const drivers = [
      { id: 'd1', isAvailable: true, user: { name: 'Carlos Chofer' } },
    ];
    const allMock = jest.fn().mockResolvedValue(drivers);
    prismaMock.driver.include.mockReturnValue({ all: allMock });

    const result = await service.findAll();

    expect(prismaMock.driver.include).toHaveBeenCalledWith('user');
    expect(result).toEqual(
      drivers.map((driver) => ({
        ...driver,
        effectiveAvailability: { isAvailable: true, blockingRouteIds: [] },
      })),
    );
  });
});

describe('DriversService ownership query', () => {
  it('returns an empty array when the authenticated user has no driver profile', async () => {
    const first = jest.fn().mockResolvedValue(null);
    const prisma: any = {
      driver: { where: jest.fn().mockReturnValue({ first }) },
    };
    expect(
      await new DriversService(
        prisma,
        availabilityMock as unknown as RouteAvailabilityService,
        historyMock as unknown as RouteHistoryService,
      ).findMyRoutes('jwt-user'),
    ).toEqual([]);
    expect(prisma.driver.where).toHaveBeenCalledWith({ userId: 'jwt-user' });
  });
});

describe('DriversService route projection and ordering', () => {
  function setup(rows: any[]) {
    const query: any = {};
    for (const name of ['where', 'select', 'orderBy', 'include'])
      query[name] = jest.fn().mockReturnValue(query);
    query.all = jest.fn().mockResolvedValue(rows);
    const prisma: any = {
      driver: {
        where: jest.fn().mockReturnValue({
          first: jest.fn().mockResolvedValue({ id: 'owned-driver' }),
        }),
      },
      route: query,
    };
    return {
      query,
      prisma,
      service: new DriversService(
        prisma,
        availabilityMock as unknown as RouteAvailabilityService,
        historyMock as unknown as RouteHistoryService,
      ),
    };
  }
  it('scopes routes to JWT driver and delegates the stable history projection', async () => {
    const rows = [{ id: 'r', date: 'date', zone: { id: 'z' }, status: null }];
    const { service, query } = setup(rows);
    expect(await service.findMyRoutes('jwt-user')).toEqual(rows);
    expect(query.where).toHaveBeenCalledWith({ driverId: 'owned-driver' });
    expect(historyMock.project).toHaveBeenCalledWith(rows);
    expect(query.select).toHaveBeenCalledWith(
      'id',
      'date',
      'status',
      'startedAt',
      'startedById',
      'completedAt',
      'completedById',
      'returnedAt',
      'returnedById',
    );
    expect(query.include).toHaveBeenCalledTimes(1);
    const zone = { select: jest.fn() };
    query.include.mock.calls[0][1](zone);
    expect(zone.select).toHaveBeenCalledWith('id', 'name', 'code');
  });
  it('adds inclusive/exclusive Route.date predicates without dropping ownership', async () => {
    const { service, query } = setup([]);
    await service.findMyRoutes('jwt-user', '2024-02-29');
    const gte = jest.fn();
    const lt = jest.fn();
    query.where.mock.calls[1][0]({ date: { gte } });
    query.where.mock.calls[2][0]({ date: { lt } });
    expect(gte.mock.calls[0][0].toString()).toBe('2024-02-29T05:00:00Z');
    expect(lt.mock.calls[0][0].toString()).toBe('2024-03-01T05:00:00Z');
  });
  it('rejects absent identity and invalid dates before any lookup', async () => {
    const { service, prisma } = setup([]);
    await expect(service.findMyRoutes('')).rejects.toThrow('Unauthorized');
    await expect(
      service.findMyRoutes('jwt-user', '2023-02-29'),
    ).rejects.toThrow('date must');
    expect(prisma.driver.where).not.toHaveBeenCalled();
  });
});
