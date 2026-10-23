import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { cleanupOwnedResources, createOwnedDatabase, runPrismaMigrate } from './geolocation-migration.fixtures.js';

jest.setTimeout(240_000);

describe('Catalog v1.2 HTTP contract — owned PostgreSQL fixture only', () => {
  let app: INestApplication;
  let db: any;
  let admin: string;
  let client: string;
  let driver: string;
  const id = randomUUID();
  let categoryId: string;
  const path = '/api/v1';
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const product = (sku: string, category: string, extra: object = {}) => ({
    sku, name: 'Fixture Gift', description: 'A complete fixture description', categoryId: category,
    priceCents: 1050, stock: 2, ...extra,
  });
  const expectError = (body: any, code: string) => {
    expect(body).toEqual({ error: { code, message: expect.any(String), details: expect.any(Object), requestId: expect.any(String) } });
    expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toMatch(/password|credential|postgresql:\/\//i);
  };

  beforeAll(async () => {
    const url = createOwnedDatabase(`catalog_api_${id.replaceAll('-', '').slice(0, 12)}`);
    runPrismaMigrate(url);
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET = randomUUID();
    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/database/prisma.service.js');
    const { JwtService } = await import('@nestjs/jwt');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    db = app.get(PrismaService);
    const jwt = app.get(JwtService);
    for (const role of ['ADMIN', 'CLIENT', 'DRIVER'] as const) {
      const userId = randomUUID();
      const email = `${role.toLowerCase()}-${userId}@example.test`;
      await db.user.create({ id: userId, name: `Fixture ${role}`, email, password: 'fixture-not-a-credential', role });
      const token = jwt.sign({ sub: userId, email, role });
      if (role === 'ADMIN') admin = token;
      if (role === 'CLIENT') client = token;
      if (role === 'DRIVER') driver = token;
    }
    categoryId = (await http().post(`${path}/admin/catalog/categories`).set(auth(admin))
      .send({ name: 'Gifts', slug: 'gifts' }).expect(201)).body.id;
  });
  afterAll(async () => {
    if (app) await app.close();
    cleanupOwnedResources();
  });

  it('returns exactly the controller-scoped error envelope on guards and validation', async () => {
    const body = product(`SKU-${randomUUID()}`, categoryId);
    const mutations = [
      { verb: 'post', url: '/admin/catalog/categories', body: { name: 'Another', slug: 'another' } },
      { verb: 'patch', url: `/admin/catalog/categories/${categoryId}`, body: { name: 'Changed' } },
      { verb: 'post', url: '/admin/catalog/products', body },
      { verb: 'patch', url: `/admin/catalog/products/${randomUUID()}`, body: { name: 'Changed' } },
      { verb: 'patch', url: `/admin/catalog/products/${randomUUID()}/publication`, body: { isPublished: true } },
    ] as const;
    for (const mutation of mutations) {
      const anonymous = await (http() as any)[mutation.verb](`${path}${mutation.url}`).send(mutation.body).expect(401);
      expectError(anonymous.body, 'UNAUTHENTICATED');
      for (const token of [client, driver]) {
        const denied = await (http() as any)[mutation.verb](`${path}${mutation.url}`).set(auth(token)).send(mutation.body).expect(403);
        expectError(denied.body, 'FORBIDDEN');
      }
    }
    const unknown = await http().post(`${path}/admin/catalog/products`).set(auth(admin))
      .send({ ...body, legacyPrice: 10 }).expect(400);
    expectError(unknown.body, 'VALIDATION_ERROR');
    for (const bad of [null, 1.1, -1, 2147483648]) {
      expectError((await http().post(`${path}/admin/catalog/products`).set(auth(admin))
        .send({ ...body, stock: bad }).expect(400)).body, 'VALIDATION_ERROR');
    }
  });

  it('creates drafts, rejects duplicates, immutable fields and publishes only with a confirmed primary', async () => {
    const sku = `SKU-${randomUUID()}`;
    const created = await http().post(`${path}/admin/catalog/products`).set(auth(admin)).send(product(sku, categoryId, { stock: 0 })).expect(201);
    const productId = created.body.id;
    expect(created.body).toMatchObject({ sku, priceCents: 1050, stock: 0, isPublished: false, images: [], primaryImageUrl: null });
    expectError((await http().post(`${path}/admin/catalog/products`).set(auth(admin)).send(product(sku, categoryId)).expect(409)).body, 'SKU_ALREADY_EXISTS');
    expectError((await http().patch(`${path}/admin/catalog/products/${productId}`).set(auth(admin)).send({ sku: 'rewritten' }).expect(400)).body, 'VALIDATION_ERROR');
    expectError((await http().patch(`${path}/admin/catalog/products/${productId}`).set(auth(admin))
      .send({ description: null }).expect(400)).body, 'VALIDATION_ERROR');
    const beforePublication = (await http().get(`${path}/admin/catalog/products/${productId}`).set(auth(admin)).expect(200)).body;
    expectError((await http().patch(`${path}/admin/catalog/products/${productId}/publication`).set(auth(admin)).send({ isPublished: true }).expect(409)).body, 'PRODUCT_PUBLICATION_INVALID');
    expectError((await http().patch(`${path}/admin/catalog/products/${productId}`).set(auth(admin))
      .send({ name: 'Valid new name', isPublished: true }).expect(409)).body, 'PRODUCT_PUBLICATION_INVALID');
    expect((await http().get(`${path}/admin/catalog/products/${productId}`).set(auth(admin)).expect(200)).body).toEqual(beforePublication);
    expectError((await http().post(`${path}/admin/catalog/products`).set(auth(admin))
      .send(product(`SKU-${randomUUID()}`, categoryId, { isPublished: true })).expect(409)).body, 'PRODUCT_PUBLICATION_INVALID');
    expectError((await http().post(`${path}/admin/catalog/products`).set(auth(admin))
      .send(product(`SKU-${randomUUID()}`, randomUUID())).expect(404)).body, 'CATEGORY_NOT_FOUND');
    expectError((await http().patch(`${path}/admin/catalog/products/${productId}`).set(auth(admin))
      .send({ categoryId: randomUUID() }).expect(404)).body, 'CATEGORY_NOT_FOUND');
    expectError((await http().patch(`${path}/admin/catalog/categories/${randomUUID()}`).set(auth(admin))
      .send({ name: 'Absent category' }).expect(404)).body, 'CATEGORY_NOT_FOUND');
    expect((await db.product.where({ id: productId }).first()).isPublished).toBe(false);
    expectError((await http().post(`${path}/admin/catalog/categories`).set(auth(admin)).send({ name: 'Gifts', slug: 'other' }).expect(409)).body, 'CATEGORY_ALREADY_EXISTS');
    expectError((await http().post(`${path}/admin/catalog/categories`).set(auth(admin)).send({ name: 'Other', slug: 'gifts' }).expect(409)).body, 'CATEGORY_ALREADY_EXISTS');
    expectError((await http().patch(`${path}/admin/catalog/categories/${categoryId}`).set(auth(admin)).send({ slug: 'changed' }).expect(400)).body, 'VALIDATION_ERROR');
    expect((await http().patch(`${path}/admin/catalog/categories/${categoryId}`).set(auth(admin))
      .send({ description: null }).expect(200)).body.description).toBeNull();
    expectError((await http().patch(`${path}/admin/catalog/categories/${categoryId}`).set(auth(admin))
      .send({ name: null }).expect(400)).body, 'VALIDATION_ERROR');
    const edit = await http().patch(`${path}/admin/catalog/products/${productId}`).set(auth(admin))
      .send({ priceCents: 1101, stock: 2147483647 }).expect(200);
    expect(edit.body).toMatchObject({ priceCents: 1101, stock: 2147483647 });
    const persisted = await db.product.where({ id: productId }).first();
    expect(persisted.price).toBe(11.01);
    expect(persisted.priceCents).toBe(1101n);
  });

  it('retains incomplete legacy and historical order prices without projecting them publicly', async () => {
    const legacyId = randomUUID();
    await db.product.create({ id: legacyId, sku: `LEGACY-${legacyId}`, name: 'Legacy', description: null,
      price: 0.301, priceCents: null, stock: 0, isPublished: false });
    const adminDetail = await http().get(`${path}/admin/catalog/products/${legacyId}`).set(auth(admin)).expect(200);
    expect(adminDetail.body).toMatchObject({ category: null, categoryId: null, description: null, priceCents: null });
    expectError((await http().get(`${path}/shop/products/${legacyId}`).expect(404)).body, 'PRODUCT_NOT_FOUND');
    expect((await db.product.where({ id: legacyId }).first()).price).toBe(0.301);
    const legacyList = await http().get(`${path}/products`).expect(200);
    expect(Array.isArray(legacyList.body)).toBe(true);
    expect(legacyList.body.some((p: any) => p.id === legacyId)).toBe(false);
  });

  it('pages 200 stored confirmed products, filters exact cents and literal search, and hides inactive categories', async () => {
    const actor = await db.user.where((u: any) => u.role.eq('ADMIN')).first();
    const ids: string[] = [];
    for (let index = 0; index < 200; index++) {
      const productId = randomUUID();
      const uploadId = randomUUID();
      const imageUrl = `https://example.test/catalog-fixture/${uploadId}.jpg`;
      await db.product.create({ id: productId, sku: `TEST-${id.slice(0, 8)}-${index}`, name: `Gift ${String(index).padStart(3, '0')}${index === 0 ? ' %_\\' : ''}`,
        description: 'Test-only product', categoryId, price: (100 + index) / 100,
        priceCents: BigInt(100 + index), stock: index === 0 ? 0 : 1, isPublished: true });
      await db.uploadedAsset.create({ id: uploadId, actorId: actor.id, publicId: `test/${uploadId}`, secureUrl: imageUrl,
        format: 'jpg', bytes: 100, width: 10, height: 10, status: 'ATTACHED', expiresAt: Temporal.Now.instant() });
      await db.productImage.create({ id: randomUUID(), uploadId, productId, publicId: `test/${uploadId}`,
        secureUrl: imageUrl, altText: 'Test-only image', position: 0, isPrimary: true });
      ids.push(productId);
    }
    const list = await http().get(`${path}/shop/products`).expect(200);
    expect(list.body).toMatchObject({ total: 200, page: 1, pageSize: 12, totalPages: 17, sortApplied: 'featured' });
    expect(list.body.items).toHaveLength(12);
    expect(list.body.items[0].category.productCount).toBe(200);
    expect((await http().get(`${path}/shop/products?page=5&pageSize=48`).expect(200)).body.items).toHaveLength(8);
    expect((await http().get(`${path}/shop/products?page=100`).expect(200)).body).toMatchObject({ items: [], total: 200 });
    expect((await http().get(`${path}/shop/products?inStock=true`).expect(200)).body.total).toBe(199);
    expect((await http().get(`${path}/shop/products?minPriceCents=100&maxPriceCents=100`).expect(200)).body.total).toBe(1);
    expect((await http().get(`${path}/shop/products?search=%25%5F%5C`).expect(200)).body.total).toBe(1);
    expect((await http().get(`${path}/shop/products?sort=best_selling`).expect(200)).body.sortApplied).toBe('featured');
    const ascending = await http().get(`${path}/shop/products?sort=price_asc`).expect(200);
    expect(ascending.body.items[0]).toMatchObject({ priceCents: 100, stock: 0, isAvailable: false });
    for (const query of ['pageSize=49', 'sort=surprise', 'minPriceCents=2&maxPriceCents=1', 'inStock=1', 'categoryId=invalid', 'search=%20', 'unused=x']) {
      expectError((await http().get(`${path}/shop/products?${query}`).expect(400)).body, 'VALIDATION_ERROR');
    }
    const adminList = await http().get(`${path}/admin/catalog/products?status=out_of_stock`).set(auth(admin)).expect(200);
    expect(adminList.body.pageSize).toBe(10);
    expect(adminList.body.total).toBeGreaterThanOrEqual(1);
    await http().patch(`${path}/admin/catalog/products/${ids[0]}/publication`).set(auth(admin))
      .send({ isPublished: false }).expect(200);
    expectError((await http().get(`${path}/shop/products/${ids[0]}`).expect(404)).body, 'PRODUCT_NOT_FOUND');
    await http().patch(`${path}/admin/catalog/products/${ids[0]}/publication`).set(auth(admin))
      .send({ isPublished: true }).expect(200);
    await http().patch(`${path}/admin/catalog/categories/${categoryId}`).set(auth(admin)).send({ isActive: false }).expect(200);
    expectError((await http().patch(`${path}/admin/catalog/products/${ids[0]}/publication`).set(auth(admin))
      .send({ isPublished: true }).expect(409)).body, 'PRODUCT_PUBLICATION_INVALID');
    expect((await http().get(`${path}/shop/products`).expect(200)).body).toMatchObject({ items: [], total: 0 });
    expectError((await http().get(`${path}/shop/products/${ids[0]}`).expect(404)).body, 'PRODUCT_NOT_FOUND');
    expect((await http().get(`${path}/admin/catalog/products/${ids[0]}`).set(auth(admin)).expect(200)).body.isPublished).toBe(true);
    const stored = await db.product.where({ id: ids[0] }).first();
    expect(stored.priceCents).toBe(100n);
    expect(stored.stock).toBe(0);
    const legacy = await http().get(`${path}/products`).expect(200);
    expect(legacy.body.some((p: any) => p.id === ids[0])).toBe(false);
    const old = legacy.body.find((p: any) => p.id === ids[1]);
    expect(Object.keys(old).sort()).toEqual(['createdAt', 'description', 'id', 'name', 'price', 'stock']);
    await http().patch(`${path}/admin/catalog/categories/${categoryId}`).set(auth(admin)).send({ isActive: true }).expect(200);
  });

  it('keeps selection, count, category and gallery from one snapshot across a concurrent deactivation', async () => {
    const { CatalogService } = await import('../src/modules/shop/catalog/catalog.service.js');
    const catalog: any = app.get(CatalogService);
    const original = catalog.hydrate.bind(catalog);
    let selected!: () => void;
    let resume!: () => void;
    const selectedIds = new Promise<void>(resolve => { selected = resolve; });
    const release = new Promise<void>(resolve => { resume = resolve; });
    catalog.hydrate = async (...args: any[]) => {
      selected(); // The HTTP request selected the page, but has not hydrated it yet.
      await release;
      return original(...args);
    };
    try {
      const pending = http().get(`${path}/shop/products?pageSize=12`).then(response => response);
      await Promise.race([selectedIds, pending.then(response => {
        throw new Error(`Catalog request ended before the snapshot hydration barrier: ${response.status}`);
      })]);
      await http().patch(`${path}/admin/catalog/categories/${categoryId}`).set(auth(admin))
        .send({ isActive: false }).expect(200);
      resume();
      const before = await pending;
      expect(before.status).toBe(200);
      expect(before.body).toMatchObject({ total: 200, pageSize: 12, totalPages: 17 });
      expect(before.body.items).toHaveLength(12);
      expect(before.body.items.every((item: any) => item.category.productCount === 200 && item.images.length === 1)).toBe(true);
      expect((await http().get(`${path}/shop/products`).expect(200)).body).toMatchObject({ items: [], total: 0 });
    } finally {
      resume();
      catalog.hydrate = original;
      await http().patch(`${path}/admin/catalog/categories/${categoryId}`).set(auth(admin))
        .send({ isActive: true }).expect(200);
    }
  });
});
