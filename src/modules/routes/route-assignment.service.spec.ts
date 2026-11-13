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
import { AssignRouteDto } from './dto/assign-route.dto.js';

describe('RouteAssignmentService', () => {
  const todayLocal = Temporal.Now.zonedDateTimeISO('America/Guayaquil').toPlainDate();
  const localMidnight = todayLocal.toZonedDateTime('America/Guayaquil').toInstant();
  const routeIso = localMidnight.add({ hours: 9 }).toString();
  const dto = {
    zoneId: 'zone',
    routeDate: routeIso,
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
          DriverAbsence: model(() => null),
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
  it('confirms coverage orders with null zoneId onto the requested route zone', async () => {
    orders[0].zoneId = null;
    await expect(service.confirmDraft(dto, 'admin')).resolves.toMatchObject({
      status: 'DRAFT',
    });
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
    const endOfToday = localMidnight.add({ hours: 24 }).subtract({ seconds: 1 });

    it('confirms orders scheduled at different hours of the route business day', async () => {
      orders[0].scheduledDeliveryDate = localMidnight; // 00:00 local
      orders.push({ ...orders[0], id: 'second', scheduledDeliveryDate: endOfToday }); // 23:59:59 local
      await expect(
        service.confirmDraft(
          { ...dto, routeDate: localMidnight.toString(), orderIds: ['order', 'second'] },
          'admin',
        ),
      ).resolves.toMatchObject({ status: 'DRAFT' });
    });

    it('accepts a route instant that is not the exact schedule of any order', async () => {
      orders[0].scheduledDeliveryDate = localMidnight.add({ hours: 10 });
      await expect(
        service.confirmDraft({ ...dto, routeDate: localMidnight.add({ hours: 4 }).toString() }, 'admin'),
      ).resolves.toMatchObject({ status: 'DRAFT' });
    });

    it('accepts instants on the same local day that fall on different UTC dates', async () => {
      orders[0].scheduledDeliveryDate = localMidnight.add({ hours: 18, minutes: 30 }); // 18:30 local
      await expect(
        service.confirmDraft({ ...dto, routeDate: localMidnight.add({ hours: 23 }).toString() }, 'admin'), // 23:00 local (next UTC day)
      ).resolves.toMatchObject({ status: 'DRAFT' });
    });

    it.each([
      ['one second after local midnight of the next day', localMidnight.add({ hours: 24 })],
      ['one second before local midnight of the previous day', localMidnight.subtract({ seconds: 1 })],
    ])('rejects an order scheduled %s', async (_label, schedule) => {
      orders[0].scheduledDeliveryDate = schedule;
      await expect(
        service.confirmDraft({ ...dto, routeDate: localMidnight.toString() }, 'admin'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(claims).toHaveLength(0);
    });

    it.each([
      ['one second before today local midnight (yesterday)', localMidnight.subtract({ seconds: 1 })],
      ['today + 24h local midnight (tomorrow)', localMidnight.add({ hours: 24 })],
    ])('rejects confirmDraft, assignDraft and assignLegacy for non-today date (%s)', async (_label, nonToday) => {
      orders[0].scheduledDeliveryDate = nonToday;
      await expect(
        service.confirmDraft({ ...dto, routeDate: nonToday.toString() }, 'admin'),
      ).rejects.toMatchObject({ response: { code: 'ROUTE_DATE_NOT_TODAY' } });
      expect(claims).toHaveLength(0);

      route.date = nonToday;
      claims = [{ id: 'claim', orderId: 'order', routeId: 'route', claimedAt: nonToday }];
      await expect(
        service.assignDraft('route', { driverId: 'driver' }, 'admin'),
      ).rejects.toMatchObject({ response: { code: 'ROUTE_DATE_NOT_TODAY' } });
      expect(reservation).toBeNull();
      expect(driver.isAvailable).toBe(true);

      claims = [];
      await expect(
        service.assignLegacy({ driverId: 'driver', zoneId: 'zone', orderIds: ['order'] }, 'admin'),
      ).rejects.toMatchObject({ response: { code: 'ROUTE_DATE_NOT_TODAY' } });
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
    await expect(
      validate({ routeDate: routeIso, orderIds: ['order'] }, ConfirmDraftRouteDto),
    ).resolves.toBeInstanceOf(ConfirmDraftRouteDto);
    await expect(
      validate({ zoneId: null, routeDate: routeIso, orderIds: ['order'] }, ConfirmDraftRouteDto),
    ).resolves.toBeInstanceOf(ConfirmDraftRouteDto);
    await expect(
      validate({ driverId: 'driver', orderIds: ['order'] }, AssignRouteDto),
    ).resolves.toBeInstanceOf(AssignRouteDto);
    await expect(
      validate({ driverId: 'driver', zoneId: null, orderIds: ['order'] }, AssignRouteDto),
    ).resolves.toBeInstanceOf(AssignRouteDto);
  });

  it('confirms draft route without zoneId using StoreCoverage origin and accepts zoneId null orders', async () => {
    const storeTx = {
      orm: {
        public: {
          User: { where: () => ({ first: async () => ({ id: 'admin', role: 'ADMIN' }) }) },
          Zone: { where: () => ({ first: async () => null }) },
          Driver: { where: () => ({ first: async () => driver, update: async () => driver }) },
          StoreCoverage: {
            where: () => ({
              first: async () => ({ singletonKey: 'GLOBAL', lat: -1.24, lng: -78.61 }),
            }),
          },
          Route: {
            where: () => ({ first: async () => null, all: async () => [] }),
            create: async (value: any) => ({
              id: 'route-null',
              createdAt: Temporal.Instant.from(dto.routeDate),
              ...value,
            }),
          },
          Order: {
            where: ({ id }: any) => ({
              first: async () => orders.find((row) => row.id === id) ?? null,
              update: async (value: any) => {
                const row = orders.find((o) => o.id === id);
                if (row) Object.assign(row, value);
                return row;
              },
            }),
          },
          OrderClaim: {
            where: () => ({ first: async () => null, all: async () => claims }),
            create: async (value: any) => {
              const claim = { id: 'claim', ...value };
              claims.push(claim);
              return claim;
            },
          },
          RouteStop: {
            where: () => ({ first: async () => null, all: async () => [] }),
            create: async (value: any) => value,
          },
          DriverReservation: { where: () => ({ first: async () => null, all: async () => [] }) },
          LegacyRouteReconciliation: { where: () => ({ first: async () => null }) },
          DriverAbsence: { where: () => ({ first: async () => null }) },
        },
      },
    };
    orders = [
      {
        id: 'order',
        zoneId: null,
        status: 'PENDING',
        requiresAdministrativeReview: false,
        scheduledDeliveryDate: Temporal.Instant.from(dto.routeDate),
        deliveryLat: -1.25,
        deliveryLng: -78.62,
      },
    ];
    const coverageService = {
      getCoverage: async () => ({ configured: true, location: { lat: -1.24, lng: -78.61 } }),
    } as any;
    const svc = new RouteAssignmentService(
      { client: { transaction: async (fn: any) => fn(storeTx) } } as unknown as PrismaService,
      new RouteAvailabilityService({ client: storeTx } as unknown as PrismaService),
      undefined,
      coverageService,
    );

    const created = await svc.confirmDraft(
      { routeDate: routeIso, orderIds: ['order'] },
      'admin',
    );
    expect(created).toMatchObject({ zoneId: null, status: 'DRAFT' });
    expect(claims).toHaveLength(1);
  });

  it('rejects draft confirmation without zoneId when neither StoreCoverage nor order zone depot is configured', async () => {
    const emptyTx = {
      orm: {
        public: {
          User: { where: () => ({ first: async () => ({ id: 'admin', role: 'ADMIN' }) }) },
          Zone: { where: () => ({ first: async () => null }) },
          StoreCoverage: { where: () => ({ first: async () => null }) },
          Route: {
            where: () => ({ first: async () => null, all: async () => [] }),
            create: async (value: any) => ({ id: 'route-null', ...value }),
          },
          Order: {
            where: ({ id }: any) => ({
              first: async () => orders.find((row) => row.id === id) ?? null,
              update: async (value: any) => value,
            }),
          },
          OrderClaim: { where: () => ({ first: async () => null, all: async () => [] }) },
          RouteStop: { where: () => ({ first: async () => null, all: async () => [] }) },
        },
      },
    };
    orders = [
      {
        id: 'order',
        zoneId: null,
        status: 'PENDING',
        requiresAdministrativeReview: false,
        scheduledDeliveryDate: Temporal.Instant.from(dto.routeDate),
        deliveryLat: -1.25,
        deliveryLng: -78.62,
      },
    ];
    const svc = new RouteAssignmentService(
      { client: { transaction: async (fn: any) => fn(emptyTx) } } as unknown as PrismaService,
      new RouteAvailabilityService({ client: emptyTx } as unknown as PrismaService),
    );

    await expect(
      svc.confirmDraft({ routeDate: routeIso, orderIds: ['order'] }, 'admin'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(claims).toHaveLength(0);
  });

  it('assigns legacy route with omitted or null zoneId when StoreCoverage is configured', async () => {
    const createdStops: any[] = [];
    const storeTx = {
      orm: {
        public: {
          User: { where: () => ({ first: async () => ({ id: 'admin', role: 'ADMIN' }) }) },
          Zone: { where: () => ({ first: async () => null }) },
          Driver: { where: () => ({ first: async () => driver, update: async () => driver }) },
          StoreCoverage: {
            where: () => ({
              first: async () => ({ singletonKey: 'GLOBAL', lat: -1.24, lng: -78.61 }),
            }),
          },
          Route: (() => {
            let storedRoute: any = null;
            return {
              where: () => ({
                first: async () => storedRoute,
                all: async () => [],
                update: async (value: any) => {
                  storedRoute = {
                    ...(storedRoute ?? {}),
                    ...value,
                  };
                  return storedRoute;
                },
              }),
              create: async (value: any) => {
                storedRoute = {
                  id: 'route-legacy-null',
                  createdAt: Temporal.Instant.from(dto.routeDate),
                  ...value,
                };
                return storedRoute;
              },
            };
          })(),
          Order: {
            where: ({ id }: any) => ({
              first: async () => orders.find((row) => row.id === id) ?? null,
              update: async (value: any) => {
                const row = orders.find((o) => o.id === id);
                if (row) Object.assign(row, value);
                return row;
              },
            }),
          },
          OrderClaim: {
            where: (filter?: any) => ({
              first: async () =>
                filter?.id
                  ? claims.find((c) => c.id === filter.id) ?? null
                  : claims.find((c) => !c.releasedAt) ?? null,
              all: async () => claims,
              update: async (value: any) => {
                const row = claims.find((c) => c.id === filter?.id) ?? claims[0];
                if (row) Object.assign(row, value);
                return row;
              },
            }),
            create: async (value: any) => {
              const claim = { id: 'claim', ...value };
              claims.push(claim);
              return claim;
            },
          },
          RouteStop: {
            where: () => ({
              first: async () => createdStops[0] ?? null,
              all: async () => createdStops,
            }),
            create: async (value: any) => {
              createdStops.push(value);
              return value;
            },
          },
          DriverReservation: {
            where: () => ({ first: async () => null, all: async () => [] }),
            create: async (value: any) => value,
          },
          LegacyRouteReconciliation: {
            where: () => ({ first: async () => null, all: async () => [] }),
          },
          DriverAbsence: {
            where: () => ({ first: async () => null, all: async () => [] }),
          },
        },
      },
    };
    orders = [
      {
        id: 'order',
        zoneId: null,
        status: 'PENDING',
        requiresAdministrativeReview: false,
        scheduledDeliveryDate: Temporal.Instant.from(dto.routeDate),
        deliveryLat: -1.25,
        deliveryLng: -78.62,
      },
    ];
    const coverageService = {
      getCoverage: async () => ({ configured: true, location: { lat: -1.24, lng: -78.61 } }),
    } as any;
    const svc = new RouteAssignmentService(
      { client: { transaction: async (fn: any) => fn(storeTx) } } as unknown as PrismaService,
      new RouteAvailabilityService({ client: storeTx } as unknown as PrismaService),
      undefined,
      coverageService,
    );

    const created = await svc.assignLegacy(
      { driverId: 'driver', orderIds: ['order'] },
      'admin',
    );
    expect(created).toMatchObject({ zoneId: null, status: 'ASSIGNED', driverId: 'driver' });
  });
});
