import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { AdminOrdersDatabase } from './admin-guest-orders-migration.fixtures';
import { randomUUID } from 'node:crypto';
import { actors, guestBody, prepareOwnedApiDatabase, calendar } from './admin-guest-orders-api.fixtures';

// This module has no static application/Prisma imports. Refuse ambient URLs first.
if (process.env.DATABASE_URL) throw new Error('Refusing inherited DATABASE_URL before app imports');

describe('Unit B administrative orders HTTP (owned PostgreSQL 16)', () => {
  const database = new AdminOrdersDatabase();
  let app: INestApplication;
  let jwt: JwtService;
  let registeredId: string;
  let guestId: string;
  const token = (actor: keyof typeof actors) => jwt.sign({ sub: actors[actor], role: 'ADMIN' });
  const post = (body: unknown, actor: keyof typeof actors = 'admin', key = randomUUID()) =>
    request(app.getHttpServer()).post('/api/v1/orders/admin').auth(token(actor), { type: 'bearer' }).set('Content-Type', 'application/json').set('Idempotency-Key', key).send(JSON.stringify(body));
  const get = (path: string, actor: keyof typeof actors = 'admin') =>
    request(app.getHttpServer()).get(`/api/v1/orders${path}`).auth(token(actor), { type: 'bearer' });
  const patchStatus = (id: string, body: unknown, actor: keyof typeof actors = 'admin') =>
    request(app.getHttpServer()).patch(`/api/v1/orders/${id}/status`).auth(token(actor), { type: 'bearer' }).set('Content-Type', 'application/json').send(JSON.stringify(body));
  const confirmRoute = (body: unknown) =>
    request(app.getHttpServer()).post('/api/v1/routes').auth(token('admin'), { type: 'bearer' }).set('Content-Type', 'application/json').send(JSON.stringify(body));

  beforeAll(async () => {
    const secret = prepareOwnedApiDatabase(database);
    jwt = new JwtService({ secret });
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  }, 180000);
  afterAll(async () => {
    try { if (app) await app.close(); }
    finally { delete process.env.DATABASE_URL; delete process.env.JWT_SECRET; database.stop(); }
  });

  it('creates a registered recipient with real owner/creator and database snapshot', async () => {
    const response = await post({ ...guestBody(), buyer: { type: 'REGISTERED_CLIENT', clientId: actors.client, contactPhone: ' +593 999 ' } }).expect(201);
    registeredId = response.body.id;
    expect(response.body).toMatchObject({ userId: actors.client, createdById: actors.admin, recipientType: 'REGISTERED_CLIENT', recipientName: 'Profile client', recipientPhone: '+593 999', status: 'PENDING' });
    expect(database.sql('unit_b', `SELECT "userId" || ':' || "createdById" || ':' || "recipientName" FROM public."order" WHERE id='${registeredId}'`)).toBe('b-client:b-admin:Profile client');
    database.sql('unit_b', `UPDATE public."user" SET name='Changed profile' WHERE id='b-client'`);
    expect((await get(`/${registeredId}`).expect(200)).body.recipientName).toBe('Profile client');
  });

  it('creates guest metadata without creating any authenticable user', async () => {
    const count = database.sql('unit_b', 'SELECT count(*) FROM public."user"');
    const response = await post(guestBody(), 'admin2').expect(201);
    guestId = response.body.id;
    expect(response.body).toMatchObject({ userId: null, createdById: actors.admin2, recipientType: 'GUEST', recipientName: 'Guest Name', recipientPhone: '+593 99 123 4567' });
    expect(database.sql('unit_b', 'SELECT count(*) FROM public."user"')).toBe(count);
    expect(database.sql('unit_b', `SELECT "recipientPhone" FROM public."order" WHERE id='${guestId}'`)).toBe('+593 99 123 4567');
    expect(response.body.items).toHaveLength(1);
  });

  it('requires JWT and database ADMIN role, ignoring spoofed JWT role', async () => {
    await request(app.getHttpServer()).post('/api/v1/orders/admin').send(guestBody()).expect(401);
    for (const actor of ['client', 'driver'] as const) await post(guestBody(), actor).expect(403);
  });

  it.each([
    ['unknown', { type: 'UNKNOWN', name: 'Name', contactPhone: '123' }],
    ['missing discriminator', { name: 'Name', contactPhone: '123' }],
    ['registered null phone', { type: 'REGISTERED_CLIENT', clientId: actors.client, contactPhone: null }],
    ['registered extra actor', { type: 'REGISTERED_CLIENT', clientId: actors.client, createdById: actors.admin }],
    ['mixed guest', { type: 'GUEST', name: 'Name', contactPhone: '123', clientId: actors.client }],
    ['mixed registered', { type: 'REGISTERED_CLIENT', clientId: actors.client, name: 'Spoof' }],
    ['extra role', { type: 'GUEST', name: 'Name', contactPhone: '123', role: 'ADMIN' }],
    ['arbitrary unknown key', { type: 'GUEST', name: 'Name', contactPhone: '123', unexpectedRecipientKey: 'rejected' }],
    ['empty name', { type: 'GUEST', name: '   ', contactPhone: '123' }],
    ['long name', { type: 'GUEST', name: 'x'.repeat(121), contactPhone: '123' }],
    ['missing phone', { type: 'GUEST', name: 'Name' }],
    ['blank phone', { type: 'GUEST', name: 'Name', contactPhone: '   ' }],
    ['long phone', { type: 'GUEST', name: 'Name', contactPhone: '1'.repeat(41) }],
    ['null', null],
    ['array', [{ type: 'GUEST', name: 'Name', contactPhone: '123' }]],
  ])('rejects invalid buyer %s with 400', async (_name, buyer) => {
    await post({ ...guestBody(), buyer }).expect(400);
  });

  it.each(['createdById', 'userId', 'role', 'clientId'])('rejects actor/owner injection %s', async (key) => {
    await post({ ...guestBody(), [key]: actors.admin }).expect(400);
    const { buyer: _b, payment: _p, ...legacy } = guestBody();
    await request(app.getHttpServer()).post('/api/v1/orders').auth(token('client'), { type: 'bearer' }).send({ ...legacy, [key]: actors.admin }).expect(400);
  });

  it('rejects additional nested item fields and CLIENT recipient injection', async () => {
    await post({ ...guestBody(), items: [{ productId: 'b-product', quantity: 1, price: 0 }] }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/orders').auth(token('client'), { type: 'bearer' }).send(guestBody()).expect(400);
  });

  it.each([['admin', actors.admin, 400], ['driver', actors.driver, 400]])('rejects registered owner %s', async (_name, clientId, status) => {
    await post({ ...guestBody(), buyer: { type: 'REGISTERED_CLIENT', clientId, contactPhone: '+593 999' } }).expect(status as number);
  });

  it('keeps Nest 404 for a missing registered client and does not create an order or debit stock', async () => {
    const count = database.sql('unit_b', 'SELECT count(*) FROM public."order"');
    const stock = database.sql('unit_b', 'SELECT stock FROM public.product');
    const missing = await post({
      ...guestBody(),
      buyer: { type: 'REGISTERED_CLIENT', clientId: 'missing-user', contactPhone: '+593 999' },
    }).expect(404);
    expect(missing.body).toEqual({
      statusCode: 404,
      message: 'Registered client not found',
      error: 'Not Found',
    });
    expect(database.sql('unit_b', 'SELECT count(*) FROM public."order"')).toBe(count);
    expect(database.sql('unit_b', 'SELECT stock FROM public.product')).toBe(stock);
  });

  it('keeps Nest 400 for insufficient stock with the specific product message and no writes', async () => {
    const count = database.sql('unit_b', 'SELECT count(*) FROM public."order"');
    const stock = Number(database.sql('unit_b', 'SELECT stock FROM public.product'));
    const quantity = stock + 1;
    const rejected = await post({
      ...guestBody(),
      items: [{ productId: 'b-product', quantity }],
    }).expect(400);
    expect(rejected.body).toEqual({
      statusCode: 400,
      message: `Stock insuficiente para el producto 'Product'. Solicitado: ${quantity}, Disponible: ${stock}`,
      error: 'Bad Request',
    });
    expect(database.sql('unit_b', 'SELECT count(*) FROM public."order"')).toBe(count);
    expect(database.sql('unit_b', 'SELECT stock FROM public.product')).toBe(String(stock));
  });

  it('rejects registered buyer without phone and retains CLIENT optional coordinates/date', async () => {
    const count = database.sql('unit_b', 'SELECT count(*) FROM public."order"');
    await post({ ...guestBody(), buyer: { type: 'REGISTERED_CLIENT', clientId: actors.foreign } }).expect(400);
    expect(database.sql('unit_b', 'SELECT count(*) FROM public."order"')).toBe(count);
    const response = await request(app.getHttpServer()).post('/api/v1/orders').auth(token('client'), { type: 'bearer' }).send({ zoneId: 'b-zone', deliveryAddress: 'Client address', items: [{ productId: 'b-product', quantity: 1 }] }).expect(201);
    expect(response.body).toMatchObject({ userId: actors.client, createdById: actors.client, recipientType: 'REGISTERED_CLIENT', recipientName: 'Changed profile', deliveryLat: null, deliveryLng: null });
    expect(response.body).not.toHaveProperty('recipientPhone');
  });

  it('preserves CLIENT IDOR and JWT-filtered my-orders without contact or user secrets', async () => {
    await get(`/${registeredId}`, 'foreign').expect(403);
    await get(`/${guestId}`, 'client').expect(403);
    const detail = await get(`/${registeredId}`, 'client').expect(200);
    expect(detail.body).not.toHaveProperty('recipientPhone');
    const mine = await get('/my-orders', 'client').expect(200);
    expect(mine.body.some((order: { id: string }) => order.id === registeredId)).toBe(true);
    for (const order of mine.body) {
      expect(order.userId).toBe(actors.client);
      expect(order).not.toHaveProperty('recipientPhone');
      expect(JSON.stringify(order)).not.toMatch(/private-hash|@example\.test|password/);
    }
  });

  it('limits DRIVER access and contact to assigned own route, including guest', async () => {
    await get(`/${guestId}`, 'driver').expect(403);
    database.sql('unit_b', `UPDATE public."order" SET "routeId"='b-route' WHERE id='${guestId}'`);
    const detail = await get(`/${guestId}`, 'driver').expect(200);
    expect(detail.body.recipientPhone).toBe('+593 99 123 4567');
    const denied = await get(`/${guestId}`, 'otherDriver').expect(403);
    expect(JSON.stringify(denied.body)).not.toMatch(/Guest Name|593/);
    expect(JSON.stringify(detail.body)).not.toMatch(/private-hash|@example\.test|password/);
  });

  it.each([
    ['missing coordinates', { deliveryLat: undefined, deliveryLng: undefined }, 400],
    ['partial coordinates', { deliveryLng: undefined }, 400],
    ['null coordinates', { deliveryLat: null, deliveryLng: null }, 400],
    ['range', { deliveryLat: 91 }, 400],
    ['missing date', { scheduledDeliveryDate: undefined }, 400],
    ['offsetless date', { scheduledDeliveryDate: calendar('2030-02-14T15:00:00') }, 400],
    ['one window endpoint', { deliveryWindowStart: calendar('2030-02-14T14:00:00Z') }, 400],
    ['inverted window', { deliveryWindowStart: calendar('2030-02-14T17:00:00Z'), deliveryWindowEnd: calendar('2030-02-14T14:00:00Z') }, 400],
    ['outside window', { deliveryWindowStart: calendar('2030-02-14T16:00:00Z'), deliveryWindowEnd: calendar('2030-02-14T17:00:00Z') }, 400],
    ['cross day', { deliveryWindowStart: calendar('2030-02-14T04:00:00Z'), deliveryWindowEnd: calendar('2030-02-14T17:00:00Z') }, 400],
    ['offsetless window', { deliveryWindowStart: calendar('2030-02-14T14:00:00'), deliveryWindowEnd: calendar('2030-02-14T17:00:00Z') }, 400],
  ])('rejects location/time %s without persistence', async (_name, patch, status) => {
    const count = database.sql('unit_b', 'SELECT count(*) FROM public."order"');
    const stock = database.sql('unit_b', 'SELECT stock FROM public.product');
    await post({ ...guestBody(), ...patch }).expect(status as number);
    expect(database.sql('unit_b', 'SELECT count(*) FROM public."order"')).toBe(count);
    expect(database.sql('unit_b', 'SELECT stock FROM public.product')).toBe(stock);
  });

  it('accepts explicit offsets and paired same-business-day inclusive windows', async () => {
    await post({ ...guestBody(), scheduledDeliveryDate: calendar('2030-02-14T10:00:00-05:00'), deliveryWindowStart: calendar('2030-02-14T10:00:00-05:00'), deliveryWindowEnd: calendar('2030-02-14T12:00:00-05:00') }).expect(201);
  });

  it('ADMIN accepts inclusive 07:00/17:00 Guayaquil and rejects 06:59/17:01 without writes', async () => {
    const count = database.sql('unit_b', 'SELECT count(*) FROM public."order"');
    const stock = database.sql('unit_b', 'SELECT stock FROM public.product');
    await post({ ...guestBody(), scheduledDeliveryDate: calendar('2030-02-14T07:00:00-05:00') }).expect(201);
    await post({ ...guestBody(), scheduledDeliveryDate: calendar('2030-02-14T17:00:00-05:00') }).expect(201);
    const tooEarly = await post({ ...guestBody(), scheduledDeliveryDate: calendar('2030-02-14T06:59:00-05:00') }).expect(422);
    expect(tooEarly.body.error).toMatchObject({
      code: 'DELIVERY_OUTSIDE_HOURS',
      message: 'Scheduled delivery time 06:59 is outside commercial delivery hours (07:00 - 17:00)',
    });
    expect(tooEarly.body.error.requestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    const tooLate = await post({ ...guestBody(), scheduledDeliveryDate: calendar('2030-02-14T17:01:00-05:00') }).expect(422);
    expect(tooLate.body.error.code).toBe('DELIVERY_OUTSIDE_HOURS');
    expect(Number(database.sql('unit_b', 'SELECT count(*) FROM public."order"'))).toBe(Number(count) + 2);
    expect(database.sql('unit_b', 'SELECT stock FROM public.product')).toBe(String(Number(stock) - 2));
  });

  it('ADMIN rejects an exterior point with 422 and no order or stock debit', async () => {
    const count = database.sql('unit_b', 'SELECT count(*) FROM public."order"');
    const stock = database.sql('unit_b', 'SELECT stock FROM public.product');
    const exterior = await post({ ...guestBody(), deliveryLat: 0, deliveryLng: 0 }).expect(422);
    expect(exterior.body.error).toMatchObject({
      code: 'DELIVERY_OUTSIDE_COVERAGE',
      message: 'Delivery point is outside the configured store coverage',
    });
    expect(exterior.body.error.requestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(database.sql('unit_b', 'SELECT count(*) FROM public."order"')).toBe(count);
    expect(database.sql('unit_b', 'SELECT stock FROM public.product')).toBe(stock);
  });

  it('paginates scheduled business-day filters with stable date/id order and safe user summaries', async () => {
    await post({ ...guestBody(), scheduledDeliveryDate: calendar('2030-02-14T22:00:00Z') }).expect(201);
    await post({ ...guestBody(), scheduledDeliveryDate: calendar('2030-02-15T12:00:00Z') }).expect(201);
    const response = await get(calendar('?date=2030-02-14&status=PENDING&pageSize=2')).expect(200);
    expect(response.body).toMatchObject({ page: 1, pageSize: 2, items: expect.any(Array), total: expect.any(Number) });
    const all = await get(calendar('?date=2030-02-14&status=PENDING&pageSize=100')).expect(200);
    expect(all.body.total).toBe(all.body.items.length);
    const keys = all.body.items.map((order: { scheduledDeliveryDate: string; id: string }) => `${order.scheduledDeliveryDate}:${order.id}`);
    expect(keys).toEqual([...keys].sort((a, b) => a < b ? -1 : a > b ? 1 : 0));
    expect(all.body.items.some((order: { scheduledDeliveryDate: string }) => order.scheduledDeliveryDate === calendar('2030-02-14T22:00:00Z'))).toBe(true);
    expect(all.body.items.some((order: { scheduledDeliveryDate: string }) => order.scheduledDeliveryDate === calendar('2030-02-15T12:00:00Z'))).toBe(false);
    const second = await get(calendar('?date=2030-02-14&status=PENDING&pageSize=2&page=2')).expect(200);
    expect(second.body.items.map((order: { id: string }) => order.id)).toEqual(all.body.items.slice(2, 4).map((order: { id: string }) => order.id));
    for (const order of all.body.items) if (order.user) expect(Object.keys(order.user).sort()).toEqual(['id', 'name']);
    expect(JSON.stringify(all.body)).not.toMatch(/private-hash|@example\.test|password/);
    await get('?zoneId=absent-zone').expect(200).expect(({ body }) => expect(body.total).toBe(0));
    await get('?status=DELIVERED').expect(200).expect(({ body }) => expect(body.total).toBe(0));
    await get('', 'client').expect(403);
  });

  it.each(['page=0', 'page=-1', 'page=1.2', 'pageSize=101', 'pageSize=0', 'page=99999999999999999999', 'date=2030-02-30', 'date=bad', 'status=bad', 'unknown=x'])('rejects invalid list filter %s', async (query) => {
    await get(`?${query}`).expect(400);
  });

  it('keeps legacy metadata null and orders unscheduled history last without exposing current profile contacts', async () => {
    database.sql('unit_b', `INSERT INTO public."order" (id,"userId","zoneId","deliveryAddress") VALUES ('b-history','b-client','b-zone','History')`);
    const historical = await get('/b-history').expect(200);
    expect(historical.body).toMatchObject({ userId: actors.client, createdById: null, recipientType: null, recipientName: null, recipientPhone: null, deliveryWindowStart: null, deliveryWindowEnd: null });
    const listing = await get('?pageSize=100').expect(200);
    const scheduled = listing.body.items.filter((order: { scheduledDeliveryDate: string | null }) => order.scheduledDeliveryDate !== null);
    expect(listing.body.items.slice(0, scheduled.length)).toEqual(scheduled);
    const client = await get('/b-history', 'client').expect(200);
    expect(client.body.recipientName).toBeNull();
    expect(client.body).not.toHaveProperty('recipientPhone');
    const missing = await get('/absent-order').expect(404);
    expect(missing.body).toEqual({
      statusCode: 404,
      message: "Pedido con ID 'absent-order' no encontrado",
      error: 'Not Found',
    });
  });

  it('keeps Nest 400/409 status bodies on order status writes, not Shop INTERNAL_ERROR', async () => {
    const assign = await patchStatus(registeredId, { status: 'ASSIGNED' }).expect(400);
    expect(assign.body).toEqual({
      statusCode: 400,
      message: 'La asignación de pedidos solo puede realizarse a través del endpoint de rutas',
      error: 'Bad Request',
    });
    expect(database.sql('unit_b', `SELECT status FROM public."order" WHERE id='${registeredId}'`)).toBe('PENDING');

    database.sql('unit_b', `UPDATE public."order" SET "routeId"='b-route' WHERE id='${guestId}'`);
    const conflict = await patchStatus(guestId, { status: 'IN_TRANSIT' }, 'driver').expect(409);
    expect(conflict.body).toEqual({
      statusCode: 409,
      message: 'Stable route stop required',
      error: 'Conflict',
    });
    expect(database.sql('unit_b', `SELECT status FROM public."order" WHERE id='${guestId}'`)).toBe('PENDING');
  });

  it('confirms a public route for a coverage order with null zoneId and rolls back a missing order', async () => {
    const { zoneId: _omit, ...coverageBody } = guestBody();
    const created = await post(coverageBody).expect(201);
    expect(created.body.zoneId).toBeNull();
    expect(database.sql('unit_b', `SELECT ("zoneId" IS NULL)::text FROM public."order" WHERE id='${created.body.id}'`)).toBe('true');

    const confirmed = await confirmRoute({
      zoneId: 'b-zone',
      orderIds: [created.body.id],
      routeDate: calendar('2030-02-14T15:00:00Z'),
    });
    expect(confirmed.status).toBe(201);
    expect(database.sql('unit_b', `SELECT ("zoneId" IS NULL)::text FROM public."order" WHERE id='${created.body.id}'`)).toBe('true');
    expect(database.sql('unit_b', `SELECT count(*) FROM public."routeStop" WHERE "orderId"='${created.body.id}'`)).toBe('1');

    const mismatched = await post({ ...guestBody(), zoneId: 'b-no-depot' }).expect(201);
    expect(mismatched.body.zoneId).toBe('b-no-depot');
    expect(database.sql('unit_b', `SELECT "zoneId" FROM public."order" WHERE id='${mismatched.body.id}'`)).toBe('b-no-depot');
    const rejected = await confirmRoute({
      zoneId: 'b-zone',
      orderIds: [mismatched.body.id],
      routeDate: calendar('2030-02-14T15:00:00Z'),
    });
    expect(rejected.status).toBe(409);
    expect(database.sql('unit_b', `SELECT count(*) FROM public."routeStop" WHERE "orderId"='${mismatched.body.id}'`)).toBe('0');

    const pending = await post(coverageBody).expect(201);
    const routesBefore = database.sql('unit_b', 'SELECT count(*) FROM public.route');
    const missingOrder = await confirmRoute({
      zoneId: 'b-zone',
      orderIds: [pending.body.id, '00000000-0000-4000-8000-000000000099'],
      routeDate: calendar('2030-02-14T15:00:00Z'),
    });
    expect(missingOrder.status).toBe(404);
    expect(database.sql('unit_b', 'SELECT count(*) FROM public.route')).toBe(routesBefore);
    expect(database.sql('unit_b', `SELECT count(*) FROM public."routeStop" WHERE "orderId"='${pending.body.id}'`)).toBe('0');
    expect(database.sql('unit_b', `SELECT ("zoneId" IS NULL)::text FROM public."order" WHERE id='${pending.body.id}'`)).toBe('true');
  });

  it('retains owned-url and ambient-url guards before dynamic application imports', () => {
    expect(() => database.ownedUrl('unregistered')).toThrow('Refusing external or inactive database');
    expect(() => prepareOwnedApiDatabase(new AdminOrdersDatabase())).toThrow('Refusing inherited DATABASE_URL before app imports');
    expect(() => new AdminOrdersDatabase().start()).toThrow('Refusing inherited DATABASE_URL');
  });

  it('documents actual discriminator, nullable history, pagination and errors in Swagger', () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const schemas = document.components!.schemas! as Record<string, any>;
    const buyer = schemas.CreateAdminOrderDto.properties.buyer;
    expect(buyer.oneOf).toHaveLength(2);
    expect(buyer.discriminator.propertyName).toBe('type');
    expect(buyer.discriminator.mapping).toHaveProperty('GUEST');
    expect(schemas.CreateAdminOrderDto.properties.payment).toBeDefined();
    for (const field of ['userId', 'createdById', 'zoneId', 'recipientType', 'recipientName', 'recipientPhone', 'deliveryWindowStart', 'deliveryWindowEnd']) {
      expect(schemas.OrderCreatedResponseDto.properties[field].nullable).toBe(true);
    }
    expect(Object.keys(schemas.UserSummaryDto.properties).sort()).toEqual(['id', 'name']);
    expect(schemas.CreateOrderDto.properties.zoneId.description).toBe(
      'Deprecated. Ignored for eligibility; persist the FK when sent, otherwise store null.',
    );
    const admin = document.paths['/api/v1/orders/admin'].post!;
    for (const status of ['201', '400', '401', '403', '404']) expect(admin.responses[status]).toBeDefined();
    expect((document.paths['/api/v1/orders'].get!.responses['200'] as any).content['application/json'].schema.$ref).toBe('#/components/schemas/AdminOrdersPageDto');
  });

  it('records a registered gift with distinct contacts, frozen golden money and printable receipts', async () => {
    database.sql('unit_b', `UPDATE public.product SET price=73, "priceCents"=7300 WHERE id='b-product'`);
    database.sql('unit_b', `UPDATE public."shopBusinessSettings" SET "taxEnabled"=true, "taxRateBps"=1500`);
    const key = randomUUID();
    const body = {
      ...guestBody(),
      buyer: { type: 'REGISTERED_CLIENT', clientId: actors.client, contactPhone: '+593111' },
      giftRecipient: { name: 'Gift Person', contactPhone: '+593222' },
      payment: { method: 'TRANSFER' },
      items: [{ productId: 'b-product', quantity: 1 }],
    };
    const created = await post(body, 'admin', key).expect(201);
    expect(created.body.userId).toBe(actors.client);
    expect(created.body.createdById).toBe(actors.admin);
    expect(created.body.buyerPhone).toBe('+593111');
    expect(created.body.recipientPhone).toBe('+593222');
    expect(created.body.recipientName).toBe('Gift Person');
    expect(created.body.subtotalCents).toBe(7300);
    expect(created.body.taxAmountCents).toBe(1095);
    expect(created.body.shippingAmountCents).toBe(0);
    expect(created.body.totalCents).toBe(8395);
    expect(created.body.payment).toMatchObject({ kind: 'ADMIN_DECLARED_EXTERNAL', status: 'DECLARED', method: 'TRANSFER', declaredById: actors.admin });
    expect(created.body.payment).not.toHaveProperty('cardLast4');
    expect(database.sql('unit_b', `SELECT count(*) FROM public."paymentAttempt" WHERE "orderId"='${created.body.id}'`)).toBe('0');
    const replay = await post(body, 'admin', key).expect(201);
    expect(replay.body.id).toBe(created.body.id);
    const conflict = await post({ ...body, deliveryAddress: 'Other' }, 'admin', key).expect(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    database.sql('unit_b', `UPDATE public."shopBusinessSettings" SET "taxRateBps"=2000`);
    database.sql('unit_b', `UPDATE public.product SET "priceCents"=9999 WHERE id='b-product'`);
    const adminReceipt = await get(`/${created.body.id}/receipt`).expect(200);
    expect(adminReceipt.body.totalCents).toBe(8395);
    expect(adminReceipt.body.tax.rateBps).toBe(1500);
    expect(adminReceipt.body.payment.kind).toBe('ADMIN_DECLARED_EXTERNAL');
    const clientToken = jwt.sign({ sub: actors.client, role: 'CLIENT' });
    const own = await request(app.getHttpServer()).get(`/api/v1/shop/orders/${created.body.id}/receipt`).auth(clientToken, { type: 'bearer' }).expect(200);
    expect(own.body.totalCents).toBe(8395);
    const other = await request(app.getHttpServer()).get(`/api/v1/shop/orders/${created.body.id}/receipt`).auth(jwt.sign({ sub: actors.foreign, role: 'CLIENT' }), { type: 'bearer' }).expect(404);
    expect(other.body.error.code).toBe('ORDER_NOT_FOUND');
    const patched = await request(app.getHttpServer()).patch(`/api/v1/orders/${created.body.id}/contact`).auth(token('admin'), { type: 'bearer' }).send({ contactRevision: 0, buyerPhone: '+593333' }).expect(200);
    expect(patched.body.buyerPhone).toBe('+593333');
    expect((await get(`/${created.body.id}/receipt`).expect(200)).body.totalCents).toBe(8395);
    expect((await get(`/${created.body.id}/receipt`).expect(200)).body.buyer.phone).toBe('+593111');
    const history = await get(`/${created.body.id}/contact-history`).expect(200);
    expect(history.body[0]).toMatchObject({ field: 'buyerPhone', previousValue: '+593111', nextValue: '+593333', actorId: actors.admin });
    expect(own.body.recipient).toMatchObject({ name: 'Gift Person', phone: '+593222' });
    const recovered = await get(`/admin/purchase-attempts/${key}`).expect(200);
    expect(recovered.body).toMatchObject({ status: 'SUCCEEDED', orderId: created.body.id });
    expect(recovered.body.result.id).toBe(created.body.id);
    await get(`/admin/purchase-attempts/${key}`, 'admin2').expect(404);
  });

  it('lets ADMIN print a guest receipt without fabricating an account', async () => {
    const created = await post({
      ...guestBody(),
      buyer: { type: 'GUEST', name: 'Walk-in', contactPhone: '+593444' },
      payment: { method: 'CASH' },
    }).expect(201);
    expect(created.body.userId).toBeNull();
    const receipt = await get(`/${created.body.id}/receipt`).expect(200);
    expect(receipt.body.buyer).toEqual({ name: 'Walk-in', phone: '+593444' });
    expect(receipt.body.payment).toMatchObject({ kind: 'ADMIN_DECLARED_EXTERNAL', status: 'DECLARED', method: 'CASH' });
    expect(receipt.body.payment).not.toHaveProperty('cardLast4');
    expect(database.sql('unit_b', `SELECT ("buyerId" IS NULL)::text FROM public."purchaseReceipt" WHERE "orderId"='${created.body.id}'`)).toBe('true');
    await request(app.getHttpServer()).get(`/api/v1/shop/orders/${created.body.id}/receipt`)
      .auth(jwt.sign({ sub: actors.client, role: 'CLIENT' }), { type: 'bearer' }).expect(404);
  });

  it('sells the last unit once under concurrent ADMIN creates', async () => {
    database.sql('unit_b', `INSERT INTO public.product (id,name,price,stock,"priceCents") VALUES ('b-last','Last unit',10,1,1000)`);
    const bodyA = { ...guestBody(), items: [{ productId: 'b-last', quantity: 1 }], deliveryAddress: 'Last A' };
    const bodyB = { ...guestBody(), items: [{ productId: 'b-last', quantity: 1 }], deliveryAddress: 'Last B' };
    const [first, second] = await Promise.all([post(bodyA), post(bodyB)]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 400]);
    const winner = first.status === 201 ? first : second;
    const loser = first.status === 201 ? second : first;
    expect(loser.body.message).toMatch(/Stock insuficiente/);
    expect(database.sql('unit_b', `SELECT stock FROM public.product WHERE id='b-last'`)).toBe('0');
    expect(database.sql('unit_b', `SELECT count(*) FROM public."purchaseReceipt" r JOIN public."orderItem" i ON i."orderId"=r."orderId" WHERE i."productId"='b-last'`)).toBe('1');
    expect(winner.body.receipt.id).toBeTruthy();
  });
});
