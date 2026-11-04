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

jest.setTimeout(240_000);

describe('Seed del catálogo demo de 200 regalos (PostgreSQL real, idempotencia)', () => {
  let app: INestApplication;
  let client: any;
  let seedShopDemo: typeof import('../src/prisma/shop-demo/seed.js').seedShopDemo;
  let manifestFor: (skus: string[]) => any;
  let allSkus: string[];
  const dbSuffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const http = () => request(app.getHttpServer());

  const query = async (plan: any) => client.transaction((tx: any) => tx.query(plan));
  const exec = async (plan: any) => client.transaction((tx: any) => tx.execute(plan));
  const countOf = async (table: 'category' | 'product' | 'simulatedCard'): Promise<number> => {
    const sql = {
      category: client.raw.sql`SELECT count(*)::int AS n FROM public.category`,
      product: client.raw.sql`SELECT count(*)::int AS n FROM public.product`,
      simulatedCard: client.raw.sql`SELECT count(*)::int AS n FROM public."simulatedCard"`,
    }[table];
    return (await query(sql.returnsRow({ n: 'pg/int4@1' }).build()))[0].n;
  };

  beforeAll(async () => {
    startOwnedContainer();
    const dbUrl = createOwnedDatabase(`shop_demo_${dbSuffix}`);
    runPrismaMigrate(dbUrl);
    process.env.DATABASE_URL = dbUrl;
    process.env.JWT_SECRET = randomUUID();
    process.env.NODE_ENV = 'test';
    process.env.SIMULATED_PAYMENTS_ENABLED = 'true';

    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/database/prisma.service.js');
    ({ seedShopDemo } = await import('../src/prisma/shop-demo/seed.js'));
    const { buildDemoCatalog } = await import('../src/prisma/shop-demo/dataset.js');
    const { publicIdFor } = await import('../src/prisma/shop-demo/images-manifest.js');

    allSkus = buildDemoCatalog().products.map((p) => p.sku);
    // Entradas de prueba solo para esta base efímera; el seed real usa el manifiesto con assets reales.
    manifestFor = (skus) => ({
      version: 1,
      cloudName: 'fixture-cloud',
      generatedAt: new Date().toISOString(),
      entries: skus.map((sku) => ({
        sku,
        publicId: publicIdFor(sku),
        secureUrl: `https://res.cloudinary.com/fixture-cloud/image/upload/v1/${publicIdFor(sku)}.png`,
        format: 'png',
        bytes: 2048,
        width: 600,
        height: 600,
        altText: `Foto de ${sku}`,
      })),
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    const prisma = app.get(PrismaService);
    client = prisma.client;
    await prisma.user.create({
      id: randomUUID(),
      name: 'Admin Fixture',
      email: 'admin@delivery.com',
      password: 'fixture-password-not-real',
      role: 'ADMIN',
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    cleanupOwnedResources();
  });

  it('sin imágenes crea 10 categorías y 200 regalos, pero ninguno es público todavía', async () => {
    const result = await seedShopDemo(client);

    expect(result).toMatchObject({
      categoriesCreated: 10,
      productsCreated: 200,
      imagesAttached: 0,
      productsPublished: 0,
      cardsBootstrapped: true,
    });
    expect(await countOf('category')).toBe(10);
    expect(await countOf('product')).toBe(200);
    const res = await http().get('/api/v1/shop/products').expect(200);
    expect(res.body.total).toBe(0);
  });

  it('ejecutarlo otra vez no crea ni cambia nada', async () => {
    const again = await seedShopDemo(client);

    expect(again).toMatchObject({ categoriesCreated: 0, productsCreated: 0, imagesAttached: 0, productsPublished: 0 });
    expect(await countOf('category')).toBe(10);
    expect(await countOf('product')).toBe(200);
    expect(await countOf('simulatedCard')).toBe(3);
  });

  it('adjunta las imágenes del manifiesto y publica solo esos regalos', async () => {
    const result = await seedShopDemo(client, { manifest: manifestFor(allSkus.slice(0, 30)) });

    expect(result).toMatchObject({ imagesAttached: 30, productsPublished: 30, productsCreated: 0 });
    const res = await http().get('/api/v1/shop/products').expect(200);
    expect(res.body.total).toBe(30);
  });

  it('no pisa lo que un ADMIN cambió: stock, precio ni publicación', async () => {
    const sku = allSkus[0];
    await exec(
      client.raw.sql`UPDATE public.product SET stock = 7, "priceCents" = 1234, "isPublished" = false WHERE sku = ${sku}`
        .affectedCount()
        .build(),
    );

    const result = await seedShopDemo(client, { manifest: manifestFor(allSkus.slice(0, 30)) });

    expect(result).toMatchObject({ imagesAttached: 0, productsPublished: 0 });
    const row = (
      await query(
        client.raw.sql`SELECT stock, "priceCents"::int AS cents, "isPublished" AS pub FROM public.product WHERE sku = ${sku}`
          .returnsRow({ stock: 'pg/int4@1', cents: 'pg/int4@1', pub: 'pg/bool@1' })
          .build(),
      )
    )[0];
    expect(row).toEqual({ stock: 7, cents: 1234, pub: false });
  });

  it('no reinicia el saldo de una tarjeta ya gastada', async () => {
    await exec(
      client.raw.sql`UPDATE public."simulatedCard" SET "balanceCents" = 1 WHERE "fixtureId" = 'DEMO_APPROVED'`
        .affectedCount()
        .build(),
    );

    await seedShopDemo(client);

    const row = (
      await query(
        client.raw.sql`SELECT "balanceCents"::int AS b FROM public."simulatedCard" WHERE "fixtureId" = 'DEMO_APPROVED'`
          .returnsRow({ b: 'pg/int4@1' })
          .build(),
      )
    )[0];
    expect(row.b).toBe(1);
  });

  it('con las 200 imágenes el catálogo público pagina en 17 páginas y la última trae 8 (CT-002)', async () => {
    await seedShopDemo(client, { manifest: manifestFor(allSkus) });
    // El regalo que el ADMIN despublicó a propósito sigue fuera hasta que lo vuelva a publicar.
    const before = await http().get('/api/v1/shop/products?page=1&pageSize=12').expect(200);
    expect(before.body.total).toBe(199);
    await exec(
      client.raw.sql`UPDATE public.product SET "isPublished" = true WHERE sku = ${allSkus[0]}`.affectedCount().build(),
    );

    const first = await http().get('/api/v1/shop/products?page=1&pageSize=12').expect(200);
    expect(first.body).toMatchObject({ total: 200, totalPages: 17, pageSize: 12 });
    expect(first.body.items).toHaveLength(12);
    const last = await http().get('/api/v1/shop/products?page=17&pageSize=12').expect(200);
    expect(last.body.items).toHaveLength(8);

    const seen = new Set<string>();
    for (let page = 1; page <= 17; page++) {
      const res = await http().get(`/api/v1/shop/products?page=${page}&pageSize=12`).expect(200);
      for (const item of res.body.items) seen.add(item.id);
    }
    expect(seen.size).toBe(200);
  });

  it('hay 10 categorías públicas', async () => {
    const res = await http().get('/api/v1/shop/categories').expect(200);
    const list = Array.isArray(res.body) ? res.body : res.body.items;
    expect(list).toHaveLength(10);
  });
});
