import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AdminOrdersDatabase } from './admin-guest-orders-migration.fixtures';
import { actors, guestBody, prepareOwnedApiDatabase, calendar } from './admin-guest-orders-api.fixtures';
import { session, waitForProductWaiters, InventorySession } from './admin-guest-orders-inventory.fixtures';
import { futureDeadline, installDeliveryBarrier, waitForDeadline, waitForItemBarrier } from './admin-guest-orders-delivery.fixtures';

if (process.env.DATABASE_URL) throw new Error('Refusing inherited DATABASE_URL before app imports');

describe('Unit D delivery HTTP (owned PostgreSQL 16, advancing database clock)', () => {
  const database = new AdminOrdersDatabase();
  let app: INestApplication;
  let jwt: JwtService;
  let observer: InventorySession;
  type Kind = 'CLIENT' | 'GUEST' | 'REGISTERED_CLIENT';
  const kinds = ['CLIENT', 'GUEST', 'REGISTERED_CLIENT'] as const;
  const body = (kind: Kind) => {
    const result = guestBody();
    if (kind === 'REGISTERED_CLIENT') return { ...result, recipient: { type: kind, clientId: actors.client } };
    if (kind === 'CLIENT') { const { recipient: _omit, ...client } = result; return client; }
    return result;
  };
  const post = (kind: Kind, payload: unknown) => request(app.getHttpServer())
    .post(`/api/v1/orders${kind === 'CLIENT' ? '' : '/admin'}`)
    .auth(jwt.sign({ sub: actors[kind === 'CLIENT' ? 'client' : 'admin'], role: 'ADMIN' }), { type: 'bearer' })
    .set('Content-Type', 'application/json').send(JSON.stringify(payload)).timeout(12000);
  const state = () => database.sql('unit_b', `SELECT (SELECT stock FROM public.product WHERE id='b-product') || ':' ||
    (SELECT count(*) FROM public."order") || ':' || (SELECT count(*) FROM public."orderItem")`);
  const sequence = (name: 'stock' | 'item') => Number(database.sql('unit_b', `SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM delivery_evidence.${name}_writes`));
  const privateError = (response: request.Response) => expect(JSON.stringify(response.body)).not.toMatch(/Guest Name|593|Profile client|private-hash/);

  beforeAll(async () => {
    jwt = new JwtService({ secret: prepareOwnedApiDatabase(database) });
    database.sql('unit_b', `INSERT INTO public.product (id,name,price,stock) VALUES ('d-second','Second',7,10)`);
    installDeliveryBarrier(database);
    observer = await session(database, 'd-observer');
    const { AppModule } = await import('../src/app.module.js');
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  }, 180000);
  afterAll(async () => {
    try { if (observer) await observer.end(); if (app) await app.close(); }
    finally { delete process.env.DATABASE_URL; delete process.env.JWT_SECRET; database.stop(); }
  });

  it.each(kinds)('%s accepts a DB-future deadline despite an ahead application Date', async (kind) => {
    const result = await observer.query(`SELECT
      to_char((clock_timestamp() + interval '1 day') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deadline,
      floor(extract(epoch FROM clock_timestamp() + interval '2 days') * 1000)::float8 AS app_now`);
    const payload = { ...body(kind), scheduledDeliveryDate: result.rows[0].deadline };
    // Construct JWT/request and helper dates before clock control. Only the
    // zero-argument Date constructor is skewed; Date.now (JWT/timers) is real.
    const pending = post(kind, payload);
    const RealDate = Date;
    const dateSpy = jest.spyOn(globalThis, 'Date').mockImplementation(function (...args: ConstructorParameters<DateConstructor>): Date {
      return Reflect.construct(RealDate, args.length ? args : [result.rows[0].app_now]);
    });
    Object.assign(dateSpy, { now: RealDate.now, parse: RealDate.parse, UTC: RealDate.UTC, prototype: RealDate.prototype });
    try {
      const response = await pending;
      expect(response.status).toBe(201);
      expect(response.body.scheduledDeliveryDate).toBe(Temporal.Instant.from(payload.scheduledDeliveryDate).toString());
    } finally { dateSpy.mockRestore(); }
  });

  it.each(kinds)('%s rejects a DB-expired deadline despite a behind application Date', async (kind) => {
    const result = await observer.query(`SELECT
      to_char((clock_timestamp() - interval '1 day') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deadline,
      floor(extract(epoch FROM clock_timestamp() - interval '2 days') * 1000)::float8 AS app_now`);
    const before = state(); const writes = sequence('stock');
    const pending = post(kind, { ...body(kind), scheduledDeliveryDate: result.rows[0].deadline });
    const RealDate = Date;
    const dateSpy = jest.spyOn(globalThis, 'Date').mockImplementation(function (...args: ConstructorParameters<DateConstructor>): Date {
      return Reflect.construct(RealDate, args.length ? args : [result.rows[0].app_now]);
    });
    Object.assign(dateSpy, { now: RealDate.now, parse: RealDate.parse, UTC: RealDate.UTC, prototype: RealDate.prototype });
    try {
      const response = await pending;
      expect(response.status).toBe(400); privateError(response);
      expect(state()).toBe(before); expect(sequence('stock')).toBe(writes);
    } finally { dateSpy.mockRestore(); }
  });

  it.each(kinds)('%s rejects past schedules without writes or private errors', async (kind) => {
    const before = state();
    const response = await post(kind, { ...body(kind), scheduledDeliveryDate: '2000-01-01T15:00:00Z' });
    expect(response.status).toBe(400); privateError(response); expect(state()).toBe(before);
  });

  it.each(kinds)('%s accepts future explicit offsets and absent window', async (kind) => {
    const response = await post(kind, { ...body(kind), scheduledDeliveryDate: calendar('2030-02-14T10:00:00-05:00') }).expect(201);
    expect(response.body.scheduledDeliveryDate).toBe(calendar('2030-02-14T15:00:00Z'));
    expect(response.body.deliveryWindowStart).toBeNull();
    expect(response.body.createdAt).not.toBe(response.body.scheduledDeliveryDate);
  });

  it('CLIENT omitted date remains compatible and ADMIN date remains required', async () => {
    const { scheduledDeliveryDate: _omit, ...payload } = body('CLIENT');
    const response = await post('CLIENT', payload).expect(201);
    expect(response.body.scheduledDeliveryDate).toBeNull();
    await post('GUEST', { ...body('GUEST'), scheduledDeliveryDate: undefined }).expect(400);
  });

  it.each(['GUEST', 'REGISTERED_CLIENT'] as const)('%s accepts inclusive mixed-offset window on one Guayaquil day', async (kind) => {
    const response = await post(kind, { ...body(kind), scheduledDeliveryDate: calendar('2030-02-15T01:00:00Z'),
      deliveryWindowStart: calendar('2030-02-14T20:00:00-05:00'), deliveryWindowEnd: calendar('2030-02-15T03:00:00Z') }).expect(201);
    expect(response.body.deliveryWindowStart).toBe(calendar('2030-02-15T01:00:00Z'));
    const result = await request(app.getHttpServer()).get(calendar('/api/v1/orders?date=2030-02-14'))
      .auth(jwt.sign({ sub: actors.admin }), { type: 'bearer' }).expect(200);
    expect(result.body.items.some((order: { id: string }) => order.id === response.body.id)).toBe(true);
  });

  it.each([calendar('2030-02-30T15:00:00Z'), calendar('2030-02-14T15:00:00'), calendar('2030-02-14'), calendar('2030-02-14T15:00:00+25:00'), null])('CLIENT rejects invalid supplied schedule %s', async (date) => {
    const before = state();
    await post('CLIENT', { ...body('CLIENT'), scheduledDeliveryDate: date }).expect(400);
    expect(state()).toBe(before);
  });

  it.each([
    { deliveryWindowStart: calendar('2030-02-15T01:00:00Z') },
    { deliveryWindowEnd: calendar('2030-02-15T03:00:00Z') },
    { deliveryWindowStart: calendar('2030-02-15T03:00:00Z'), deliveryWindowEnd: calendar('2030-02-15T01:00:00Z') },
    { deliveryWindowStart: calendar('2030-02-15T02:00:00Z'), deliveryWindowEnd: calendar('2030-02-15T03:00:00Z') },
    { deliveryWindowStart: calendar('2030-02-15T01:00:00Z'), deliveryWindowEnd: calendar('2030-02-15T05:00:00Z') },
    { deliveryWindowStart: '2000-01-01T15:00:00Z', deliveryWindowEnd: '2000-01-01T17:00:00Z', scheduledDeliveryDate: '2000-01-01T16:00:00Z' },
  ])('rejects inconsistent or past ADMIN window %# with no effects', async (window) => {
    const before = state();
    await post('GUEST', { ...body('GUEST'), scheduledDeliveryDate: calendar('2030-02-15T01:00:00Z'), ...window }).expect(400);
    expect(state()).toBe(before);
  });

  it('expiration on a later product lock rolls back an earlier reservation', async () => {
    const blocker = await session(database, 'd-later-product-blocker');
    let pending: Promise<request.Response> | undefined;
    const before = state(); const writes = sequence('stock');
    const secondStock = database.sql('unit_b', "SELECT stock FROM public.product WHERE id='d-second'");
    try {
      await blocker.query('BEGIN'); await blocker.query("SELECT id FROM public.product WHERE id='d-second' FOR UPDATE");
      const deadline = await futureDeadline(observer);
      pending = post('GUEST', { ...body('GUEST'), scheduledDeliveryDate: deadline,
        items: [{ productId: 'd-second', quantity: 1 }, { productId: 'b-product', quantity: 1 }] }).then((r) => r);
      await waitForProductWaiters(observer, 1);
      expect(sequence('stock')).toBeGreaterThan(writes);
      await waitForDeadline(observer, deadline); await blocker.query('COMMIT');
      expect((await pending).status).toBe(400);
      expect(state()).toBe(before);
      expect(database.sql('unit_b', "SELECT stock FROM public.product WHERE id='d-second'")).toBe(secondStock);
    } finally { await blocker.query('ROLLBACK'); if (pending) await Promise.allSettled([pending]); await blocker.end(); }
  }, 30000);

  it.each(kinds)('%s expires while waiting on a real product lock', async (kind) => {
    const blocker = await session(database, 'd-product-blocker');
    let pending: Promise<request.Response> | undefined;
    const before = state(); const beforeWrites = sequence('stock');
    try {
      await blocker.query('BEGIN'); await blocker.query("SELECT id FROM public.product WHERE id='b-product' FOR UPDATE");
      const deadline = await futureDeadline(observer);
      pending = post(kind, { ...body(kind), scheduledDeliveryDate: deadline }).then((r) => r);
      await waitForProductWaiters(observer, 1);
      await waitForDeadline(observer, deadline);
      await blocker.query('COMMIT');
      const response = await pending;
      expect(response.status).toBe(400); privateError(response);
      expect(state()).toBe(before); expect(sequence('stock')).toBe(beforeWrites);
    } finally { await blocker.query('ROLLBACK'); if (pending) await Promise.allSettled([pending]); await blocker.end(); }
  }, 30000);

  it.each(kinds)('%s final deadline failure rolls back actual stock/order/item writes', async (kind) => {
    const blocker = await session(database, 'd-item-blocker');
    let pending: Promise<request.Response> | undefined;
    const before = state(); const stockWrites = sequence('stock'); const itemWrites = sequence('item');
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock(110011)');
      const deadline = await futureDeadline(observer);
      pending = post(kind, { ...body(kind), deliveryAddress: 'd-final-barrier', scheduledDeliveryDate: deadline }).then((r) => r);
      await waitForItemBarrier(observer);
      await waitForDeadline(observer, deadline);
      await blocker.query('COMMIT');
      const response = await pending;
      expect(response.status).toBe(400); privateError(response);
      expect(sequence('stock')).toBeGreaterThan(stockWrites); expect(sequence('item')).toBeGreaterThan(itemWrites);
      expect(state()).toBe(before);
    } finally { await blocker.query('ROLLBACK'); if (pending) await Promise.allSettled([pending]); await blocker.end(); }
  }, 30000);
});
