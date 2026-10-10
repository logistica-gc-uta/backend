import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RouteExecutionService } from './route-execution.service.js';
import { PrismaService } from '../../database/prisma.service.js';

describe('RouteExecutionService.start', () => {
  let route: any;
  let stops: any[];
  let reservation: any;
  let claims: any[];
  let order: any;
  let tx: any;
  let service: RouteExecutionService;
  beforeEach(() => {
    route = {
      id: 'route',
      driverId: 'driver',
      zoneId: 'zone',
      status: 'ASSIGNED',
      startedAt: null,
      startedById: null,
    };
    stops = [
      { orderId: 'order', sequence: 1, outcome: 'PENDING', isLegacy: false },
    ];
    reservation = { reservedAt: {} };
    order = {
      zoneId: 'zone',
      status: 'ASSIGNED',
      routeId: 'route',
      requiresAdministrativeReview: false,
    };
    claims = [{ orderId: 'order', claimedAt: {} }];
    const model = (first: () => any, all = () => []) => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn(async () => first()),
      all: jest.fn(async () => all()),
      update: jest.fn(async (data) => {
        if (data.status) Object.assign(route, data);
        return route;
      }),
    });
    tx = {
      orm: {
        public: {
          Driver: model(() => ({ id: 'driver' })),
          Route: model(() => route),
          DriverReservation: model(() => reservation),
          RouteStop: model(
            () => null,
            () => stops as never[],
          ),
          OrderClaim: model(
            () => null,
            () => claims as never[],
          ),
          Order: model(() => order),
        },
      },
    };
    tx.orm.public.Driver.update = jest.fn(async () => ({
      id: 'driver',
      userId: 'user',
    }));
    service = new RouteExecutionService({
      client: { transaction: async (fn: any) => fn(tx) },
    } as unknown as PrismaService);
  });
  it('starts with server actor and serialized instant, then replays unchanged', async () => {
    const first = await service.start('route', 'user');
    expect(first).toEqual({
      id: 'route',
      status: 'IN_PROGRESS',
      startedAt: expect.any(String),
    });
    expect(route.startedById).toBe('user');
    await expect(service.start('route', 'user')).resolves.toEqual(first);
    expect(tx.orm.public.Driver.update).toHaveBeenCalledWith({
      userId: 'user',
    });
    expect(tx.orm.public.Route.where).toHaveBeenCalledWith({
      id: 'route',
      driverId: 'driver',
    });
  });
  it('rejects a profile lost between the read and ownership lock', async () => {
    tx.orm.public.Driver.update.mockResolvedValue(null);
    await expect(service.start('route', 'user')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(tx.orm.public.Route.update).not.toHaveBeenCalled();
    expect(route.startedAt).toBeNull();
  });
  it.each([null, 'DRAFT', 'COMPLETED'])('rejects status %s', async (status) => {
    route.status = status;
    await expect(service.start('route', 'user')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
  it('rejects missing routes and ownership', async () => {
    route.driverId = 'other';
    await expect(service.start('route', 'user')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    route = null;
    await expect(service.start('route', 'user')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it.each([
    'reservation',
    'claims',
    'legacy',
    'sequence',
    'outcome',
    'empty',
    'too-many',
    'zone',
    'order-status',
    'administrative-hold',
  ])('rejects invalid %s', async (kind) => {
    if (kind === 'reservation') reservation = null;
    if (kind === 'claims') claims = [];
    if (kind === 'legacy') stops[0].isLegacy = true;
    if (kind === 'sequence') stops[0].sequence = 2;
    if (kind === 'outcome') stops[0].outcome = null;
    if (kind === 'empty') stops = [];
    if (kind === 'too-many')
      stops = Array.from({ length: 5 }, (_, index) => ({
        ...stops[0],
        sequence: index + 1,
      }));
    if (kind === 'zone') order.zoneId = 'other-zone';
    if (kind === 'order-status') order.status = 'PENDING';
    if (kind === 'administrative-hold')
      order.requiresAdministrativeReview = true;
    await expect(service.start('route', 'user')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(route.startedAt).toBeNull();
  });
});
