import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { JwtService } from '@nestjs/jwt';
import { bootstrapSimulatedCards } from '../src/modules/shop/checkout/simulated-card.js';

export interface SeededUsers {
  clientToken: string;
  clientUserId: string;
  clientEmail: string;
  otherClientToken: string;
  otherClientUserId: string;
  otherEmail: string;
  adminToken: string;
  adminId: string;
  driverToken: string;
  driverUserId: string;
  driverProfileId: string;
}

export interface SeededCatalog {
  categoryId: string;
  productId: string;
  productPriceCents: number;
  productSku: string;
  productName: string;
  zoneId: string;
}

export async function seedTestUsers(db: any, jwt: JwtService, dbSuffix: string): Promise<SeededUsers> {
  const clientUserId = randomUUID();
  const clientEmail = `client-${dbSuffix}-${clientUserId.slice(0, 8)}@example.test`;
  await db.user.create({
    id: clientUserId,
    name: 'María Pérez',
    email: clientEmail,
    password: 'fixture-password',
    role: 'CLIENT',
  });
  const clientToken = jwt.sign({ sub: clientUserId, email: clientEmail, role: 'CLIENT' });

  const otherClientUserId = randomUUID();
  const otherEmail = `other-${dbSuffix}-${otherClientUserId.slice(0, 8)}@example.test`;
  await db.user.create({
    id: otherClientUserId,
    name: 'Carlos Competidor',
    email: otherEmail,
    password: 'fixture-password',
    role: 'CLIENT',
  });
  const otherClientToken = jwt.sign({ sub: otherClientUserId, email: otherEmail, role: 'CLIENT' });

  const adminId = randomUUID();
  const adminEmail = `admin-${dbSuffix}-${adminId.slice(0, 8)}@example.test`;
  await db.user.create({
    id: adminId,
    name: 'Admin User',
    email: adminEmail,
    password: 'fixture-password',
    role: 'ADMIN',
  });
  const adminToken = jwt.sign({ sub: adminId, email: adminEmail, role: 'ADMIN' });

  const driverUserId = randomUUID();
  const driverEmail = `driver-${dbSuffix}-${driverUserId.slice(0, 8)}@example.test`;
  await db.user.create({
    id: driverUserId,
    name: 'Driver User',
    email: driverEmail,
    password: 'fixture-password',
    role: 'DRIVER',
  });
  const driverToken = jwt.sign({ sub: driverUserId, email: driverEmail, role: 'DRIVER' });

  // Create real operational Driver profile linked to Driver user
  const driverProfileId = randomUUID();
  await db.client.orm.public.Driver.create({
    id: driverProfileId,
    userId: driverUserId,
    vehicle: 'Camioneta Toyota Hilux',
    isAvailable: true,
  });

  return {
    clientToken,
    clientUserId,
    clientEmail,
    otherClientToken,
    otherClientUserId,
    otherEmail,
    adminToken,
    adminId,
    driverToken,
    driverUserId,
    driverProfileId,
  };
}

export async function seedCatalog(db: any, dbSuffix: string): Promise<SeededCatalog> {
  const categoryId = randomUUID();
  await db.client.orm.public.Category.create({
    id: categoryId,
    name: `Regalos ${dbSuffix}`,
    slug: `regalos-${dbSuffix}`,
    isActive: true,
  });

  const productId = randomUUID();
  const productPriceCents = 3650;
  const productSku = `SKU-ORD-${dbSuffix}`;
  const productName = 'Caja sorpresa navideña';

  await db.client.orm.public.Product.create({
    id: productId,
    name: productName,
    description: 'Hermosa caja sorpresa navideña para pruebas de pedidos',
    sku: productSku,
    price: 36.5,
    priceCents: BigInt(productPriceCents),
    stock: 50,
    isPublished: true,
    isFeatured: true,
    categoryId,
  });

  const zoneId = randomUUID();
  await db.client.orm.public.Zone.create({
    id: zoneId,
    name: `Centro Ambato ${dbSuffix}`,
    code: `ZON-${dbSuffix.slice(0, 4).toUpperCase()}`,
    depotLat: -1.2425,
    depotLng: -78.6188,
  });

  return {
    categoryId,
    productId,
    productPriceCents,
    productSku,
    productName,
    zoneId,
  };
}

export async function performCheckout(
  app: INestApplication,
  db: any,
  users: SeededUsers,
  catalog: SeededCatalog,
  quantity = 2,
): Promise<{
  orderId: string;
  receiptId: string;
  commercialOrderNumber: string;
  receiptNumber: string;
  idempotencyKey: string;
  checkoutPayload: any;
}> {
  await bootstrapSimulatedCards(db);

  const quoteRes = await request(app.getHttpServer())
    .post('/api/v1/shop/checkout/quote')
    .set('Authorization', `Bearer ${users.clientToken}`)
    .send({
      items: [
        {
          productId: catalog.productId,
          quantity,
        },
      ],
      delivery: {
        recipient: {
          name: 'Ana Regalo',
          phone: '0991234567',
        },
        zoneId: catalog.zoneId,
        deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
        deliveryLocation: {
          lat: -1.2425,
          lng: -78.6188,
        },
        scheduledDeliveryDate: '2026-11-15T10:00:00-05:00',
        deliveryNotes: 'Entregar en recepcion',
      },
    });

  if (quoteRes.status !== 200) {
    throw new Error(`Quote failed with status ${quoteRes.status}: ${JSON.stringify(quoteRes.body)}`);
  }

  const quoteToken = quoteRes.body.quoteToken;
  const idempotencyKey = randomUUID();

  const checkoutPayload = {
    items: [
      {
        productId: catalog.productId,
        quantity,
      },
    ],
    delivery: {
      recipient: {
        name: 'Ana Regalo',
        phone: '0991234567',
      },
      zoneId: catalog.zoneId,
      deliveryAddress: 'Av. Cevallos y Montalvo, Ambato',
      deliveryLocation: {
        lat: -1.2425,
        lng: -78.6188,
      },
      scheduledDeliveryDate: '2026-11-15T10:00:00-05:00',
      deliveryNotes: 'Entregar en recepcion',
    },
    quoteToken,
    paymentCard: {
      number: '9000 0000 0000 0001',
      holderName: 'PRUEBA APROBADA',
      expiresMonth: 12,
      expiresYear: 2030,
      cvv: '111',
    },
  };

  const res = await request(app.getHttpServer())
    .post('/api/v1/shop/checkout')
    .set('Authorization', `Bearer ${users.clientToken}`)
    .set('Idempotency-Key', idempotencyKey)
    .send(checkoutPayload);

  if (res.status !== 201) {
    throw new Error(`performCheckout failed with status ${res.status}: ${JSON.stringify(res.body)}`);
  }

  return {
    orderId: res.body.order.id,
    receiptId: res.body.receipt.id,
    commercialOrderNumber: res.body.order.number,
    receiptNumber: res.body.receipt.number,
    idempotencyKey,
    checkoutPayload,
  };
}
