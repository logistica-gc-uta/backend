import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { PrismaService } from '../../../database/prisma.service.js';
import { deliveryClock } from '../../orders/order-delivery.util.js';
import { shopError } from '../shop-http.filter.js';
import { AttachImageDto, PatchImageDto } from './uploads.dto.js';
import { UPLOAD_PROVIDER, type UploadProvider, type ProviderUpload } from './upload-provider.js';

type Client = PrismaService['client'];
type Transaction = Parameters<Parameters<Client['transaction']>[0]>[0];
const DAY_MS = 86_400_000;
const LEASE_MS = 300_000;
const MAX_BYTES = 5 * 1024 * 1024;
const association = () => shopError(422, 'IMAGE_ASSOCIATION_FAILED', 'Image cannot be associated');
const missing = () => shopError(404, 'PRODUCT_NOT_FOUND', 'Product or image not found');

async function lockRow(tx: Transaction, raw: Client['raw'], table: 'product' | 'uploadedAsset', id: string) {
  // Identifiers are fixed, never interpolated from HTTP input.
  const plan = table === 'product'
    ? raw.sql`SELECT id FROM public.product WHERE id = ${id} FOR UPDATE`.returnsRow({ id: 'pg/text@1' }).build()
    : raw.sql`SELECT id FROM public."uploadedAsset" WHERE id = ${id} FOR UPDATE`.returnsRow({ id: 'pg/text@1' }).build();
  return (await tx.query(plan)).length !== 0;
}

function urlIsTrusted(url: unknown, publicId: string, cloud: string): url is string {
  if (typeof url !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(cloud)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'res.cloudinary.com' && !parsed.username && !parsed.password && !parsed.port && !parsed.search && !parsed.hash &&
      parsed.pathname.startsWith(`/${cloud}/image/upload/`) &&
      /^\/[a-zA-Z0-9_-]+\/image\/upload\/(?:v[0-9]+\/)?regalia\/products\/[0-9a-f-]{36}\.(?:jpg|jpeg|png|webp)$/.test(parsed.pathname) &&
      parsed.pathname.includes(`/regalia/products/${publicId.split('/').at(-1)}.`);
  } catch { return false; }
}

