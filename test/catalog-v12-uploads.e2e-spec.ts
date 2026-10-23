import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import sharp from 'sharp';
import request from 'supertest';
import { cleanupOwnedResources, createOwnedDatabase, runPrismaMigrate } from './geolocation-migration.fixtures.js';
import { UPLOAD_PROVIDER, type UploadProvider } from '../src/modules/shop/uploads/upload-provider.js';

jest.setTimeout(240_000);

describe('Catalog upload proxy — isolated owned PostgreSQL, fake provider (NOT provider proof)', () => {
  let app: INestApplication;
  let db: any;
  let admin: string;
  let otherAdmin: string;
  let client: string;
  let driver: string;
  let productId: string;
  let actorId: string;
  const base = '/api/v1/admin/catalog';
  const provider: jest.Mocked<UploadProvider> = {
    upload: jest.fn(), destroy: jest.fn(),
  };
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const error = (body: any, code: string) => expect(body).toEqual({ error: {
    code, message: expect.any(String), details: expect.any(Object), requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
  } });
  const valid = async (format: 'jpeg' | 'png' | 'webp' = 'png') => sharp({ create: {
    width: 2, height: 2, channels: 3, background: '#ff0000',
  } }).toFormat(format).toBuffer();
  const mimetype = (format: string) => format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
  const postFile = (bytes: Buffer, token = admin, mime = 'image/png') => http().post(`${base}/uploads`).set(auth(token))
    .attach('file', bytes, { filename: 'fixture.png', contentType: mime });
  const attach = (uploadId: string, position = 0, isPrimary = false, token = admin, id = productId) =>
    http().post(`${base}/products/${id}/images`).set(auth(token)).send({ uploadId, altText: 'Fixture image', isPrimary, position });
  const uploaded = async (format: 'jpeg' | 'png' | 'webp' = 'png') => {
    const bytes = await valid(format);
    const res = await postFile(bytes, admin, mimetype(format)).expect(201);
    expect(res.body).toEqual({ uploadId: expect.any(String), publicId: expect.stringMatching(/^regalia\/products\//),
      secureUrl: expect.stringMatching(/^https:\/\/res.cloudinary.com\/fixture\/image\/upload\//),
      format: format === 'jpeg' ? 'jpg' : format, bytes: bytes.length, width: 2, height: 2, status: 'UPLOADED' });
    return res.body.uploadId as string;
  };

  beforeAll(async () => {
    const url = createOwnedDatabase(`catalog_upload_${randomUUID().replaceAll('-', '').slice(0, 12)}`);
    runPrismaMigrate(url);
    process.env.DOTENV_CONFIG_PATH = '/dev/null';
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET = randomUUID();
    process.env.CLOUDINARY_CLOUD_NAME = 'fixture';
    process.env.CLOUDINARY_API_KEY = 'fake-key';
    process.env.CLOUDINARY_API_SECRET = 'fake-secret';
    process.env.CATALOG_UPLOAD_CLEANUP_ENABLED = 'false';
    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/database/prisma.service.js');
    const { JwtService } = await import('@nestjs/jwt');
    provider.upload.mockImplementation(async (bytes, publicId) => ({ publicId,
      secureUrl: `https://res.cloudinary.com/fixture/image/upload/v1/${publicId}.png`,
      format: 'png', bytes: bytes.length, width: 2, height: 2 }));
    provider.destroy.mockResolvedValue('deleted');
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(UPLOAD_PROVIDER).useValue(provider).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    db = app.get(PrismaService);
    const jwt = app.get(JwtService);
    for (const role of ['ADMIN', 'ADMIN', 'CLIENT', 'DRIVER'] as const) {
      const id = randomUUID();
      const email = `${role.toLowerCase()}-${id}@example.test`;
      await db.user.create({ id, email, name: 'Fixture', role, password: 'not-a-real-credential' });
      const token = jwt.sign({ sub: id, email, role });
      if (role === 'ADMIN' && !admin) { admin = token; actorId = id; }
      else if (role === 'ADMIN') otherAdmin = token;
      else if (role === 'CLIENT') client = token;
      else driver = token;
    }
    const categoryId = (await http().post(`${base}/categories`).set(auth(admin)).send({ name: 'Images', slug: 'images' }).expect(201)).body.id;
    productId = (await http().post(`${base}/products`).set(auth(admin)).send({
      sku: `SKU-${randomUUID()}`, name: 'Image fixture', description: 'Image fixture description', categoryId, priceCents: 100, stock: 1,
    }).expect(201)).body.id;
  });
  afterAll(async () => { if (app) await app.close(); cleanupOwnedResources(); });

  it('enforces 401/403 for all four mutations without calling the provider', async () => {
    const paths = [{ method: 'post', url: `${base}/uploads`, body: {} },
      { method: 'post', url: `${base}/products/${productId}/images`, body: { uploadId: randomUUID() } },
      { method: 'patch', url: `${base}/products/${productId}/images/${randomUUID()}`, body: { altText: 'New' } },
      { method: 'delete', url: `${base}/products/${productId}/images/${randomUUID()}`, body: {} }] as const;
    provider.upload.mockClear();
    for (const route of paths) {
      error((await (http() as any)[route.method](route.url).send(route.body).expect(401)).body, 'UNAUTHENTICATED');
      for (const token of [client, driver]) {
        error((await (http() as any)[route.method](route.url).set(auth(token)).send(route.body).expect(403)).body, 'FORBIDDEN');
      }
    }
    expect(provider.upload).not.toHaveBeenCalled();
  });

  it('fully decodes JPEG/PNG/WebP and rejects forged, truncated, oversized and decompression-bomb inputs', async () => {
    for (const format of ['jpeg', 'png', 'webp'] as const) {
      const source = await valid(format);
      provider.upload.mockImplementationOnce(async (bytes, publicId) => ({ publicId,
        secureUrl: `https://res.cloudinary.com/fixture/image/upload/v1/${publicId}.${format === 'jpeg' ? 'jpg' : format}`,
        format: format === 'jpeg' ? 'jpg' : format, bytes: bytes.length, width: 2, height: 2 }));
      await postFile(source, admin, mimetype(format)).expect(201);
    }
    const png = await valid();
    for (const bad of [Buffer.from('not png'), png.subarray(0, 24)]) {
      error((await postFile(bad).expect(415)).body, 'IMAGE_UNSUPPORTED');
    }
    error((await postFile(png, admin, 'image/jpeg').expect(415)).body, 'IMAGE_UNSUPPORTED');
    const bomb = await sharp({ create: { width: 8193, height: 1, channels: 3, background: '#fff' } }).png().toBuffer();
    error((await postFile(bomb).expect(415)).body, 'IMAGE_UNSUPPORTED');
    const over = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024 + 1)]);
    error((await postFile(over).expect(413)).body, 'IMAGE_TOO_LARGE');
  });

  it('reserves before network, validates provider metadata and retains uncertain outcomes for cleanup', async () => {
    const bytes = await valid();
    provider.upload.mockImplementationOnce(async (_buffer, publicId) => {
      expect((await db.uploadedAsset.where({ publicId }).first()).status).toBe('UPLOADING');
      throw new Error('provider-secret-should-never-leak');
    });
    const failed = await postFile(bytes).expect(502);
    error(failed.body, 'UPLOAD_FAILED');
    expect(JSON.stringify(failed.body)).not.toContain('provider-secret');
    const pending = await db.uploadedAsset.where({ actorId }).all();
    expect(pending.some((a: any) => a.status === 'UPLOADING' && a.publicId.startsWith('regalia/products/'))).toBe(true);
    provider.upload.mockImplementationOnce(async (buffer, publicId) => ({ publicId: `other/${publicId}`, secureUrl: 'https://attacker.test/x',
      format: 'png', bytes: buffer.length, width: 2, height: 2 }));
    error((await postFile(bytes).expect(502)).body, 'UPLOAD_FAILED');
  });

  it('retains a durable reservation if the provider succeeded but DB acknowledgement fails', async () => {
    const bytes = await valid();
    let reservedId = '';
    let restore: jest.SpyInstance | undefined;
    provider.upload.mockImplementationOnce(async (buffer, publicId) => {
      reservedId = publicId;
      restore = jest.spyOn(db.client, 'transaction').mockRejectedValueOnce(new Error('ack failed'));
      return { publicId, secureUrl: `https://res.cloudinary.com/fixture/image/upload/v1/${publicId}.png`,
        format: 'png', bytes: buffer.length, width: 2, height: 2 };
    });
    try { error((await postFile(bytes).expect(502)).body, 'UPLOAD_FAILED'); }
    finally { restore?.mockRestore(); }
    expect((await db.uploadedAsset.where({ publicId: reservedId }).first()).status).toBe('UPLOADING');
  });

  it('rejects arbitrary, foreign, expired and used uploadId; limits six images and atomically swaps positions/primary', async () => {
    error((await attach(randomUUID()).expect(422)).body, 'IMAGE_ASSOCIATION_FAILED');
    const foreign = await uploaded();
    const other = await db.user.where((u: any) => u.role.eq('ADMIN')).all();
    await db.uploadedAsset.where({ id: foreign }).update({ actorId: other.find((u: any) => u.id !== actorId).id });
    error((await attach(foreign).expect(422)).body, 'IMAGE_ASSOCIATION_FAILED');
    const expired = await uploaded();
    await db.uploadedAsset.where({ id: expired }).update({ expiresAt: Temporal.Instant.from('2000-01-01T00:00:00Z') });
    error((await attach(expired).expect(422)).body, 'IMAGE_ASSOCIATION_FAILED');
    await db.uploadedAsset.where({ id: expired }).update({ expiresAt: Temporal.Now.instant().add({ milliseconds: 86_400_000 }) });
    const ids: string[] = [];
    for (let position = 0; position < 6; position++) {
      const uploadId = await uploaded();
      const image = await attach(uploadId, position, position === 0).expect(201);
      ids.push(image.body.id);
      error((await attach(uploadId, position).expect(422)).body, 'IMAGE_ASSOCIATION_FAILED');
    }
    error((await attach(await uploaded(), 5).expect(422)).body, 'IMAGE_ASSOCIATION_FAILED');
    error((await attach(await uploaded(), 0, true).expect(422)).body, 'IMAGE_ASSOCIATION_FAILED');
    const patched = await http().patch(`${base}/products/${productId}/images/${ids[1]}`).set(auth(admin))
      .send({ position: 0, isPrimary: true, altText: 'New primary' }).expect(200);
    expect(patched.body).toMatchObject({ position: 0, isPrimary: true, altText: 'New primary' });
    const images = await db.productImage.where({ productId }).all();
    expect(images.filter((i: any) => i.isPrimary)).toHaveLength(1);
    expect(new Set(images.map((i: any) => i.position)).size).toBe(6);
    const invalid = await http().patch(`${base}/products/${productId}/images/${ids[1]}`).set(auth(admin)).send({ position: null }).expect(400);
    error(invalid.body, 'VALIDATION_ERROR');
    const unknown = await http().post(`${base}/products/${productId}/images`).set(auth(admin))
      .send({ uploadId: randomUUID(), altText: 'X', position: 1, isPrimary: false, publicId: 'arbitrary' }).expect(400);
    error(unknown.body, 'VALIDATION_ERROR');
    await http().delete(`${base}/products/${productId}/images/${ids[1]}`).set(auth(admin)).expect(204);
    expect(await db.productImage.where({ id: ids[1] }).first()).toBeNull();
  });

  it('atomically protects the published primary while allowing a valid replacement and draft removal', async () => {
    const categoryId = (await http().get(`${base}/categories`).set(auth(admin)).expect(200)).body.items[0].id;
    const id = (await http().post(`${base}/products`).set(auth(admin)).send({
      sku: `SKU-${randomUUID()}`, name: 'Protected gallery', description: 'Complete gallery fixture',
      categoryId, priceCents: 400, stock: 1,
    }).expect(201)).body.id;
    const firstUpload = await uploaded();
    const secondUpload = await uploaded();
    const first = (await attach(firstUpload, 0, true, admin, id).expect(201)).body.id;
    const second = (await attach(secondUpload, 1, false, admin, id).expect(201)).body.id;
    await http().patch(`${base}/products/${id}/publication`).set(auth(admin)).send({ isPublished: true }).expect(200);
    const adminDetail = () => http().get(`${base}/products/${id}`).set(auth(admin)).expect(200);
    const publicDetail = () => http().get(`/api/v1/shop/products/${id}`).expect(200);
    const beforeAdmin = (await adminDetail()).body;
    const beforePublic = (await publicDetail()).body;
    const beforeAssets = await Promise.all([firstUpload, secondUpload].map(async uploadId => {
      const row = await db.uploadedAsset.where({ id: uploadId }).first();
      return { status: row.status, attachedAt: row.attachedAt?.toString(), cleanupAt: row.cleanupAt?.toString() };
    }));
    for (const attempt of [
      () => http().delete(`${base}/products/${id}/images/${first}`).set(auth(admin)),
      () => http().patch(`${base}/products/${id}/images/${first}`).set(auth(admin)).send({ isPrimary: false }),
      () => http().patch(`${base}/products/${id}/images/${first}`).set(auth(admin))
        .send({ altText: 'Should not persist', position: 1, isPrimary: false }),
    ]) {
      error((await attempt().expect(422)).body, 'IMAGE_ASSOCIATION_FAILED');
      expect((await adminDetail()).body).toEqual(beforeAdmin);
      expect((await publicDetail()).body).toEqual(beforePublic);
      const assets = await Promise.all([firstUpload, secondUpload].map(async uploadId => {
        const row = await db.uploadedAsset.where({ id: uploadId }).first();
        return { status: row.status, attachedAt: row.attachedAt?.toString(), cleanupAt: row.cleanupAt?.toString() };
      }));
      expect(assets).toEqual(beforeAssets);
    }
    const promoted = await http().patch(`${base}/products/${id}/images/${second}`).set(auth(admin))
      .send({ isPrimary: true, position: 0, altText: 'Replacement' }).expect(200);
    expect(promoted.body).toMatchObject({ id: second, isPrimary: true, position: 0, altText: 'Replacement' });
    const after = (await adminDetail()).body;
    expect(after.isPublished).toBe(true);
    expect(after.images.filter((image: any) => image.isPrimary).map((image: any) => image.id)).toEqual([second]);
    expect(after.images.map((image: any) => image.position)).toEqual([0, 1]);
    expect((await publicDetail()).body.primaryImageUrl).toBe(promoted.body.secureUrl);
    await http().delete(`${base}/products/${id}/images/${first}`).set(auth(admin)).expect(204);
    expect((await adminDetail()).body).toMatchObject({ isPublished: true, images: [{ id: second, isPrimary: true }] });
    await http().patch(`${base}/products/${id}/publication`).set(auth(admin)).send({ isPublished: false }).expect(200);
    await http().delete(`${base}/products/${id}/images/${second}`).set(auth(admin)).expect(204);
    expect((await adminDetail()).body).toMatchObject({ isPublished: false, images: [], primaryImageUrl: null });
  });

  it('cleanup claims committed orphan before provider, retries uncertainty, never deletes live image', async () => {
    const categoryId = (await http().get(`${base}/categories`).set(auth(admin)).expect(200)).body.items[0].id;
    const cleanupProductId = (await http().post(`${base}/products`).set(auth(admin)).send({
      sku: `SKU-${randomUUID()}`, name: 'Cleanup fixture', description: 'Isolated upload cleanup fixture',
      categoryId, priceCents: 100, stock: 1,
    }).expect(201)).body.id;
    expect((await http().get(`${base}/products/${cleanupProductId}`).set(auth(admin)).expect(200)).body.images).toEqual([]);
    const { UploadsService } = await import('../src/modules/shop/uploads/uploads.service.js');
    const service = app.get(UploadsService);
    const due = await uploaded();
    await db.uploadedAsset.where({ id: due }).update({ expiresAt: Temporal.Instant.from('2000-01-01T00:00:00Z') });
    provider.destroy.mockImplementationOnce(async publicId => {
      expect((await db.uploadedAsset.where({ publicId }).first()).status).toBe('CLEANUP_PENDING');
      return 'uncertain';
    });
    await service.cleanupOnce();
    const pending = await db.uploadedAsset.where({ id: due }).first();
    expect(pending.status).toBe('CLEANUP_PENDING');
    expect(pending.cleanupAttempts).toBe(1);
    error((await attach(due, 0, false, admin, cleanupProductId).expect(422)).body, 'IMAGE_ASSOCIATION_FAILED');
    const live = await uploaded();
    const image = await attach(live, 0, false, admin, cleanupProductId).expect(201);
    await db.uploadedAsset.where({ id: live }).update({ expiresAt: Temporal.Instant.from('2000-01-01T00:00:00Z') });
    const before = provider.destroy.mock.calls.length;
    const attachedBefore = await db.uploadedAsset.where({ id: live }).first();
    await service.cleanupOnce();
    expect((await db.productImage.where({ id: image.body.id }).first()).id).toBe(image.body.id);
    // Other cases may leave eligible orphans; only the attached asset must be protected.
    expect(provider.destroy.mock.calls.slice(before).map(([publicId]) => publicId)).not.toContain(attachedBefore.publicId);
    expect(await db.uploadedAsset.where({ id: live }).first()).toMatchObject({
      status: 'ATTACHED', cleanupAttempts: attachedBefore.cleanupAttempts, cleanupAt: attachedBefore.cleanupAt,
    });
    await db.uploadedAsset.where({ id: due }).update({ cleanupAt: Temporal.Instant.from('2000-01-01T00:00:00Z') });
    provider.destroy.mockResolvedValueOnce('not_found');
    await service.cleanupOnce();
    expect((await db.uploadedAsset.where({ id: due }).first()).status).toBe('DELETED');
  });
});
