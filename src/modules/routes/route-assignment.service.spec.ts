import { RouteAvailabilityService } from './route-availability.service.js';
import {
  BadRequestException,
  ConflictException,
  ValidationPipe,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { RouteAssignmentService } from './route-assignment.service.js';
import { ConfirmDraftRouteDto } from './dto/confirm-draft-route.dto.js';
import { AssignDraftRouteDto } from './dto/assign-draft-route.dto.js';

describe('RouteAssignmentService', () => {
  const dto = {
    zoneId: 'zone',
    routeDate: '2026-10-10T00:00:00Z',
    orderIds: ['order'],
  };
  let service: RouteAssignmentService;
  let orders: any[];
  let route: any;
  let holds: any[];
  let claims: any[];
  let reservation: any;
  let driver: any;
  let orderUpdate: jest.Mock;
  beforeEach(() => {
    orders = [
      {
        id: 'order',
        zoneId: 'zone',
        status: 'PENDING',
        requiresAdministrativeReview: false,
        scheduledDeliveryDate: Temporal.Instant.from(dto.routeDate),
      },
    ];
    route = {
      id: 'route',
      status: 'DRAFT',
      driverId: null,
      zoneId: 'zone',
      date: Temporal.Instant.from(dto.routeDate),
      createdAt: Temporal.Instant.from(dto.routeDate),
    };
    holds = [];
    claims = [];
    driver = { id: 'driver', userId: 'driver-user', isAvailable: true };
    reservation = null;
    const model = (
      first: (filter: any) => any,
      all: () => unknown[] = () => [],
      create = (value: any) => value,
    ) => ({
      where: (filter: any) => ({
        first: async () => first(filter),
        all: async () => all(),
        update: async (value: any) => {
          const row = first(filter);
          if (row) Object.assign(row, value);
          return row;
        },
      }),
      create: async (value: any) => create(value),
    });
    const order = model((filter) => orders.find((row) => row.id === filter.id));
    const originalWhere = order.where;
    orderUpdate = jest.fn(async (id, value) =>
      originalWhere({ id }).update(value),
    );
    order.where = (filter) => ({
      ...originalWhere(filter),
      update: (value) => orderUpdate(filter.id, value),
    });
    const tx = {
      orm: {
        public: {
          User: model((filter) => ({
            id: filter.id,
            role: filter.id === 'admin' ? 'ADMIN' : 'DRIVER',
          })),
          Zone: model(() => ({ id: 'zone' })),
          Driver: model(() => driver),
          Route: model(
            () => route,
            () => holds as never[],
            (value) => ({ ...route, ...value }),
          ),
          Order: order,
          OrderClaim: model(
            (filter) =>
              claims.find((claim) =>
                filter.id
                  ? claim.id === filter.id
                  : claim.orderId === filter.orderId,
              ),
            () => claims as never[],
            (value) => {
              const claim = { id: 'claim', ...value };
              claims.push(claim);
              return claim;
            },
          ),
          RouteStop: model(
            () => null,
            () =>
              [
                {
                  orderId: 'order',
                  sequence: 1,
                  outcome: 'PENDING',
                  isLegacy: false,
                },
              ] as never[],
          ),
          DriverReservation: model(
            () => reservation,
            () => (reservation ? [reservation] : []),
          ),
          LegacyRouteReconciliation: model(() => null),
        },
      },
    };
    service = new RouteAssignmentService(
      {
        client: { transaction: async (fn: any) => fn(tx) },
      } as unknown as PrismaService,
      new RouteAvailabilityService({ client: tx } as unknown as PrismaService),
    );
  });
  it('rejects compatibility wrong-zone input with400 before creating claims', async () => {
    orders[0].zoneId = 'other-zone';
    await expect(
      service.assignLegacy(
        { driverId: 'driver', zoneId: 'zone', orderIds: ['order'] },
        'admin',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(claims).toHaveLength(0);
  });
  it('assigns compatibility orders with their common exact timestamp', async () => {
    expect(
      await service.assignLegacy(
        { driverId: 'driver', zoneId: 'zone', orderIds: ['order'] },
        'admin',
      ),
    ).toMatchObject({ status: 'ASSIGNED', date: dto.routeDate });
    expect(orders[0].status).toBe('ASSIGNED');
    expect(driver.isAvailable).toBe(false);
  });
  it.each(['null', 'mismatch'])(
    'rejects %s compatibility schedules',
    async (kind) => {
      if (kind === 'null') orders[0].scheduledDeliveryDate = null;
      else
        orders.push({
          ...orders[0],
          id: 'second',
          scheduledDeliveryDate: Temporal.Instant.from('2026-10-11T00:00:00Z'),
        });
      await expect(
        service.assignLegacy(
          {
            driverId: 'driver',
            zoneId: 'zone',
            orderIds: orders.map((order) => order.id),
          },
          'admin',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(claims).toHaveLength(0);
    },
  );
  describe('same business day schedules (America/Guayaquil)', () => {
    const at = (iso: string) => Temporal.Instant.from(iso);

    it('confirms orders scheduled at different hours of the route business day', async () => {
      orders[0].scheduledDeliveryDate = at('2026-10-10T05:00:00Z'); // 00:00 local
      orders.push({ ...orders[0], id: 'second', scheduledDeliveryDate: at('2026-10-11T04:59:59Z') }); // 23:59:59 local
      await expect(
        service.confirmDraft(
          { ...dto, routeDate: '2026-10-10T05:00:00Z', orderIds: ['order', 'second'] },
          'admin',
        ),
      ).resolves.toMatchObject({ status: 'DRAFT' });
    });

    it('accepts a route instant that is not the exact schedule of any order', async () => {
      orders[0].scheduledDeliveryDate = at('2026-10-10T15:00:00Z');
      await expect(
        service.confirmDraft({ ...dto, routeDate: '2026-10-10T09:00:00Z' }, 'admin'),
      ).resolves.toMatchObject({ status: 'DRAFT' });
    });

    it('accepts instants on the same local day that fall on different UTC dates', async () => {
      orders[0].scheduledDeliveryDate = at('2026-10-10T23:30:00Z'); // 18:30 local
      await expect(
        service.confirmDraft({ ...dto, routeDate: '2026-10-11T04:00:00Z' }, 'admin'), // 23:00 local
      ).resolves.toMatchObject({ status: 'DRAFT' });
    });

    it.each([
      ['one second after local midnight of the next day', '2026-10-11T05:00:00Z'],
      ['one second before local midnight of the previous day', '2026-10-10T04:59:59Z'],
    ])('rejects an order scheduled %s', async (_label, schedule) => {
      orders[0].scheduledDeliveryDate = at(schedule);
      await expect(
        service.confirmDraft({ ...dto, routeDate: '2026-10-10T05:00:00Z' }, 'admin'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(claims).toHaveLength(0);
    });
  });

  it('confirms DRAFT without assigning commercial orders', async () => {
    await expect(service.confirmDraft(dto, 'admin')).resolves.toMatchObject({
      status: 'DRAFT',
      driverId: null,
    });
    expect(orders[0].status).toBe('PENDING');
  });
  it('assigns DRAFT and compatibility pointers atomically', async () => {
    claims = [
      {
        id: 'claim',
        orderId: 'order',
        routeId: 'route',
        claimedAt: Temporal.Instant.from(dto.routeDate),
      },
    ];
    await expect(
      service.assignDraft('route', { driverId: 'driver' }, 'admin'),
    ).resolves.toMatchObject({ status: 'ASSIGNED', driverId: 'driver' });
    expect(orders[0]).toMatchObject({
      status: 'ASSIGNED',
      routeId: 'route',
      stopOrder: 1,
    });
  });
  it.each(['zone', 'status', 'review', 'date'])(
    'rejects ineligible order %s',
    async (kind) => {
      if (kind === 'zone') orders[0].zoneId = 'other';
      if (kind === 'status') orders[0].status = 'CANCELLED';
      if (kind === 'review') orders[0].requiresAdministrativeReview = true;
      if (kind === 'date') orders[0].scheduledDeliveryDate = null;
      await expect(service.confirmDraft(dto, 'admin')).rejects.toBeInstanceOf(
        ConflictException,
      );
    },
  );
  it.each([null, 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED'])(
    'rejects non-DRAFT %s',
    async (status) => {
      route.status = status;
      await expect(
        service.assignDraft('route', { driverId: 'driver' }, 'admin'),
      ).rejects.toBeInstanceOf(ConflictException);
    },
  );
  it('rejects a busy driver regardless of available projection', async () => {
    holds = [{ status: 'COMPLETED', returnedAt: null }];
    await expect(
      service.assignDraft('route', { driverId: 'driver' }, 'admin'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('rejects active reservation and missing claims', async () => {
    reservation = { id: 'reservation' };
    await expect(
      service.assignDraft('route', { driverId: 'driver' }, 'admin'),
    ).rejects.toBeInstanceOf(ConflictException);
    reservation = null;
    claims = [];
    await expect(
      service.assignDraft('route', { driverId: 'driver' }, 'admin'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('locks orders in sorted identity order without changing requested stop order', async () => {
    orders.push({ ...orders[0], id: 'another' });
    await service.confirmDraft(
      { ...dto, orderIds: ['order', 'another'] },
      'admin',
    );
    expect(orderUpdate.mock.calls.map(([id]) => id)).toEqual([
      'another',
      'order',
    ]);
  });
  it('validates proposal and driver bodies with production pipe settings', async () => {
    const pipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    const validate = (value: unknown, metatype: any) =>
      pipe.transform(value, { type: 'body', metatype });
    await expect(validate(dto, ConfirmDraftRouteDto)).resolves.toBeInstanceOf(
      ConfirmDraftRouteDto,
    );
    await expect(
      validate({ driverId: 'driver' }, AssignDraftRouteDto),
    ).resolves.toBeInstanceOf(AssignDraftRouteDto);
    for (const value of [
      { ...dto, orderIds: [] },
      { ...dto, orderIds: ['order', 'order'] },
      { ...dto, routeDate: '2026-10-10' },
      { ...dto, actor: 'spoof' },
    ]) {
      await expect(
        validate(value, ConfirmDraftRouteDto),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(
      validate({ driverId: 'driver', actor: 'spoof' }, AssignDraftRouteDto),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
