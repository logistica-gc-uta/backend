import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { centsToLegacyPrice } from '../../../common/money-cents.util.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { deliveryClock } from '../../orders/order-delivery.util.js';
import { lockInventoryProduct } from '../../orders/order-inventory.util.js';
import { shopError } from '../shop-http.filter.js';
import { AdminCatalogQuery, CreateCatalogProductDto, CreateCategoryDto, PatchCatalogProductDto, PatchCategoryDto, PublicCatalogQuery } from './catalog.dto.js';

type Client = PrismaService['client'];
type Transaction = Parameters<Parameters<Client['transaction']>[0]>[0];
const missing = () => shopError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
const missingCategory = () => shopError(404, 'CATEGORY_NOT_FOUND', 'Category not found');
const invalid = () => shopError(400, 'VALIDATION_ERROR', 'Invalid request');
const conflict = () => shopError(409, 'PRODUCT_PUBLICATION_INVALID', 'Product publication requirements are not met');
const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');
const safeOffset = (page: number, size: number) => {
  const offset = (page - 1) * size;
  if (!Number.isSafeInteger(offset)) throw invalid();
  return offset;
};
const uniqueViolation = (error: unknown) => {
  const text = String((error as { code?: string })?.code ?? '');
  const message = String((error as { message?: string })?.message ?? '');
  return text === '23505' || /unique constraint|duplicate key|ORM\.UNIQUE/i.test(message);
};

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  private async lockCategory(tx: Transaction, id: string) {
    const plan = this.prisma.client.raw.sql`SELECT id FROM public.category WHERE id = ${id} FOR UPDATE`
      .returnsRow({ id: 'pg/text@1' }).build();
    if (!(await tx.query(plan))[0]) throw missingCategory();
  }

  // Prisma 8 exposes tx.query/tx.execute on the pinned transaction. PostgreSQL
  // REPEATABLE READ keeps SQL selection, ORM hydration and category counts on
  // one MVCC snapshot; READ COMMITTED would still permit torn pages.
  private snapshot<T>(read: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.prisma.client.transaction(async tx => {
      await tx.execute(this.prisma.client.raw.sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
        .affectedCount().build());
      return read(tx);
    });
  }

  private async categoryCounts(tx: Transaction): Promise<Map<string, number>> {
    const plan = this.prisma.client.raw.sql`SELECT p."categoryId" AS id, count(*)::int AS count
      FROM public.product p JOIN public.category c ON c.id=p."categoryId"
      WHERE p."isPublished"=true AND c."isActive"=true AND p."priceCents" IS NOT NULL
        AND p.sku IS NOT NULL AND length(p.sku) BETWEEN 3 AND 50 AND p.description IS NOT NULL AND length(p.description) BETWEEN 1 AND 2000
        AND length(p.name) BETWEEN 3 AND 160 AND EXISTS (
          SELECT 1 FROM public."productImage" i JOIN public."uploadedAsset" u ON u.id=i."uploadId"
          WHERE i."productId"=p.id AND i."isPrimary"=true AND u.status='ATTACHED' AND u."secureUrl"=i."secureUrl"
        ) GROUP BY p."categoryId"`.returnsRow({ id: 'pg/text@1', count: 'pg/int4@1' }).build();
    return new Map((await tx.query(plan)).map(row => [row.id, row.count]));
  }

  private publicCategory(row: { id: string; name: string; slug: string; description: string | null; sortOrder: number }, counts: Map<string, number>) {
    return { id: row.id, name: row.name, slug: row.slug, description: row.description,
      productCount: counts.get(row.id) ?? 0, sortOrder: row.sortOrder };
  }

  async listCategories(publicOnly: boolean) {
    return this.snapshot(async tx => {
      const rows = await tx.orm.public.Category.orderBy([(c) => c.sortOrder.asc(), (c) => c.name.asc(), (c) => c.id.asc()]).all();
      const counts = publicOnly ? await this.categoryCounts(tx) : new Map<string, number>();
      return { items: rows.filter(c => !publicOnly || c.isActive).map(c => publicOnly
        ? this.publicCategory(c, counts)
        : { id: c.id, name: c.name, slug: c.slug, description: c.description,
            isActive: c.isActive, sortOrder: c.sortOrder,
            createdAt: c.createdAt.toString(), updatedAt: c.updatedAt.toString() }) };
    });
  }

  private async hydrate(tx: Transaction, ids: string[], publicOnly: boolean) {
    if (!ids.length) return [];
    const rows = await tx.orm.public.Product.where(p => p.id.in(ids))
      .include('category').include('images', images => images.include('upload')).all();
    const counts = await this.categoryCounts(tx);
    const byId = new Map(rows.map(row => {
      const category = row.category ? this.publicCategory(row.category, counts) : null;
      const active = row.category?.isActive === true;
      const images = row.images.filter(image => image.upload?.status === 'ATTACHED' && image.upload.secureUrl &&
        image.secureUrl === image.upload.secureUrl)
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
        .map(image => ({ id: image.id, secureUrl: image.secureUrl, publicId: image.publicId,
          altText: image.altText, position: image.position, isPrimary: image.isPrimary }));
      const primaryImageUrl = images.find(image => image.isPrimary)?.secureUrl ?? null;
      const complete = row.isPublished && active && category && row.sku && row.sku.length >= 3 && row.sku.length <= 50 && row.description &&
        row.name.length >= 3 && row.name.length <= 160 && row.description.length >= 1 &&
        row.description.length <= 2000 && row.priceCents !== null && primaryImageUrl;
      if (publicOnly && !complete) return [row.id, null] as const;
      return [row.id, { id: row.id, sku: row.sku, name: row.name, description: row.description,
        categoryId: row.categoryId, category, priceCents: row.priceCents === null ? null : Number(row.priceCents),
        currency: 'USD' as const, stock: row.stock, isPublished: row.isPublished, isFeatured: row.isFeatured,
        images, primaryImageUrl, isAvailable: !!complete && row.stock > 0,
        createdAt: row.createdAt.toString(), updatedAt: row.updatedAt.toString() }] as const;
    }));
    return ids.map(id => byId.get(id) ?? null);
  }

  async detail(id: string, publicOnly: boolean) {
    return this.snapshot(async tx => {
      const product = (await this.hydrate(tx, [id], publicOnly))[0];
      if (!product) throw missing();
      return product;
    });
  }

  async listProducts(query: PublicCatalogQuery) {
    if (query.minPriceCents !== undefined && query.maxPriceCents !== undefined && query.minPriceCents > query.maxPriceCents) throw invalid();
    const offset = safeOffset(query.page, query.pageSize);
    const search = query.search === undefined ? '' : `%${escapeLike(query.search)}%`;
    const categoryId = query.categoryId ?? '';
    const min = BigInt(query.minPriceCents ?? 0);
    const max = BigInt(query.maxPriceCents ?? 0);
    const hasMin = query.minPriceCents !== undefined;
    const hasMax = query.maxPriceCents !== undefined;
    const inStock = query.inStock === 'true';
    const sortApplied = query.sort === 'best_selling' ? 'featured' : (query.sort ?? 'featured');
    const raw = this.prisma.client.raw;
    const where = raw.sql`SELECT p.id, count(*) OVER()::int AS total FROM public.product p JOIN public.category c ON c.id=p."categoryId"
      WHERE p."isPublished"=true AND c."isActive"=true AND p."priceCents" IS NOT NULL
      AND p.sku IS NOT NULL AND length(p.sku) BETWEEN 3 AND 50 AND p.description IS NOT NULL AND length(p.description) BETWEEN 1 AND 2000
      AND length(p.name) BETWEEN 3 AND 160 AND EXISTS (
        SELECT 1 FROM public."productImage" i JOIN public."uploadedAsset" u ON u.id=i."uploadId"
        WHERE i."productId"=p.id AND i."isPrimary"=true AND u.status='ATTACHED' AND u."secureUrl"=i."secureUrl"
      ) AND (${categoryId}='' OR p."categoryId"=${categoryId})
      AND (${search}='' OR (p.name ILIKE ${search} ESCAPE '\\' OR p.description ILIKE ${search} ESCAPE '\\'))
      AND (${hasMin}=false OR p."priceCents">=${min}) AND (${hasMax}=false OR p."priceCents"<=${max})
      AND (${inStock}=false OR p.stock>0)
      ORDER BY CASE WHEN ${sortApplied}='featured' THEN p."isFeatured" END DESC,
        CASE WHEN ${sortApplied} IN ('featured','recent') THEN p."createdAt" END DESC,
        CASE WHEN ${sortApplied}='price_asc' THEN p."priceCents" END ASC,
        CASE WHEN ${sortApplied}='price_desc' THEN p."priceCents" END DESC, p.id ASC
      LIMIT ${query.pageSize} OFFSET ${offset}`.returnsRow({ id: 'pg/text@1', total: 'pg/int4@1' }).build();
    return this.snapshot(async tx => {
      const rows = await tx.query(where);
      // Window count has no row on an out-of-range page; count within the same snapshot.
    const countPlan = raw.sql`SELECT count(*)::int AS total FROM public.product p JOIN public.category c ON c.id=p."categoryId"
      WHERE p."isPublished"=true AND c."isActive"=true AND p."priceCents" IS NOT NULL
      AND p.sku IS NOT NULL AND length(p.sku) BETWEEN 3 AND 50 AND p.description IS NOT NULL AND length(p.description) BETWEEN 1 AND 2000
      AND length(p.name) BETWEEN 3 AND 160 AND EXISTS (
        SELECT 1 FROM public."productImage" i JOIN public."uploadedAsset" u ON u.id=i."uploadId"
        WHERE i."productId"=p.id AND i."isPrimary"=true AND u.status='ATTACHED' AND u."secureUrl"=i."secureUrl"
      ) AND (${categoryId}='' OR p."categoryId"=${categoryId})
      AND (${search}='' OR (p.name ILIKE ${search} ESCAPE '\\' OR p.description ILIKE ${search} ESCAPE '\\'))
      AND (${hasMin}=false OR p."priceCents">=${min}) AND (${hasMax}=false OR p."priceCents"<=${max})
      AND (${inStock}=false OR p.stock>0)`.returnsRow({ total: 'pg/int4@1' }).build();
      const total = rows[0]?.total ?? (await tx.query(countPlan))[0]?.total ?? 0;
      const items = await this.hydrate(tx, rows.map(row => row.id), true);
      return { items: items.filter(item => item !== null), total, page: query.page, pageSize: query.pageSize,
        totalPages: Math.ceil(total / query.pageSize), sortApplied };
    });
  }

  async listAdminProducts(query: AdminCatalogQuery) {
    const offset = safeOffset(query.page, query.pageSize);
    const search = query.search === undefined ? '' : `%${escapeLike(query.search)}%`;
    const categoryId = query.categoryId ?? '';
    const status = query.status ?? 'all';
    const raw = this.prisma.client.raw;
    const plan = raw.sql`SELECT p.id, count(*) OVER()::int AS total FROM public.product p
      WHERE (${categoryId}='' OR p."categoryId"=${categoryId})
      AND (${search}='' OR (p.name ILIKE ${search} ESCAPE '\\' OR p.description ILIKE ${search} ESCAPE '\\' OR p.sku ILIKE ${search} ESCAPE '\\'))
      AND (${status}='all' OR (${status}='published' AND p."isPublished"=true)
        OR (${status}='unpublished' AND p."isPublished"=false) OR (${status}='out_of_stock' AND p.stock=0))
      ORDER BY p."createdAt" DESC, p.id ASC LIMIT ${query.pageSize} OFFSET ${offset}`
      .returnsRow({ id: 'pg/text@1', total: 'pg/int4@1' }).build();
    return this.snapshot(async tx => {
      const rows = await tx.query(plan);
      const count = raw.sql`SELECT count(*)::int AS total FROM public.product p
      WHERE (${categoryId}='' OR p."categoryId"=${categoryId})
      AND (${search}='' OR (p.name ILIKE ${search} ESCAPE '\\' OR p.description ILIKE ${search} ESCAPE '\\' OR p.sku ILIKE ${search} ESCAPE '\\'))
      AND (${status}='all' OR (${status}='published' AND p."isPublished"=true)
        OR (${status}='unpublished' AND p."isPublished"=false) OR (${status}='out_of_stock' AND p.stock=0))`
      .returnsRow({ total: 'pg/int4@1' }).build();
      const total = rows[0]?.total ?? (await tx.query(count))[0]?.total ?? 0;
      return { items: await this.hydrate(tx, rows.map(row => row.id), false), total,
        page: query.page, pageSize: query.pageSize, totalPages: Math.ceil(total / query.pageSize) };
    });
  }

  async createCategory(dto: CreateCategoryDto) {
    try {
      const row = await this.prisma.category.create({ id: randomUUID(), name: dto.name, slug: dto.slug,
        description: dto.description ?? null, isActive: dto.isActive ?? true, sortOrder: dto.sortOrder ?? 0 });
      return this.categoryResponse(row.id);
    } catch (error) {
      if (uniqueViolation(error)) throw shopError(409, 'CATEGORY_ALREADY_EXISTS', 'Category already exists');
      throw error;
    }
  }

  async patchCategory(id: string, dto: PatchCategoryDto) {
    try {
      await this.prisma.client.transaction(async tx => {
        await this.lockCategory(tx, id);
        // Category is always locked before any affected product; sorting prevents inter-product deadlocks.
        if (dto.isActive === false) {
          const products = await tx.orm.public.Product.where({ categoryId: id }).select('id').orderBy(p => p.id.asc()).all();
          for (const product of products) await lockInventoryProduct(tx, this.prisma.client.raw, product.id);
        }
        await tx.orm.public.Category.where({ id }).update({ ...dto, updatedAt: await deliveryClock(tx, this.prisma.client.raw) });
      });
      return this.categoryResponse(id);
    } catch (error) {
      if (uniqueViolation(error)) throw shopError(409, 'CATEGORY_ALREADY_EXISTS', 'Category already exists');
      throw error;
    }
  }

  private async categoryResponse(id: string) {
    const row = await this.prisma.category.where({ id }).first();
    if (!row) throw missingCategory();
    return { id: row.id, name: row.name, slug: row.slug, description: row.description,
      isActive: row.isActive, sortOrder: row.sortOrder,
      createdAt: row.createdAt.toString(), updatedAt: row.updatedAt.toString() };
  }

  async createProduct(dto: CreateCatalogProductDto) {
    const price = centsToLegacyPrice(dto.priceCents);
    const id = randomUUID();
    try {
      await this.prisma.client.transaction(async tx => {
        await this.lockCategory(tx, dto.categoryId);
        // No new product can have a confirmed image yet.
        if (dto.isPublished) throw conflict();
        await tx.orm.public.Product.create({ id, sku: dto.sku, name: dto.name, description: dto.description,
          categoryId: dto.categoryId, priceCents: BigInt(dto.priceCents), price,
          stock: dto.stock, isFeatured: dto.isFeatured ?? false, isPublished: false });
      });
      return this.detail(id, false);
    } catch (error) {
      if (uniqueViolation(error)) throw shopError(409, 'SKU_ALREADY_EXISTS', 'SKU already exists');
      throw error;
    }
  }

  private async modifyProduct(id: string, dto: PatchCatalogProductDto | { isPublished: boolean; priceCents?: never }) {
    // Discover category without locking; under the category lock recheck the product row.
    const previous = await this.prisma.product.where({ id }).select('categoryId').first();
    if (!previous) throw missing();
    const target = 'categoryId' in dto && dto.categoryId !== undefined ? dto.categoryId : previous.categoryId;
    await this.prisma.client.transaction(async tx => {
      if (target) await this.lockCategory(tx, target);
      await lockInventoryProduct(tx, this.prisma.client.raw, id);
      const row = await tx.orm.public.Product.where({ id }).first();
      if (!row) throw missing();
      if (row.categoryId !== previous.categoryId) throw conflict();
      const next = { ...row, ...dto };
      if (next.isPublished) {
        const category = target ? await tx.orm.public.Category.where({ id: target }).first() : null;
        if (!category?.isActive || !next.sku || !next.description || next.description.length < 1 ||
          next.description.length > 2000 || next.name.length < 3 || next.name.length > 160 ||
          (next.priceCents === null && !('priceCents' in dto && dto.priceCents !== undefined))) throw conflict();
        const primary = await tx.orm.public.ProductImage.where({ productId: id, isPrimary: true }).first();
        const upload = primary ? await tx.orm.public.UploadedAsset.where({ id: primary.uploadId }).first() : null;
        if (!primary || upload?.status !== 'ATTACHED' || !upload.secureUrl || primary.secureUrl !== upload.secureUrl) throw conflict();
      }
      const updatedAt = await deliveryClock(tx, this.prisma.client.raw);
      const { priceCents, ...fields } = dto;
      await tx.orm.public.Product.where({ id }).update({ ...fields,
        ...(priceCents === undefined ? {} : { priceCents: BigInt(priceCents), price: centsToLegacyPrice(priceCents) }), updatedAt });
    });
    return this.detail(id, false);
  }

  async patchProduct(id: string, dto: PatchCatalogProductDto) { return this.modifyProduct(id, dto); }
  async publish(id: string, isPublished: boolean) { return this.modifyProduct(id, { isPublished }); }
}
