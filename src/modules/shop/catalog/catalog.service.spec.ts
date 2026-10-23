import { CatalogService } from './catalog.service.js';

const time = { toString: () => '2026-01-01T00:00:00Z' };
const category = { id: 'category', name: 'Gifts', slug: 'gifts', description: null, isActive: true, sortOrder: 2, createdAt: time, updatedAt: time };
const asset = { status: 'ATTACHED', secureUrl: 'https://image.test/gift.png' };
const image = { id: 'image', uploadId: 'upload', upload: asset, secureUrl: asset.secureUrl, publicId: 'regalia/products/id', altText: 'Gift', position: 0, isPrimary: true };
const product = { id: 'gift', sku: 'GIFT-1', name: 'Gift box', description: 'A gift', categoryId: category.id,
  category, priceCents: 1250n, stock: 0, isPublished: true, isFeatured: true, images: [image], createdAt: time, updatedAt: time };

function fixture(rows: typeof product[] = [product], page: { id: string; total: number }[] = [{ id: 'gift', total: 1 }]) {
  const queries: string[] = [];
  const query = jest.fn(async (plan: { text: string; values?: unknown[] }) => {
    const sql = plan.text;
    queries.push(sql);
    if (sql.includes('clock_timestamp()')) return [{ instant: { toString: () => '2026-01-02T00:00:00Z' } }];
    if (sql.includes('count(*) OVER()')) return page;
    if (sql.includes('count(*)::int AS total')) return [{ total: rows.length }];
    if (sql.includes('AS count')) return [{ id: category.id, count: 1 }];
    if (sql.includes('FOR UPDATE')) return [{ id: category.id }];
    return [];
  });
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join('?'), values,
    returnsRow() { return this; }, affectedCount() { return this; }, build() { return this; },
  });
  const rowChain = (result: unknown) => ({
    include() { return this; }, select() { return this; }, orderBy() { return this; },
    where() { return this; }, all: jest.fn(async () => result), first: jest.fn(async () => Array.isArray(result) ? result[0] : result),
    update: jest.fn(async (_changes?: unknown) => undefined), create: jest.fn(async (_data?: unknown) => result),
  });
  const categories = rowChain([category]);
  const products = rowChain(rows);
  const tx = { execute: jest.fn(async (_plan?: { text: string }) => undefined), query, orm: { public: { Category: categories, Product: products,
    ProductImage: rowChain([image]), UploadedAsset: rowChain([asset]) } } };
  const client = { raw: { sql }, transaction: jest.fn(async (work: (arg: typeof tx) => Promise<unknown>) => work(tx)) };
  const prisma = { client, category: rowChain([category]), product: rowChain(rows) };
  return { service: new CatalogService(prisma as any), tx, client, prisma, queries, products, categories };
}

const publicQuery = { page: 1, pageSize: 12 };

