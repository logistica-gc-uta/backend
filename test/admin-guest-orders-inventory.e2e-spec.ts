import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AdminOrdersDatabase } from './admin-guest-orders-migration.fixtures';
import { actors, guestBody, prepareOwnedApiDatabase } from './admin-guest-orders-api.fixtures';
import { installRollbackEvidence, session, waitForProductWaiters, InventorySession } from './admin-guest-orders-inventory.fixtures';

if (process.env.DATABASE_URL) throw new Error('Refusing inherited DATABASE_URL before app imports');

describe('Unit C inventory HTTP (owned PostgreSQL 16)', () => {
  const database = new AdminOrdersDatabase();
  let app: INestApplication;
  let jwt: JwtService;
  let observer: InventorySession;
  const token = (actor: keyof typeof actors) => jwt.sign({ sub: actors[actor], role: 'ADMIN' });
  type Kind = 'CLIENT' | 'GUEST' | 'REGISTERED_CLIENT';
  const body = (kind: Kind, items = [{ productId: 'b-product', quantity: 1 }]) => {
    const result = { ...guestBody(), items };
    if (kind === 'REGISTERED_CLIENT') return { ...result, recipient: { type: kind, clientId: actors.client } };
    if (kind === 'CLIENT') { const { recipient: _omit, ...client } = result; return client; }
    return result;
  };
  const post = (kind: Kind, payload: unknown = body(kind)) => request(app.getHttpServer())
    .post(`/api/v1/orders${kind === 'CLIENT' ? '' : '/admin'}`)
    .auth(token(kind === 'CLIENT' ? 'client' : 'admin'), { type: 'bearer' }).set('Content-Type', 'application/json').send(JSON.stringify(payload)).timeout(12000);
  const stock = () => database.sql('unit_b', 'SELECT id || \':\' || stock FROM public.product ORDER BY id');
  const counts = () => database.sql('unit_b', 'SELECT (SELECT count(*) FROM public."order") || \':\' || (SELECT count(*) FROM public."orderItem")');

  beforeAll(async () => {
    jwt = new JwtService({ secret: prepareOwnedApiDatabase(database) });
    database.sql('unit_b', `INSERT INTO public.product (id,name,price,stock) VALUES ('c-second','Second',7,10)`);
    installRollbackEvidence(database);
    observer = await session(database, 'c-observer');
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
  beforeEach(() => database.sql('unit_b', `UPDATE public.product SET stock=10, price=CASE WHEN id='b-product' THEN 10 ELSE 7 END`));

  it.each(['CLIENT', 'GUEST', 'REGISTERED_CLIENT'] as const)('%s consolidates repeated products into one priced line', async (kind) => {
    const response = await post(kind, body(kind, [{ productId: 'b-product', quantity: 2 }, { productId: 'b-product', quantity: 3 }])).expect(201);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({ productId: 'b-product', quantity: 5, price: 10 });
    expect(response.body.total).toBe(50);
    expect(stock()).toBe('b-product:5\nc-second:10');
  });

  it.each(['CLIENT', 'GUEST', 'REGISTERED_CLIENT'] as const)('%s missing/insufficient product rolls back every effect', async (kind) => {
    for (const productId of ['c-second', 'missing']) {
      database.sql('unit_b', `UPDATE public.product SET stock=0 WHERE id='c-second'`);
      const beforeStock = stock(); const beforeCounts = counts();
      const response = await post(kind, body(kind, [{ productId: 'b-product', quantity: 1 }, { productId, quantity: 1 }]));
      expect(response.status).toBe(productId === 'missing' ? 404 : 400);
      expect(JSON.stringify(response.body)).not.toMatch(/Guest Name|593|private-hash|Profile client/);
      expect(stock()).toBe(beforeStock); expect(counts()).toBe(beforeCounts);
    }
  });

  it.each(['CLIENT', 'GUEST', 'REGISTERED_CLIENT'] as const)('%s rejects bounded aggregate overflow without writes', async (kind) => {
    const beforeStock = stock(); const beforeCounts = counts();
    await post(kind, body(kind, [{ productId: 'b-product', quantity: 2147483647 }, { productId: 'b-product', quantity: 1 }])).expect(400);
    expect(stock()).toBe(beforeStock); expect(counts()).toBe(beforeCounts);
  });

  it('multiproduct insufficiency rolls back an already executed first reservation', async () => {
    database.sql('unit_b', `UPDATE public.product SET stock=0 WHERE id='c-second'`);
    const beforeStock = stock(); const beforeCounts = counts();
    const beforeWrites = Number(database.sql('unit_b', 'SELECT last_value FROM inventory_evidence.stock_writes'));
    await post('GUEST', body('GUEST', [{ productId: 'b-product', quantity: 2 }, { productId: 'c-second', quantity: 1 }])).expect(400);
    expect(Number(database.sql('unit_b', 'SELECT last_value FROM inventory_evidence.stock_writes'))).toBeGreaterThan(beforeWrites);
    expect(stock()).toBe(beforeStock); expect(counts()).toBe(beforeCounts);
  });

  it.each([1, 2])('locked overlap with stock %i uses current stock/price and never loses reservations', async (available) => {
    const blocker = await session(database, 'c-blocker');
    const pending: Array<Promise<request.Response>> = [];
    const beforeCounts = counts().split(':').map(Number);
    try {
      await blocker.query('BEGIN');
      await blocker.query("SELECT id FROM public.product WHERE id='b-product' FOR UPDATE");
      pending.push(post('CLIENT').then((r) => r), post('GUEST').then((r) => r));
      await waitForProductWaiters(observer, 2);
      // Prior stock=10 and price=10 are intentionally invalidated while requests wait.
      await blocker.query("UPDATE public.product SET stock=$1, price=23 WHERE id='b-product'", [available]);
      await blocker.query('COMMIT');
      const responses = await Promise.all(pending);
      expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual(available === 1 ? [201, 400] : [201, 201]);
      for (const response of responses.filter((r) => r.status === 201)) {
        expect(response.body.total).toBe(23); expect(response.body.items[0].price).toBe(23);
      }
      expect(stock()).toBe('b-product:0\nc-second:10');
      expect(counts()).toBe(`${beforeCounts[0] + available}:${beforeCounts[1] + available}`);
    } finally {
      await blocker.query('ROLLBACK'); await Promise.allSettled(pending); await blocker.end();
    }
  }, 30000);

  it('opposite input order completes with deterministic first product lock', async () => {
    const blocker = await session(database, 'c-opposite-blocker');
    const pending: Array<Promise<request.Response>> = [];
    try {
      await blocker.query('BEGIN'); await blocker.query("SELECT id FROM public.product WHERE id='b-product' FOR UPDATE");
      pending.push(post('REGISTERED_CLIENT', body('REGISTERED_CLIENT', [{ productId: 'c-second', quantity: 2 }, { productId: 'b-product', quantity: 1 }])).then((r) => r));
      pending.push(post('CLIENT', body('CLIENT', [{ productId: 'b-product', quantity: 1 }, { productId: 'c-second', quantity: 2 }])).then((r) => r));
      await waitForProductWaiters(observer, 2);
      // Neither request may lock c-second before b-product (NOWAIT is deterministic).
      await blocker.query("SELECT id FROM public.product WHERE id='c-second' FOR UPDATE NOWAIT");
      await blocker.query('COMMIT');
      expect((await Promise.all(pending)).map((r) => r.status)).toEqual([201, 201]);
      expect(stock()).toBe('b-product:8\nc-second:6');
    } finally { await blocker.query('ROLLBACK'); await Promise.allSettled(pending); await blocker.end(); }
  }, 30000);

  it.each(['order', 'line'])('real %s insert failure after stock UPDATE rolls back stock/order/items', async (stage) => {
    const beforeStock = stock(); const beforeCounts = counts();
    const beforeWrites = Number(database.sql('unit_b', 'SELECT last_value FROM inventory_evidence.stock_writes'));
    const response = await post('GUEST', { ...body('GUEST'), deliveryAddress: `c-fail-${stage}` }).expect(500);
    expect(JSON.stringify(response.body)).not.toMatch(/owned .* failure|Guest Name|593|private-hash/);
    expect(Number(database.sql('unit_b', 'SELECT last_value FROM inventory_evidence.stock_writes'))).toBeGreaterThan(beforeWrites);
    expect(stock()).toBe(beforeStock); expect(counts()).toBe(beforeCounts);
  });

  it('ADMIN absolute stock rejects negative/fractional/overflow and missing product', async () => {
    for (const value of [-1, 1.5, 2147483648]) {
      await request(app.getHttpServer()).patch('/api/v1/products/b-product/stock').auth(token('admin'), { type: 'bearer' }).send({ stock: value }).expect(400);
    }
    await request(app.getHttpServer()).patch('/api/v1/products/missing/stock').auth(token('admin'), { type: 'bearer' }).send({ stock: 5 }).expect(404);
  });

  it('ADMIN absolute-set after a reservation intentionally replaces the resulting stock', async () => {
    const blocker = await session(database, 'c-later-stock-blocker');
    const pending: Array<Promise<request.Response>> = [];
    try {
      await blocker.query('BEGIN'); await blocker.query("SELECT id FROM public.product WHERE id='b-product' FOR UPDATE");
      pending.push(post('CLIENT').then((r) => r)); await waitForProductWaiters(observer, 1);
      pending.push(request(app.getHttpServer()).patch('/api/v1/products/b-product/stock').auth(token('admin'), { type: 'bearer' }).send({ stock: 5 }).timeout(12000).then((r) => r));
      await waitForProductWaiters(observer, 2); await blocker.query('COMMIT');
      expect((await Promise.all(pending)).map((r) => r.status)).toEqual([201, 200]);
      expect(stock()).toBe('b-product:5\nc-second:10');
    } finally { await blocker.query('ROLLBACK'); await Promise.allSettled(pending); await blocker.end(); }
  }, 30000);

  it('concurrent ADMIN absolute-set serializes before a waiting reservation', async () => {
    const blocker = await session(database, 'c-stock-blocker');
    const pending: Array<Promise<request.Response>> = [];
    try {
      await blocker.query('BEGIN'); await blocker.query("SELECT id FROM public.product WHERE id='b-product' FOR UPDATE");
      pending.push(request(app.getHttpServer()).patch('/api/v1/products/b-product/stock').auth(token('admin'), { type: 'bearer' }).send({ stock: 5 }).timeout(12000).then((r) => r));
      await waitForProductWaiters(observer, 1);
      pending.push(post('GUEST').then((r) => r)); await waitForProductWaiters(observer, 2);
      await blocker.query('COMMIT');
      expect((await Promise.all(pending)).map((r) => r.status)).toEqual([200, 201]);
      expect(stock()).toBe('b-product:4\nc-second:10');
    } finally { await blocker.query('ROLLBACK'); await Promise.allSettled(pending); await blocker.end(); }
  }, 30000);
});
