import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  actors,
  guestBody,
  prepareOwnedApiDatabase,
} from './admin-guest-orders-api.fixtures';
import { AdminOrdersDatabase } from './admin-guest-orders-migration.fixtures';

// Refuse ambient DATABASE_URL before dynamic application/Prisma imports.
if (process.env.DATABASE_URL) {
  throw new Error('Refusing inherited DATABASE_URL before app imports');
}

describe('GET /api/v1/admin/clients (owned PostgreSQL 16)', () => {
  const database = new AdminOrdersDatabase();
  let app: INestApplication;
  let jwt: JwtService;

  const token = (sub: string, role = 'ADMIN') => jwt.sign({ sub, role });
  const getClients = (query = '', actorSub: string = actors.admin) =>
    request(app.getHttpServer())
      .get(`/api/v1/admin/clients${query}`)
      .auth(token(actorSub), { type: 'bearer' });

  beforeAll(async () => {
    const secret = prepareOwnedApiDatabase(database);
    jwt = new JwtService({ secret });

    database.sql(
      'unit_b',
      `
      INSERT INTO public."user" (id, name, email, password, role) VALUES
        ('client-ana', 'Ana Cliente', 'client1@delivery.com', 'private-hash-ana', 'CLIENT'),
        ('client-pedro', 'Pedro Comprador', 'client2@delivery.com', 'private-hash-pedro', 'CLIENT'),
        ('client-tie-b', 'Ana Tie', 'tie-b@delivery.com', 'private-hash-tie-b', 'CLIENT'),
        ('client-tie-a', 'Ana Tie', 'tie-a@delivery.com', 'private-hash-tie-a', 'CLIENT'),
        ('client-wildcard', E'Promo 50%_\\\\ User', 'promo_50%@delivery.com', 'private-hash-wild', 'CLIENT'),
        ('admin-ana', 'Ana Admin', 'ana.admin@delivery.com', 'private-hash-admin', 'ADMIN'),
        ('driver-ana', 'Ana Driver', 'ana.driver@delivery.com', 'private-hash-driver', 'DRIVER');
      `,
    );

    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  }, 180000);

  afterAll(async () => {
    try {
      if (app) await app.close();
    } finally {
      delete process.env.DATABASE_URL;
      delete process.env.JWT_SECRET;
      database.stop();
    }
  });

  it('returns 401 without a JWT or with an invalid JWT', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/clients').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/admin/clients')
      .auth('invalid.jwt.token', { type: 'bearer' })
      .expect(401);
  });

  it('returns 403 for CLIENT and DRIVER accounts even if JWT payload spoofs ADMIN', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/clients')
      .auth(token(actors.client, 'CLIENT'), { type: 'bearer' })
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/admin/clients')
      .auth(token(actors.driver, 'DRIVER'), { type: 'bearer' })
      .expect(403);
    await getClients('', actors.client).expect(403);
    await getClients('', actors.driver).expect(403);
  });

  it('returns only CLIENT accounts with strict { id, name, email } projection and stable name ASC, id ASC ordering', async () => {
    const res = await getClients().expect(200);
    expect(res.body).toEqual({
      items: [
        {
          id: 'client-ana',
          name: 'Ana Cliente',
          email: 'client1@delivery.com',
        },
        {
          id: 'client-tie-a',
          name: 'Ana Tie',
          email: 'tie-a@delivery.com',
        },
        {
          id: 'client-tie-b',
          name: 'Ana Tie',
          email: 'tie-b@delivery.com',
        },
        {
          id: 'client-pedro',
          name: 'Pedro Comprador',
          email: 'client2@delivery.com',
        },
        {
          id: actors.client,
          name: 'Profile client',
          email: 'b-client@example.test',
        },
        {
          id: actors.foreign,
          name: 'Profile foreign',
          email: 'b-foreign@example.test',
        },
        {
          id: 'client-wildcard',
          name: 'Promo 50%_\\ User',
          email: 'promo_50%@delivery.com',
        },
      ],
      total: 7,
      page: 1,
      pageSize: 20,
    });

    for (const item of res.body.items) {
      expect(Object.keys(item).sort()).toEqual(['email', 'id', 'name']);
      expect(item).not.toHaveProperty('password');
      expect(item).not.toHaveProperty('role');
      expect(item).not.toHaveProperty('createdAt');
      expect(item).not.toHaveProperty('orders');
    }
    expect(JSON.stringify(res.body)).not.toMatch(
      /private-hash|password|createdAt|admin-ana|driver-ana|b-admin|b-driver/,
    );
  });

  it('searches case-insensitively on name and email while excluding matching ADMIN and DRIVER accounts', async () => {
    const byName = await getClients('?search=ana').expect(200);
    expect(byName.body).toEqual({
      items: [
        {
          id: 'client-ana',
          name: 'Ana Cliente',
          email: 'client1@delivery.com',
        },
        {
          id: 'client-tie-a',
          name: 'Ana Tie',
          email: 'tie-a@delivery.com',
        },
        {
          id: 'client-tie-b',
          name: 'Ana Tie',
          email: 'tie-b@delivery.com',
        },
      ],
      total: 3,
      page: 1,
      pageSize: 20,
    });

    const upperTrimmed = await getClients(
      '?search=%20%20ANA%20CLIENTE%20%20',
    ).expect(200);
    expect(upperTrimmed.body).toEqual({
      items: [
        {
          id: 'client-ana',
          name: 'Ana Cliente',
          email: 'client1@delivery.com',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    const byEmail = await getClients('?search=CLIENT1@DELIVERY').expect(200);
    expect(byEmail.body).toEqual({
      items: [
        {
          id: 'client-ana',
          name: 'Ana Cliente',
          email: 'client1@delivery.com',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
  });

  it('escapes SQL LIKE wildcards (%, _, \\) so they match only literal characters', async () => {
    const allWildcards = await getClients('?search=%25%25').expect(200);
    expect(allWildcards.body).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });

    const underscores = await getClients('?search=__').expect(200);
    expect(underscores.body).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });

    const literalPercent = await getClients('?search=50%25').expect(200);
    expect(literalPercent.body).toEqual({
      items: [
        {
          id: 'client-wildcard',
          name: 'Promo 50%_\\ User',
          email: 'promo_50%@delivery.com',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    const literalCombo = await getClients('?search=50%25_%5C').expect(200);
    expect(literalCombo.body).toEqual({
      items: [
        {
          id: 'client-wildcard',
          name: 'Promo 50%_\\ User',
          email: 'promo_50%@delivery.com',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
  });

  it('paginates deterministically across pages and preserves total on out-of-range pages', async () => {
    const full = await getClients('?pageSize=50').expect(200);
    const page1 = await getClients('?page=1&pageSize=2').expect(200);
    const page2 = await getClients('?page=2&pageSize=2').expect(200);
    const page4 = await getClients('?page=4&pageSize=2').expect(200);
    const emptyPage = await getClients('?page=10&pageSize=2').expect(200);

    expect(page1.body).toEqual({
      items: full.body.items.slice(0, 2),
      total: 7,
      page: 1,
      pageSize: 2,
    });
    expect(page2.body).toEqual({
      items: full.body.items.slice(2, 4),
      total: 7,
      page: 2,
      pageSize: 2,
    });
    expect(page4.body).toEqual({
      items: full.body.items.slice(6, 7),
      total: 7,
      page: 4,
      pageSize: 2,
    });
    expect(emptyPage.body).toEqual({
      items: [],
      total: 7,
      page: 10,
      pageSize: 2,
    });
  });

  it.each([
    'search=a',
    'search=%20a%20',
    'search=',
    'search=%20%20%20',
    `search=${'a'.repeat(101)}`,
    'page=0',
    'page=-1',
    'page=1.5',
    'page=1000001',
    'pageSize=0',
    'pageSize=-1',
    'pageSize=51',
    'pageSize=abc',
    'unknown=1',
    'phone=0991234567',
    'role=CLIENT',
  ])('rejects invalid query %s with 400 Bad Request', async (query) => {
    await getClients(`?${query}`).expect(400);
  });

  it('uses the id returned from GET /api/v1/admin/clients?search=ana as buyer.clientId in POST /api/v1/orders/admin', async () => {
    const searchRes = await getClients('?search=ana').expect(200);
    const ana = searchRes.body.items.find(
      (item: { email: string }) => item.email === 'client1@delivery.com',
    );
    expect(ana).toEqual({
      id: 'client-ana',
      name: 'Ana Cliente',
      email: 'client1@delivery.com',
    });

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/orders/admin')
      .auth(token(actors.admin), { type: 'bearer' })
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', randomUUID())
      .send(
        JSON.stringify({
          ...guestBody(),
          buyer: {
            type: 'REGISTERED_CLIENT',
            clientId: ana.id,
            contactPhone: ' +593 99 888 7777 ',
          },
        }),
      )
      .expect(201);

    expect(createRes.body).toMatchObject({
      userId: 'client-ana',
      createdById: actors.admin,
      recipientType: 'REGISTERED_CLIENT',
      recipientName: 'Ana Cliente',
      recipientPhone: '+593 99 888 7777',
      status: 'PENDING',
    });
  });

  it('documents GET /api/v1/admin/clients and its strict DTO schemas in Swagger', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    const getOp = document.paths['/api/v1/admin/clients']?.get;
    expect(getOp).toBeDefined();
    for (const status of ['200', '400', '401', '403']) {
      expect(getOp!.responses[status]).toBeDefined();
    }
    expect(
      (getOp!.responses['200'] as any).content['application/json'].schema.$ref,
    ).toBe('#/components/schemas/AdminClientsPageDto');

    const schemas = document.components!.schemas! as Record<string, any>;
    expect(
      Object.keys(schemas.AdminClientItemDto.properties).sort(),
    ).toEqual(['email', 'id', 'name']);
    expect(
      Object.keys(schemas.AdminClientsPageDto.properties).sort(),
    ).toEqual(['items', 'page', 'pageSize', 'total']);
  });
});
