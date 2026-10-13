import { createHmac } from 'node:crypto';
import { Role } from '../auth/dto/register.dto.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RealtimeService } from './realtime.service.js';
import type { RealtimeChange } from './realtime.contract.js';

const SECRET = 'unit-test-realtime-secret';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const ORDER_ID = '33333333-3333-4333-8333-333333333333';
const ROUTE_ID = '44444444-4444-4444-8444-444444444444';
const DRIVER_ID = '55555555-5555-4555-8555-555555555555';

function signedToken(
  sub = USER_ID,
  role = Role.CLIENT,
  exp = Math.floor(Date.now() / 1000) + 60,
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, role, exp })).toString('base64url');
  const input = `${header}.${payload}`;
  const signature = createHmac('sha256', SECRET).update(input).digest('base64url');
  return `${input}.${signature}`;
}

function modelReader(rows: Record<string, unknown>) {
  return {
    where: jest.fn((filter: { id: string }) => ({
      select: jest.fn().mockReturnThis(),
      first: jest.fn(async () => rows[filter.id] ?? null),
    })),
  };
}

function createPrisma(rows: {
  users?: Record<string, unknown>;
  orders?: Record<string, unknown>;
  routes?: Record<string, unknown>;
  drivers?: Record<string, unknown>;
} = {}) {
  return {
    user: modelReader(rows.users ?? {}),
    order: modelReader(rows.orders ?? {}),
    route: modelReader(rows.routes ?? {}),
    driver: modelReader(rows.drivers ?? {}),
  } as unknown as PrismaService;
}

function createSocket(token: string, rooms: string[]) {
  return {
    data: { realtimeToken: token },
    rooms: new Set(rooms),
    emit: jest.fn(),
    disconnect: jest.fn(),
  };
}