describe('CatalogService public and admin reads', () => {
  it('returns only active categories with published counts on one read-only snapshot', async () => {
    const f = fixture();
    const result = await f.service.listCategories(true);
    expect(result).toEqual({ items: [{ id: 'category', name: 'Gifts', slug: 'gifts', description: null, productCount: 1, sortOrder: 2 }] });
    expect(f.tx.execute).toHaveBeenCalledTimes(1);
    expect(f.tx.execute.mock.calls[0]?.[0]?.text).toContain('REPEATABLE READ, READ ONLY');
    expect(f.queries.some(sql => sql.includes('"isPublished"=true') && sql.includes('"isActive"=true'))).toBe(true);
  });

  it('keeps inactive categories visible to ADMIN but excludes them publicly', async () => {
    const f = fixture();
    f.categories.all.mockResolvedValueOnce([{ ...category, isActive: false }]);
    expect(await f.service.listCategories(true)).toEqual({ items: [] });
    f.categories.all.mockResolvedValueOnce([{ ...category, isActive: false }]);
    expect((await f.service.listCategories(false)).items).toEqual([expect.objectContaining({ id: 'category', isActive: false })]);
  });

  it('returns a stocked-out published product with integer cents and ordered confirmed gallery', async () => {
    const f = fixture([{ ...product, images: [{ ...image, id: 'second', position: 2, isPrimary: false }, image] }]);
    expect(await f.service.detail('gift', true)).toMatchObject({ priceCents: 1250, currency: 'USD', isAvailable: false,
      primaryImageUrl: asset.secureUrl, images: [{ id: 'image', position: 0 }, { id: 'second', position: 2 }] });
    expect(f.client.transaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['inactive category', { category: { ...category, isActive: false } }],
    ['unpublished', { isPublished: false }],
    ['unconfirmed primary', { images: [{ ...image, upload: { ...asset, status: 'UPLOADED' } }] }],
  ])('hides %s from Shop detail without hiding it from ADMIN', async (_, change) => {
    const f = fixture([{ ...product, ...change }]);
    await expect(f.service.detail('gift', true)).rejects.toMatchObject({ status: 404 });
    expect(await f.service.detail('gift', false)).toMatchObject({ id: 'gift' });
  });

  it('uses bounded SQL filters and stable ID tie-break, and reports fallback sort', async () => {
    const f = fixture();
    const result = await f.service.listProducts({ ...publicQuery, search: '50%_\\', categoryId: 'category', minPriceCents: 1,
      maxPriceCents: 2000, inStock: 'true', sort: 'best_selling' });
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 12, totalPages: 1, sortApplied: 'featured', items: [{ id: 'gift', priceCents: 1250 }] });
    expect(f.queries[0]).toContain('p.id ASC');
    expect(f.queries[0]).toContain('p.stock>0');
    expect(f.tx.query.mock.calls[0]?.[0]?.values).toContain('%50\\%\\_\\\\%');
  });

  it('counts an empty out-of-range public page in the same snapshot', async () => {
    const f = fixture([product], []);
    const result = await f.service.listProducts({ ...publicQuery, page: 5, pageSize: 1 });
    expect(result).toMatchObject({ items: [], total: 1, totalPages: 1, page: 5 });
    expect(f.client.transaction).toHaveBeenCalledTimes(1);
    expect(f.queries.some(q => q.includes('count(*)::int AS total'))).toBe(true);
  });

  it('rejects inverted price bounds and unsafe pagination without querying', async () => {
    const f = fixture();
    await expect(f.service.listProducts({ ...publicQuery, minPriceCents: 200, maxPriceCents: 100 })).rejects.toMatchObject({ status: 400 });
    await expect(f.service.listAdminProducts({ page: Number.MAX_SAFE_INTEGER, pageSize: 50 })).rejects.toMatchObject({ status: 400 });
    expect(f.client.transaction).not.toHaveBeenCalled();
  });

  it('lists legacy and out-of-stock records to ADMIN, with fallback count for empty pages', async () => {
    const f = fixture([{ ...product, sku: null, priceCents: null, description: null, category: null, images: [] } as any], []);
    const result = await f.service.listAdminProducts({ page: 2, pageSize: 10, status: 'out_of_stock', search: 'gift' });
    expect(result).toMatchObject({ items: [], total: 1, totalPages: 1 });
    expect(f.queries[0]).toContain("'out_of_stock' AND p.stock=0");
    expect(f.queries[0]).toContain('p.sku ILIKE');
    expect(await f.service.detail('gift', false)).toMatchObject({ sku: null, priceCents: null, category: null, primaryImageUrl: null });
  });
});

describe('CatalogService writes', () => {
  const dto = { sku: 'GIFT-1', name: 'Gift box', description: 'A gift', categoryId: 'category', priceCents: 1250, stock: 0 };
  it('rejects publishing a newly created product before a primary image exists', async () => {
    const f = fixture();
    await expect(f.service.createProduct({ ...dto, isPublished: true })).rejects.toMatchObject({ status: 409 });
    expect(f.products.create).not.toHaveBeenCalled();
  });

  it('creates an unpublished product using exact cents and legacy price projection', async () => {
    const f = fixture();
    f.products.create.mockImplementationOnce(async (data?: unknown) => {
      f.products.all.mockResolvedValueOnce([{ ...product, id: (data as { id: string }).id, isPublished: false }]);
      return data;
    });
    await f.service.createProduct(dto);
    expect(f.products.create).toHaveBeenCalledWith(expect.objectContaining({ sku: dto.sku, priceCents: 1250n, price: 12.5,
      isPublished: false, stock: 0 }));
  });

  it('maps duplicate SKU and category constraints to stable errors', async () => {
    const f = fixture();
    f.products.create.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
    await expect(f.service.createProduct(dto)).rejects.toMatchObject({ status: 409, response: { error: { code: 'SKU_ALREADY_EXISTS' } } });
    f.prisma.category.create.mockRejectedValueOnce(Object.assign(new Error('unique constraint'), { code: '23505' }));
    await expect(f.service.createCategory({ name: 'Gifts', slug: 'gifts' })).rejects.toMatchObject({ status: 409, response: { error: { code: 'CATEGORY_ALREADY_EXISTS' } } });
  });

  it('rejects missing category references before creating anything', async () => {
    const f = fixture();
    f.tx.query.mockResolvedValueOnce([]);
    await expect(f.service.createProduct(dto)).rejects.toMatchObject({ status: 404, response: { error: { code: 'CATEGORY_NOT_FOUND' } } });
    expect(f.products.create).not.toHaveBeenCalled();
  });

  it('rejects publication without confirmed primary atomically', async () => {
    const f = fixture([{ ...product, isPublished: false, images: [] }]);
    f.tx.orm.public.ProductImage.first.mockResolvedValueOnce(undefined);
    await expect(f.service.publish('gift', true)).rejects.toMatchObject({ status: 409, response: { error: { code: 'PRODUCT_PUBLICATION_INVALID' } } });
    expect(f.products.update).not.toHaveBeenCalled();
  });

  it('withdraws a published product without changing its stock or gallery', async () => {
    const f = fixture();
    await f.service.publish('gift', false);
    expect(f.products.update).toHaveBeenCalledWith(expect.objectContaining({ isPublished: false }));
    expect(f.tx.orm.public.ProductImage.first).not.toHaveBeenCalled();
  });
});
