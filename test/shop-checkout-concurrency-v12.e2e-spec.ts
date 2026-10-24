import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  cleanupOwnedResources,
  createOwnedDatabase,
  runPrismaMigrate,
  startOwnedContainer,
} from './geolocation-migration.fixtures.js';
import { bootstrapSimulatedCards } from '../src/modules/shop/checkout/simulated-card.js';
import { signQuoteToken, QuoteTokenPayload } from '../src/modules/shop/checkout/quote-token.util.js';

jest.setTimeout(240_000);

describe('Shop Checkout v1.2 Concurrency Protection E2E (owned PostgreSQL fixture)', () => {
  let app: INestApplication;
  let db: any;
  let client1Token: string;
  let client1UserId: string;
  let client2Token: string;
  let client2UserId: string;

  let ownedContainerId: string | null = null;
  const dbSuffix = randomUUID().replaceAll('-', '').slice(0, 10);
  let dbUrl: string;

  let activeCategoryId: string;
  let productAId: string;
  let productBId: string;
  let expensiveProductId: string;
  let validZoneId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SIMULATED_PAYMENTS_ENABLED = 'true';

    const receipt = startOwnedContainer();
    ownedContainerId = receipt.containerId;
    console.log(`[TEST-CONTAINER-RECEIPT] containerId=${receipt.containerId}`);
    dbUrl = createOwnedDatabase(`shop_conc_${dbSuffix}`);
    runPrismaMigrate(dbUrl);
    process.env.DATABASE_URL = dbUrl;
    process.env.JWT_SECRET = randomUUID();

    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/database/prisma.service.js');
    const { JwtService } = await import('@nestjs/jwt');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    db = app.get(PrismaService);
    const jwt = app.get(JwtService);

    await bootstrapSimulatedCards(db);

    client1UserId = randomUUID();
    const email1 = `client1-conc-${client1UserId}@example.test`;
    await db.user.create({
      id: client1UserId,
      name: 'Cliente Uno Concurrente',
      email: email1,
      password: 'fixture-password',
      role: 'CLIENT',
    });
    client1Token = jwt.sign({ sub: client1UserId, email: email1, role: 'CLIENT' });

    client2UserId = randomUUID();
    const email2 = `client2-conc-${client2UserId}@example.test`;
    await db.user.create({
      id: client2UserId,
      name: 'Cliente Dos Concurrente',
      email: email2,
      password: 'fixture-password',
      role: 'CLIENT',
    });
    client2Token = jwt.sign({ sub: client2UserId, email: email2, role: 'CLIENT' });

    activeCategoryId = randomUUID();
    await db.client.orm.public.Category.create({
      id: activeCategoryId,
      name: `Categoria Concurrencia ${dbSuffix}`,
      slug: `cat-conc-${dbSuffix}`,
      isActive: true,
    });

    productAId = randomUUID();
    await db.client.orm.public.Product.create({
      id: productAId,
      name: 'Producto Alfa',
      description: 'Producto para pruebas de concurrencia y orden de locks',
      sku: `SKU-CONC-A-${dbSuffix}`,
      price: 10.0,
      priceCents: 1000n,
      stock: 20,
      isPublished: true,
      isFeatured: false,
      categoryId: activeCategoryId,
    });

    productBId = randomUUID();
    await db.client.orm.public.Product.create({
      id: productBId,
      name: 'Producto Beta',
      description: 'Producto para pruebas de concurrencia y orden de locks',
      sku: `SKU-CONC-B-${dbSuffix}`,
      price: 15.0,
      priceCents: 1500n,
      stock: 20,
      isPublished: true,
      isFeatured: false,
      categoryId: activeCategoryId,
    });

    expensiveProductId = randomUUID();
    await db.client.orm.public.Product.create({
      id: expensiveProductId,
      name: 'Producto Costoso Limitado',
      description: 'Producto costoso para agotar saldo de DEMO_LIMITED',
      sku: `SKU-EXP-${dbSuffix}`,
      price: 15.0,
      priceCents: 1500n,
      stock: 10,
      isPublished: true,
      isFeatured: false,
      categoryId: activeCategoryId,
    });

    validZoneId = randomUUID();
    await db.client.orm.public.Zone.create({
      id: validZoneId,
      name: `Zona Ambato ${dbSuffix}`,
      code: `ZCON-${dbSuffix.slice(0, 4).toUpperCase()}`,
      depotLat: -1.2425,
      depotLng: -78.6188,
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    cleanupOwnedResources();
    if (ownedContainerId) {
      console.log(`[TEST-CONTAINER-CLEANUP] containerId=${ownedContainerId}`);
    }
  });

  const getQuoteToken = async (
    buyerId: string,
    rawItems: Array<{ productId: string; quantity: number; unitPriceCents: number }>,
    delivery: {
      recipient: { name: string; phone: string };
      zoneId: string;
      deliveryAddress: string;
      deliveryLocation: { lat: number; lng: number };
      scheduledDeliveryDate: string;
    },
  ): Promise<string> => {
    const items = [...rawItems].sort((a, b) => a.productId.localeCompare(b.productId));
    const subtotalCents = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
    const taxAmountCents = Math.floor((subtotalCents * 1500 + 5000) / 10000);
    const totalCents = subtotalCents + taxAmountCents;

    const nowRes = await db.client.transaction(async (tx: any) => {
      const { deliveryClock } = await import('../src/modules/orders/order-delivery.util.js');
      return deliveryClock(tx, db.client.raw);
    });
    const issuedAt = nowRes.toString();
    const validUntil = nowRes.add({ minutes: 15 }).toString();

    const payload: QuoteTokenPayload = {
      buyerUserId: buyerId,
      issuedAt,
      validUntil,
      settingsVersion: 1,
      currency: 'USD',
      tax: {
        mode: 'SIMULATED',
        enabled: true,
        rateBps: 1500,
        amountCents: taxAmountCents,
      },
      subtotalCents,
      shippingAmountCents: 0,
      totalCents,
      items: items.map((i) => ({
        productId: i.productId,
        quantity: i.quantity,
        unitPriceCents: i.unitPriceCents,
        lineTotalCents: i.unitPriceCents * i.quantity,
      })),
      delivery,
    };
    return signQuoteToken(payload);
  };

  describe('Concurrent Competition on LIMITED Card Balance', () => {
    it('two CLIENTs on same LIMITED card with insufficient combined balance: exactly one succeeds, no overdraft, loser untouched', async () => {
      // Set DEMO_LIMITED balance to exactly 2000 cents ($20.00)
      await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_LIMITED' }).update({
        balanceCents: 2000n,
      });

      // expensiveProductId: 1500 cents + 225 tax = 1725 cents ($17.25).
      // Combined 2 checkouts = 3450 cents > 2000 cents balance.
      const delivery1 = {
        recipient: { name: 'Cliente Uno', phone: '0991111111' },
        zoneId: validZoneId,
        deliveryAddress: 'Av. Cevallos 1',
        deliveryLocation: { lat: -1.2425, lng: -78.6188 },
        scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
      };
      const delivery2 = {
        recipient: { name: 'Cliente Dos', phone: '0992222222' },
        zoneId: validZoneId,
        deliveryAddress: 'Av. Cevallos 2',
        deliveryLocation: { lat: -1.2425, lng: -78.6188 },
        scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
      };

      const token1 = await getQuoteToken(
        client1UserId,
        [{ productId: expensiveProductId, quantity: 1, unitPriceCents: 1500 }],
        delivery1,
      );
      const token2 = await getQuoteToken(
        client2UserId,
        [{ productId: expensiveProductId, quantity: 1, unitPriceCents: 1500 }],
        delivery2,
      );

      const payload1 = {
        items: [{ productId: expensiveProductId, quantity: 1 }],
        delivery: delivery1,
        quoteToken: token1,
        paymentCard: {
          number: '9000 0000 0000 0002', // DEMO_LIMITED
          holderName: 'PRUEBA LIMITADA',
          expiresMonth: 12,
          expiresYear: 2030,
          cvv: '222',
        },
      };

      const payload2 = {
        items: [{ productId: expensiveProductId, quantity: 1 }],
        delivery: delivery2,
        quoteToken: token2,
        paymentCard: {
          number: '9000 0000 0000 0002', // DEMO_LIMITED
          holderName: 'PRUEBA LIMITADA',
          expiresMonth: 12,
          expiresYear: 2030,
          cvv: '222',
        },
      };

      const stockBefore = (
        await db.client.orm.public.Product.where({ id: expensiveProductId }).first()
      ).stock;

      // Execute both checkouts concurrently
      const [res1, res2] = await Promise.all([
        http()
          .post('/api/v1/shop/checkout')
          .set(auth(client1Token))
          .set('Idempotency-Key', randomUUID())
          .send(payload1),
        http()
          .post('/api/v1/shop/checkout')
          .set(auth(client2Token))
          .set('Idempotency-Key', randomUUID())
          .send(payload2),
      ]);

      const statuses = [res1.status, res2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 422]);

      const winner = res1.status === 201 ? res1 : res2;
      const loser = res1.status === 422 ? res1 : res2;

      expect(winner.body.status).toBe('SUCCEEDED');
      expect(loser.body.error.code).toBe('INSUFFICIENT_DEMO_FUNDS');

      // Verify balance is decremented ONLY by 1725 cents (2000 - 1725 = 275 cents)
      const balanceAfter = (
        await db.client.orm.public.SimulatedCard.where({ fixtureId: 'DEMO_LIMITED' }).first()
      ).balanceCents;
      expect(balanceAfter).toBe(275n);

      // Verify stock decremented by exactly 1
      const stockAfter = (
        await db.client.orm.public.Product.where({ id: expensiveProductId }).first()
      ).stock;
      expect(stockBefore - stockAfter).toBe(1);
    });
  });

  describe('Opposite Product Input Order Deadlock Immunity', () => {
    it('two CLIENTs with opposite product input order: both succeed without deadlock', async () => {
      // Client 1 requests [Product A, Product B]
      // Client 2 requests [Product B, Product A]
      const itemsAFirst = [
        { productId: productAId, quantity: 1, unitPriceCents: 1000 },
        { productId: productBId, quantity: 1, unitPriceCents: 1500 },
      ];
      const itemsBFirst = [
        { productId: productBId, quantity: 1, unitPriceCents: 1500 },
        { productId: productAId, quantity: 1, unitPriceCents: 1000 },
      ];

      const delivery1 = {
        recipient: { name: 'Cliente Uno', phone: '0991111111' },
        zoneId: validZoneId,
        deliveryAddress: 'Av. Cevallos 10',
        deliveryLocation: { lat: -1.2425, lng: -78.6188 },
        scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
      };
      const delivery2 = {
        recipient: { name: 'Cliente Dos', phone: '0992222222' },
        zoneId: validZoneId,
        deliveryAddress: 'Av. Cevallos 20',
        deliveryLocation: { lat: -1.2425, lng: -78.6188 },
        scheduledDeliveryDate: '2026-11-15T15:00:00.000Z',
      };

      const token1 = await getQuoteToken(client1UserId, itemsAFirst, delivery1);
      const token2 = await getQuoteToken(client2UserId, itemsBFirst, delivery2);

      const payload1 = {
        items: itemsAFirst.map((i) => ({ productId: i.productId, quantity: i.quantity })),
        delivery: delivery1,
        quoteToken: token1,
        paymentCard: {
          number: '9000 0000 0000 0001', // DEMO_APPROVED
          holderName: 'PRUEBA APROBADA',
          expiresMonth: 12,
          expiresYear: 2030,
          cvv: '111',
        },
      };

      const payload2 = {
        items: itemsBFirst.map((i) => ({ productId: i.productId, quantity: i.quantity })),
        delivery: delivery2,
        quoteToken: token2,
        paymentCard: {
          number: '9000 0000 0000 0001', // DEMO_APPROVED
          holderName: 'PRUEBA APROBADA',
          expiresMonth: 12,
          expiresYear: 2030,
          cvv: '111',
        },
      };

      const ordersCountBefore = (await db.client.orm.public.Order.all()).length;

      // Concurrently run opposite order checkouts
      const [res1, res2] = await Promise.all([
        http()
          .post('/api/v1/shop/checkout')
          .set(auth(client1Token))
          .set('Idempotency-Key', randomUUID())
          .send(payload1),
        http()
          .post('/api/v1/shop/checkout')
          .set(auth(client2Token))
          .set('Idempotency-Key', randomUUID())
          .send(payload2),
      ]);

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res1.body.status).toBe('SUCCEEDED');
      expect(res2.body.status).toBe('SUCCEEDED');

      const ordersCountAfter = (await db.client.orm.public.Order.all()).length;
      expect(ordersCountAfter - ordersCountBefore).toBe(2);
    });
  });
});