describe('RealtimeService', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  it('fails closed for missing secret, malformed, wrong-signature, expired and deleted-user tokens', async () => {
    const service = new RealtimeService(createPrisma({ users: { [USER_ID]: { id: USER_ID, role: Role.CLIENT } } }));
    const valid = signedToken();

    delete process.env.JWT_SECRET;
    await expect(service.authenticate(valid)).resolves.toBeNull();
    process.env.JWT_SECRET = SECRET;
    await expect(service.authenticate('not-a-jwt')).resolves.toBeNull();
    const parts = valid.split('.');
    const signature = parts[2]!;
    parts[2] = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    expect(Buffer.from(parts[2], 'base64url')).not.toEqual(Buffer.from(signature, 'base64url'));
    await expect(service.authenticate(parts.join('.'))).resolves.toBeNull();
    await expect(service.authenticate(signedToken(USER_ID, Role.CLIENT, 1))).resolves.toBeNull();

    const deletedUserService = new RealtimeService(createPrisma());
    await expect(deletedUserService.authenticate(valid)).resolves.toBeNull();
  });

  it('uses the current database role rather than the role claim in the JWT', async () => {
    const service = new RealtimeService(createPrisma({
      users: { [USER_ID]: { id: USER_ID, role: Role.CLIENT } },
    }));

    await expect(service.authenticate(signedToken(USER_ID, Role.ADMIN))).resolves.toEqual({
      userId: USER_ID,
      role: Role.CLIENT,
    });
    await expect(service.canSubscribe(
      { userId: USER_ID, role: Role.CLIENT },
      { resource: 'incidents' },
    )).resolves.toBe(false);
  });

  it('authorizes only the order owner, current assigned driver, or ADMIN', async () => {
    const prisma = createPrisma({
      orders: { [ORDER_ID]: { id: ORDER_ID, userId: USER_ID, routeId: ROUTE_ID } },
      routes: { [ROUTE_ID]: { id: ROUTE_ID, driverId: DRIVER_ID } },
      drivers: { [DRIVER_ID]: { id: DRIVER_ID, userId: OTHER_USER_ID } },
    });
    const service = new RealtimeService(prisma);

    await expect(service.canSubscribe(
      { userId: USER_ID, role: Role.CLIENT },
      { resource: 'order', id: ORDER_ID },
    )).resolves.toBe(true);
    await expect(service.canSubscribe(
      { userId: OTHER_USER_ID, role: Role.CLIENT },
      { resource: 'order', id: ORDER_ID },
    )).resolves.toBe(false);
    await expect(service.canSubscribe(
      { userId: OTHER_USER_ID, role: Role.DRIVER },
      { resource: 'order', id: ORDER_ID },
    )).resolves.toBe(true);
    await expect(service.canSubscribe(
      { userId: OTHER_USER_ID, role: Role.ADMIN },
      { resource: 'order', id: ORDER_ID },
    )).resolves.toBe(true);
  });

  it('restricts route, driver and incidents subscriptions to their current scoped audience', async () => {
    const service = new RealtimeService(createPrisma({
      routes: { [ROUTE_ID]: { id: ROUTE_ID, driverId: DRIVER_ID } },
      drivers: { [DRIVER_ID]: { id: DRIVER_ID, userId: USER_ID } },
    }));

    await expect(service.canSubscribe(
      { userId: USER_ID, role: Role.DRIVER },
      { resource: 'route', id: ROUTE_ID },
    )).resolves.toBe(true);
    await expect(service.canSubscribe(
      { userId: OTHER_USER_ID, role: Role.DRIVER },
      { resource: 'route', id: ROUTE_ID },
    )).resolves.toBe(false);
    await expect(service.canSubscribe(
      { userId: USER_ID, role: Role.DRIVER },
      { resource: 'driver', id: DRIVER_ID },
    )).resolves.toBe(true);
    await expect(service.canSubscribe(
      { userId: OTHER_USER_ID, role: Role.DRIVER },
      { resource: 'driver', id: DRIVER_ID },
    )).resolves.toBe(false);
    await expect(service.canSubscribe(
      { userId: USER_ID, role: Role.CLIENT },
      { resource: 'incidents' },
    )).resolves.toBe(false);
    await expect(service.canSubscribe(
      { userId: OTHER_USER_ID, role: Role.ADMIN },
      { resource: 'incidents' },
    )).resolves.toBe(true);
  });

  it('disconnects a formerly assigned driver and publishes only allow-listed committed fields', async () => {
    const prisma = createPrisma({
      users: { [OTHER_USER_ID]: { id: OTHER_USER_ID, role: Role.DRIVER } },
      orders: { [ORDER_ID]: { id: ORDER_ID, userId: null, routeId: ROUTE_ID } },
      routes: { [ROUTE_ID]: { id: ROUTE_ID, driverId: DRIVER_ID } },
      drivers: { [DRIVER_ID]: { id: DRIVER_ID, userId: OTHER_USER_ID } },
    });
    const service = new RealtimeService(prisma);
    const socket = createSocket(signedToken(OTHER_USER_ID, Role.DRIVER), [`order:${ORDER_ID}`]);
    service.attach({ sockets: new Map([['driver-socket', socket]]) } as never);
    const extraFields = {
      type: 'order.status.updated' as const,
      orderId: ORDER_ID,
      status: 'IN_TRANSIT',
      requiresAdministrativeReview: false,
      recipientPhone: '+593000000000',
      privateNotes: 'must not cross the wire',
    } as RealtimeChange & Record<string, unknown>;

    await service.publish([extraFields]);

    expect(socket.emit).toHaveBeenCalledTimes(1);
    const [event, envelope] = socket.emit.mock.calls[0];
    expect(event).toBe('order.status.updated');
    expect(envelope).toEqual({
      version: 1,
      eventId: expect.any(String),
      occurredAt: expect.any(String),
      data: {
        orderId: ORDER_ID,
        status: 'IN_TRANSIT',
        requiresAdministrativeReview: false,
      },
    });
    expect(Object.keys(envelope.data)).toEqual([
      'orderId',
      'status',
      'requiresAdministrativeReview',
    ]);
  });

  it('denies reassigned drivers and current role changes before emitting', async () => {
    const prisma = createPrisma({
      users: { [USER_ID]: { id: USER_ID, role: Role.DRIVER } },
      orders: { [ORDER_ID]: { id: ORDER_ID, userId: null, routeId: ROUTE_ID } },
      routes: { [ROUTE_ID]: { id: ROUTE_ID, driverId: DRIVER_ID } },
      drivers: { [DRIVER_ID]: { id: DRIVER_ID, userId: OTHER_USER_ID } },
    });
    const service = new RealtimeService(prisma);
    const reassignedSocket = createSocket(signedToken(USER_ID, Role.ADMIN), [`order:${ORDER_ID}`]);
    const revokedSocket = createSocket(signedToken(USER_ID, Role.ADMIN), ['incidents:admin']);
    service.attach({ sockets: new Map([
      ['reassigned', reassignedSocket],
      ['revoked', revokedSocket],
    ]) } as never);

    await service.publish([
      { type: 'order.status.updated', orderId: ORDER_ID, status: 'IN_TRANSIT' },
      { type: 'dispatch.incident.updated', orderId: ORDER_ID, action: 'CONTACT' },
    ]);

    expect(reassignedSocket.emit).not.toHaveBeenCalled();
    expect(reassignedSocket.disconnect).toHaveBeenCalledWith(true);
    expect(revokedSocket.emit).not.toHaveBeenCalled();
    expect(revokedSocket.disconnect).toHaveBeenCalledWith(true);
  });

  it('publishes route and driver changes only to ADMIN and the currently assigned DRIVER rooms', async () => {
    const service = new RealtimeService(createPrisma({
      users: {
        [USER_ID]: { id: USER_ID, role: Role.DRIVER },
        [OTHER_USER_ID]: { id: OTHER_USER_ID, role: Role.ADMIN },
      },
      routes: { [ROUTE_ID]: { id: ROUTE_ID, driverId: DRIVER_ID } },
      drivers: { [DRIVER_ID]: { id: DRIVER_ID, userId: USER_ID } },
    }));
    const routeDriver = createSocket(signedToken(USER_ID, Role.DRIVER), [`route:${ROUTE_ID}`]);
    const driverSelf = createSocket(signedToken(USER_ID, Role.DRIVER), [`driver:${DRIVER_ID}`]);
    const driverAdmin = createSocket(signedToken(OTHER_USER_ID, Role.ADMIN), [`driver:${DRIVER_ID}`]);
    service.attach({ sockets: new Map([
      ['route-driver', routeDriver],
      ['driver-self', driverSelf],
      ['driver-admin', driverAdmin],
    ]) } as never);

    await service.publish([
      { type: 'route.updated', routeId: ROUTE_ID, status: 'IN_PROGRESS' },
      { type: 'driver.availability.updated', driverId: DRIVER_ID, available: true },
    ]);

    expect(routeDriver.emit.mock.calls[0]?.[0]).toBe('route.updated');
    expect(driverSelf.emit.mock.calls[0]?.[0]).toBe('driver.availability.updated');
    expect(driverAdmin.emit.mock.calls[0]?.[0]).toBe('driver.availability.updated');
    expect(routeDriver.emit).toHaveBeenCalledTimes(1);
    expect(driverSelf.emit).toHaveBeenCalledTimes(1);
    expect(driverAdmin.emit).toHaveBeenCalledTimes(1);
  });

  it('swallows namespace delivery failures after persistence', async () => {
    const service = new RealtimeService(createPrisma({
      users: { [USER_ID]: { id: USER_ID, role: Role.CLIENT } },
      orders: { [ORDER_ID]: { id: ORDER_ID, userId: USER_ID, routeId: null } },
    }));
    const socket = createSocket(signedToken(), [`order:${ORDER_ID}`]);
    socket.emit.mockImplementation(() => { throw new Error('private transport details'); });
    service.attach({ sockets: new Map([['client-socket', socket]]) } as never);

    await expect(service.publish([
      { type: 'order.status.updated', orderId: ORDER_ID, status: 'DELIVERED' },
    ])).resolves.toBeUndefined();
    expect(socket.emit).toHaveBeenCalledTimes(1);
  });
});