function imageResponse(row: { id: string; publicId: string; secureUrl: string; altText: string; position: number; isPrimary: boolean }) {
  return { id: row.id, secureUrl: row.secureUrl, publicId: row.publicId, altText: row.altText, position: row.position, isPrimary: row.isPrimary };
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  constructor(private readonly prisma: PrismaService, @Inject(UPLOAD_PROVIDER) private readonly provider: UploadProvider) {}

  private async decode(file: { buffer?: Buffer; size?: number; mimetype?: string } | undefined) {
    if (!file) throw shopError(400, 'VALIDATION_ERROR', 'Multipart file is required');
    if (!file.buffer || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) throw shopError(415, 'IMAGE_UNSUPPORTED', 'Unsupported image content');
    if (file.buffer.length > MAX_BYTES) throw shopError(413, 'IMAGE_TOO_LARGE', 'Image exceeds 5 MiB');
    try {
      const decoder = sharp(file.buffer, { limitInputPixels: 8192 * 8192, failOn: 'warning', sequentialRead: true });
      const meta = await decoder.metadata();
      const format = meta.format === 'jpeg' ? 'jpg' : meta.format;
      if (!['jpg', 'png', 'webp'].includes(format ?? '') || !meta.width || !meta.height || meta.width > 8192 || meta.height > 8192 ||
        file.mimetype !== ({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as Record<string, string>)[format!]) {
        throw shopError(415, 'IMAGE_UNSUPPORTED', 'Unsupported image content');
      }
      // Full decode, not header sniffing: reject truncated streams and decompression errors.
      await decoder.stats();
      return { format: format!, bytes: file.buffer.length, width: meta.width, height: meta.height };
    } catch { throw shopError(415, 'IMAGE_UNSUPPORTED', 'Unsupported image content'); }
  }

  private verified(result: ProviderUpload, publicId: string, local: { format: string; bytes: number; width: number; height: number }, cloud: string) {
    return result?.publicId === publicId && result.format === local.format && result.bytes === local.bytes &&
      result.width === local.width && result.height === local.height && urlIsTrusted(result.secureUrl, publicId, cloud);
  }

  async upload(file: { buffer?: Buffer; size?: number; mimetype?: string } | undefined, actorId: string) {
    const local = await this.decode(file);
    const cloud = process.env.CLOUDINARY_CLOUD_NAME;
    if (!cloud || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET || !/^[a-zA-Z0-9_-]+$/.test(cloud)) {
      throw shopError(502, 'UPLOAD_FAILED', 'Image upload unavailable');
    }
    const publicId = `regalia/products/${randomUUID()}`;
    const id = randomUUID();
    try {
      await this.prisma.client.transaction(async tx => {
        const now = await deliveryClock(tx, this.prisma.client.raw);
        await tx.orm.public.UploadedAsset.create({ id, actorId, publicId, secureUrl: null, status: 'UPLOADING',
          ...local, expiresAt: now.add({ milliseconds: DAY_MS }) });
      });
    } catch { throw shopError(500, 'INTERNAL_ERROR', 'Image upload unavailable'); }
    try {
      const remote = await this.provider.upload(file!.buffer!, publicId);
      if (!this.verified(remote, publicId, local, cloud)) throw new Error('Unverified provider response');
      await this.prisma.client.transaction(async tx => {
        if (!await lockRow(tx, this.prisma.client.raw, 'uploadedAsset', id)) throw new Error('Reservation unavailable');
        const record = await tx.orm.public.UploadedAsset.first({ id });
        if (record?.status !== 'UPLOADING') throw new Error('Reservation no longer available');
        await tx.orm.public.UploadedAsset.where({ id }).update({ secureUrl: remote.secureUrl, status: 'UPLOADED' });
      });
      return { uploadId: id, secureUrl: remote.secureUrl, publicId, ...local, status: 'UPLOADED' as const };
    } catch {
      // The UPLOADING reservation is durable even when Cloudinary succeeded but the DB acknowledgement failed.
      this.logger.warn('Upload pending reconciliation; reserved asset remains for cleanup');
      throw shopError(502, 'UPLOAD_FAILED', 'Image upload failed');
    }
  }

  async attach(productId: string, actorId: string, dto: AttachImageDto) {
    try {
      return await this.prisma.client.transaction(async tx => {
        if (!await lockRow(tx, this.prisma.client.raw, 'product', productId)) throw missing();
        if (!await lockRow(tx, this.prisma.client.raw, 'uploadedAsset', dto.uploadId)) throw association();
        const now = await deliveryClock(tx, this.prisma.client.raw);
        const upload = await tx.orm.public.UploadedAsset.first({ id: dto.uploadId });
        if (!upload || upload.actorId !== actorId || upload.status !== 'UPLOADED' || !upload.secureUrl ||
          Temporal.Instant.compare(upload.expiresAt, now) <= 0 || upload.attachedAt !== null) throw association();
        const images = await tx.orm.public.ProductImage.where({ productId }).all();
        if (images.length >= 6 || images.some(i => i.position === dto.position) ||
          (dto.isPrimary && images.some(i => i.isPrimary))) throw association();
        const image = await tx.orm.public.ProductImage.create({ id: randomUUID(), productId, uploadId: upload.id,
          publicId: upload.publicId, secureUrl: upload.secureUrl, altText: dto.altText, position: dto.position, isPrimary: dto.isPrimary });
        await tx.orm.public.UploadedAsset.where({ id: upload.id }).update({ status: 'ATTACHED', attachedAt: now });
        await tx.orm.public.Product.where({ id: productId }).update({ updatedAt: now });
        return imageResponse(image);
      });
    } catch (error) { if (error instanceof Error && 'getStatus' in error) throw error; throw association(); }
  }

  async patch(productId: string, imageId: string, dto: PatchImageDto) {
    if (!Object.keys(dto).length) throw shopError(400, 'VALIDATION_ERROR', 'No image changes supplied');
    try {
      return await this.prisma.client.transaction(async tx => {
        if (!await lockRow(tx, this.prisma.client.raw, 'product', productId)) throw missing();
        const product = await tx.orm.public.Product.first({ id: productId });
        const images = await tx.orm.public.ProductImage.where({ productId }).all();
        const image = images.find(i => i.id === imageId);
        if (!image) throw missing();
        const primary = dto.isPrimary ?? image.isPrimary;
        if (product?.isPublished && image.isPrimary && !primary && !images.some(i => i.id !== imageId && i.isPrimary)) throw association();
        const target = dto.position ?? image.position;
        const occupied = images.find(i => i.position === target && i.id !== imageId);
        const previousPrimary = primary && !image.isPrimary ? images.find(i => i.isPrimary) : undefined;
        if (product?.isPublished && primary && !image.isPrimary) {
          const upload = await tx.orm.public.UploadedAsset.where({ id: image.uploadId }).first();
          if (upload?.status !== 'ATTACHED' || !upload.secureUrl || upload.secureUrl !== image.secureUrl) throw association();
        }
        let updated;
        if (occupied || previousPrimary) {
          // Immediate unique (position, primary) indexes disallow two direct UPDATEs.
          // Delete/reinsert affected rows with identical IDs/upload links under the product lock.
          const affected = [...new Map([image, occupied, previousPrimary].filter(i => i !== undefined).map(i => [i!.id, i!])).values()];
          for (const row of affected) await tx.orm.public.ProductImage.where({ id: row.id }).delete();
          for (const row of affected) {
            const newPosition = row.id === imageId ? target : row.id === occupied?.id ? image.position : row.position;
            const newPrimary = row.id === imageId ? primary : row.id === previousPrimary?.id ? false : row.isPrimary;
            const created = await tx.orm.public.ProductImage.create({ id: row.id, productId, uploadId: row.uploadId,
              publicId: row.publicId, secureUrl: row.secureUrl, altText: row.id === imageId ? dto.altText ?? row.altText : row.altText,
              position: newPosition, isPrimary: newPrimary });
            if (row.id === imageId) updated = created;
          }
        } else {
          updated = await tx.orm.public.ProductImage.where({ id: imageId }).update({ altText: dto.altText ?? image.altText, position: target, isPrimary: primary });
        }
        const now = await deliveryClock(tx, this.prisma.client.raw);
        await tx.orm.public.Product.where({ id: productId }).update({ updatedAt: now });
        return imageResponse(updated!);
      });
    } catch (error) { if (error instanceof Error && 'getStatus' in error) throw error; throw association(); }
  }

  async detach(productId: string, imageId: string) {
    try {
      await this.prisma.client.transaction(async tx => {
        if (!await lockRow(tx, this.prisma.client.raw, 'product', productId)) throw missing();
        const product = await tx.orm.public.Product.first({ id: productId });
        const image = await tx.orm.public.ProductImage.where({ id: imageId, productId }).first();
        if (!image) throw missing();
        if (product?.isPublished && image.isPrimary) throw association();
        const now = await deliveryClock(tx, this.prisma.client.raw);
        await tx.orm.public.ProductImage.where({ id: imageId }).delete();
        // ATTACHED assets are never recycled. Cleanup gets a committed orphan only.
        await tx.orm.public.UploadedAsset.where({ id: image.uploadId }).update({ status: 'CLEANUP_PENDING', cleanupAt: now });
        await tx.orm.public.Product.where({ id: productId }).update({ updatedAt: now });
      });
    } catch (error) { if (error instanceof Error && 'getStatus' in error) throw error; throw association(); }
  }

  /** One committed upload-row-only claim; external network work happens after transaction release. */
  async cleanupOnce(): Promise<boolean> {
    const claimed = await this.prisma.client.transaction(async tx => {
      const plan = this.prisma.client.raw.sql`SELECT id FROM public."uploadedAsset"
        WHERE ((status IN ('UPLOADING', 'UPLOADED') AND "expiresAt" <= clock_timestamp())
          OR (status = 'CLEANUP_PENDING' AND "cleanupAt" <= clock_timestamp()))
        ORDER BY "expiresAt", id LIMIT 1 FOR UPDATE SKIP LOCKED`
        .returnsRow({ id: 'pg/text@1' }).build();
      const [candidate] = await tx.query(plan);
      if (!candidate) return null;
      const asset = await tx.orm.public.UploadedAsset.first({ id: candidate.id });
      if (!asset) return null;
      const image = await tx.orm.public.ProductImage.where({ uploadId: asset.id }).first();
      if (image) return null;
      const now = await deliveryClock(tx, this.prisma.client.raw);
      const lease = now.add({ milliseconds: LEASE_MS });
      await tx.orm.public.UploadedAsset.where({ id: asset.id }).update({ status: 'CLEANUP_PENDING', cleanupAt: lease,
        cleanupAttempts: asset.cleanupAttempts + 1 });
      return { id: asset.id, publicId: asset.publicId, lease };
    });
    if (!claimed) return false;
    const outcome = await this.provider.destroy(claimed.publicId);
    await this.prisma.client.transaction(async tx => {
      if (!await lockRow(tx, this.prisma.client.raw, 'uploadedAsset', claimed.id)) return;
      const row = await tx.orm.public.UploadedAsset.first({ id: claimed.id });
      if (row?.status !== 'CLEANUP_PENDING' || Temporal.Instant.compare(row.cleanupAt!, claimed.lease) !== 0) return;
      const image = await tx.orm.public.ProductImage.where({ uploadId: claimed.id }).first();
      if (image) return;
      const now = await deliveryClock(tx, this.prisma.client.raw);
      if (outcome === 'deleted' || outcome === 'not_found') {
        await tx.orm.public.UploadedAsset.where({ id: claimed.id }).update({ status: 'DELETED', cleanupAt: now, lastCleanupError: null });
      } else {
        await tx.orm.public.UploadedAsset.where({ id: claimed.id }).update({ cleanupAt: now.add({ milliseconds: LEASE_MS }), lastCleanupError: 'Provider acknowledgement unavailable' });
      }
    });
    return true;
  }
}
