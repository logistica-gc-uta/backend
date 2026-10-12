import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { AdminOrdersDatabase } from './admin-guest-orders-migration.fixtures';
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
  const post = (body: unknown, actor: keyof typeof actors = 'admin') =>
    request(app.getHttpServer()).post('/api/v1/orders/admin').auth(token(actor), { type: 'bearer' }).set('Content-Type', 'application/json').send(JSON.stringify(body));
  const get = (path: string, actor: keyof typeof actors = 'admin') =>
    request(app.getHttpServer()).get(`/api/v1/orders${path}`).auth(token(actor), { type: 'bearer' });

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
    const response = await post({ ...guestBody(), recipient: { type: 'REGISTERED_CLIENT', clientId: actors.client, contactPhone: ' +593 999 ' } }).expect(201);
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
  ])('rejects invalid recipient %s with 400', async (_name, recipient) => {
    await post({ ...guestBody(), recipient }).expect(400);
  });

  it.each(['createdById', 'userId', 'role', 'clientId'])('rejects actor/owner injection %s', async (key) => {
    await post({ ...guestBody(), [key]: actors.admin }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/orders').auth(token('client'), { type: 'bearer' }).send({ ...guestBody(), recipient: undefined, [key]: actors.admin }).expect(400);
  });

  it('rejects additional nested item fields and CLIENT recipient injection', async () => {
    await post({ ...guestBody(), items: [{ productId: 'b-product', quantity: 1, price: 0 }] }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/orders').auth(token('client'), { type: 'bearer' }).send(guestBody()).expect(400);
  });

  it.each([['absent', 'missing-user', 404], ['admin', actors.admin, 400], ['driver', actors.driver, 400]])('rejects registered owner %s', async (_name, clientId, status) => {
    await post({ ...guestBody(), recipient: { type: 'REGISTERED_CLIENT', clientId } }).expect(status as number);
  });

  it('allows optional registered phone and retains CLIENT optional coordinates/date', async () => {
    const adminResponse = await post({ ...guestBody(), recipient: { type: 'REGISTERED_CLIENT', clientId: actors.foreign } }).expect(201);
    expect(adminResponse.body.recipientPhone).toBeNull();
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
    ['unknown zone', { zoneId: 'absent-zone' }, 404],
    ['no depot', { zoneId: 'b-no-depot' }, 400],
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

  it('paginates scheduled business-day filters with stable date/id order and safe user summaries', async () => {
    await post({ ...guestBody(), scheduledDeliveryDate: calendar('2030-02-15T04:59:59Z') }).expect(201);
    await post({ ...guestBody(), scheduledDeliveryDate: calendar('2030-02-15T05:00:00Z') }).expect(201);
    const response = await get(calendar('?date=2030-02-14&zoneId=b-zone&status=PENDING&pageSize=2')).expect(200);
    expect(response.body).toMatchObject({ page: 1, pageSize: 2, items: expect.any(Array), total: expect.any(Number) });
    const all = await get(calendar('?date=2030-02-14&zoneId=b-zone&status=PENDING&pageSize=100')).expect(200);
    expect(all.body.total).toBe(all.body.items.length);
    const keys = all.body.items.map((order: { scheduledDeliveryDate: string; id: string }) => `${order.scheduledDeliveryDate}:${order.id}`);
    expect(keys).toEqual([...keys].sort((a, b) => a < b ? -1 : a > b ? 1 : 0));
    expect(all.body.items.some((order: { scheduledDeliveryDate: string }) => order.scheduledDeliveryDate === calendar('2030-02-15T04:59:59Z'))).toBe(true);
    expect(all.body.items.some((order: { scheduledDeliveryDate: string }) => order.scheduledDeliveryDate === calendar('2030-02-15T05:00:00Z'))).toBe(false);
    const second = await get(calendar('?date=2030-02-14&zoneId=b-zone&status=PENDING&pageSize=2&page=2')).expect(200);
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
    await get('/absent-order').expect(404);
  });

  it('retains owned-url and ambient-url guards before dynamic application imports', () => {
    expect(() => database.ownedUrl('unregistered')).toThrow('Refusing external or inactive database');
    expect(() => prepareOwnedApiDatabase(new AdminOrdersDatabase())).toThrow('Refusing inherited DATABASE_URL before app imports');
    expect(() => new AdminOrdersDatabase().start()).toThrow('Refusing inherited DATABASE_URL');
  });

  it('documents actual discriminator, nullable history, pagination and errors in Swagger', () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const schemas = document.components!.schemas! as Record<string, any>;
    const recipient = schemas.CreateAdminOrderDto.properties.recipient;
    expect(recipient.oneOf).toHaveLength(2);
    expect(recipient.discriminator.propertyName).toBe('type');
    expect(recipient.discriminator.mapping).toHaveProperty('GUEST');
    for (const field of ['userId', 'createdById', 'recipientType', 'recipientName', 'recipientPhone', 'deliveryWindowStart', 'deliveryWindowEnd']) {
      expect(schemas.OrderCreatedResponseDto.properties[field].nullable).toBe(true);
    }
    expect(Object.keys(schemas.UserSummaryDto.properties).sort()).toEqual(['id', 'name']);
    const admin = document.paths['/api/v1/orders/admin'].post!;
    for (const status of ['201', '400', '401', '403', '404']) expect(admin.responses[status]).toBeDefined();
    expect((document.paths['/api/v1/orders'].get!.responses['200'] as any).content['application/json'].schema.$ref).toBe('#/components/schemas/AdminOrdersPageDto');
  });
});
