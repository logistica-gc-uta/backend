import sharp from 'sharp';
import { UploadsService } from './uploads.service.js';
import type { UploadProvider } from './upload-provider.js';

const previous = {
  cloud: process.env.CLOUDINARY_CLOUD_NAME,
  key: process.env.CLOUDINARY_API_KEY,
  secret: process.env.CLOUDINARY_API_SECRET,
};
const instant = (n: number) => Temporal.Instant.fromEpochMilliseconds(n);

function fixture() {
  const publicId = 'regalia/products/00000000-0000-4000-8000-000000000001';
  const url = `https://res.cloudinary.com/fixture/image/upload/v1/${publicId}.png`;
  const upload = { id: 'upload', actorId: 'actor', publicId, secureUrl: url, status: 'UPLOADED',
    expiresAt: instant(1000), attachedAt: null, cleanupAt: instant(0), cleanupAttempts: 0, lastCleanupError: null as string | null };
  const product = { id: 'product', isPublished: false };
  const images: Array<{ id: string; productId: string; uploadId: string; publicId: string; secureUrl: string;
    altText: string; position: number; isPrimary: boolean }> = [];
  const query = jest.fn(async (plan: { text: string }) => {
    if (plan.text.includes('clock_timestamp()') && !plan.text.includes('SKIP LOCKED')) return [{ instant: instant(10) }];
    if (plan.text.includes('SKIP LOCKED')) return [{ id: upload.id }];
    return [{ id: 'locked' }];
  });
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join('?'), values,
    returnsRow() { return this; }, build() { return this; },
  });
  const assets = {
    first: jest.fn(async () => upload),
    where: jest.fn(),
    update: jest.fn(async (changes: Record<string, unknown>) => Object.assign(upload, changes)),
    create: jest.fn(async (created: Record<string, unknown>) => Object.assign(upload, created)),
  };
  const imageTable = {
    where: jest.fn(),
    all: jest.fn(async () => [...images]),
    first: jest.fn(async () => images[0]),
    create: jest.fn(async (row: typeof images[number]) => { images.push(row); return row; }),
    delete: jest.fn(async () => { images.splice(0, 1); }),
    update: jest.fn(async (changes: Record<string, unknown>) => Object.assign(images[0], changes)),
  };
  const products = {
    first: jest.fn(async () => product),
    where: jest.fn(),
    update: jest.fn(async () => undefined),
  };
  assets.where.mockReturnValue(assets);
  imageTable.where.mockReturnValue(imageTable);
  products.where.mockReturnValue(products);
  const tx = { query, orm: { public: { UploadedAsset: assets, ProductImage: imageTable, Product: products } } };
  const client = { raw: { sql }, transaction: jest.fn(async (work: (arg: typeof tx) => Promise<unknown>) => work(tx)) };
  const provider: jest.Mocked<UploadProvider> = { upload: jest.fn(), destroy: jest.fn() };
  const service = new UploadsService({ client } as any, provider);
  return { service, provider, client, tx, assets, images, imageTable, product, upload, publicId, url };
}

const restore = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

beforeEach(() => {
  process.env.CLOUDINARY_CLOUD_NAME = 'fixture';
  process.env.CLOUDINARY_API_KEY = 'fake-key';
  process.env.CLOUDINARY_API_SECRET = 'fake-secret';
});
afterAll(() => {
  restore('CLOUDINARY_CLOUD_NAME', previous.cloud);
  restore('CLOUDINARY_API_KEY', previous.key);
  restore('CLOUDINARY_API_SECRET', previous.secret);
});

describe('UploadsService public operations', () => {
  const dto = { uploadId: 'upload', altText: 'Gift', position: 0, isPrimary: true };
  it('reserves before provider upload, verifies metadata, and marks UPLOADED only after acknowledgement', async () => {
    const f = fixture();
    const buffer = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abcdef' } }).png().toBuffer();
    f.provider.upload.mockImplementationOnce(async (_, id) => {
      expect(f.assets.create).toHaveBeenCalledWith(expect.objectContaining({ publicId: id, status: 'UPLOADING', actorId: 'actor' }));
      return { publicId: id, secureUrl: `https://res.cloudinary.com/fixture/image/upload/v1/${id}.png`, format: 'png',
        bytes: buffer.length, width: 2, height: 2 };
    });
    expect(await f.service.upload({ buffer, mimetype: 'image/png' }, 'actor')).toMatchObject({ status: 'UPLOADED',
      format: 'png', width: 2, height: 2, bytes: buffer.length });
    expect(f.assets.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'UPLOADED' }));
  });

  it('keeps reservation for cleanup on provider failure or untrusted metadata', async () => {
    const f = fixture();
    const buffer = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abcdef' } }).png().toBuffer();
    f.provider.upload.mockRejectedValueOnce(new Error('provider failed'));
    await expect(f.service.upload({ buffer, mimetype: 'image/png' }, 'actor')).rejects.toMatchObject({ status: 502 });
    f.provider.upload.mockResolvedValueOnce({ publicId: f.publicId, secureUrl: 'https://evil.test/image.png',
      format: 'png', bytes: buffer.length, width: 2, height: 2 });
    await expect(f.service.upload({ buffer, mimetype: 'image/png' }, 'actor')).rejects.toMatchObject({ status: 502 });
    expect(f.assets.update).not.toHaveBeenCalled();
  });

  it('refuses another actor, expired or already used uploads without creating an image', async () => {
    const f = fixture();
    for (const changes of [{ actorId: 'someone-else' }, { actorId: 'actor', expiresAt: instant(0) },
      { expiresAt: instant(1000), status: 'ATTACHED' }]) {
      Object.assign(f.upload, changes);
      await expect(f.service.attach('product', 'actor', dto)).rejects.toMatchObject({ status: 422 });
    }
    expect(f.imageTable.create).not.toHaveBeenCalled();
  });

  it('attaches once and rejects duplicate primary or occupied gallery position', async () => {
    const f = fixture();
    expect(await f.service.attach('product', 'actor', dto)).toMatchObject({ publicId: f.publicId, altText: 'Gift', isPrimary: true });
    expect(f.upload.status).toBe('ATTACHED');
    expect(f.images).toHaveLength(1);
    Object.assign(f.upload, { status: 'UPLOADED', attachedAt: null });
    await expect(f.service.attach('product', 'actor', dto)).rejects.toMatchObject({ status: 422 });
    expect(f.images).toHaveLength(1);
  });

  it('rejects demotion and removal of the only primary of a published product without mutation', async () => {
    const f = fixture();
    Object.assign(f.product, { isPublished: true });
    f.images.push({ id: 'image', productId: 'product', uploadId: 'upload', publicId: f.publicId,
      secureUrl: f.url, altText: 'Gift', position: 0, isPrimary: true });
    await expect(f.service.patch('product', 'image', { isPrimary: false })).rejects.toMatchObject({ status: 422 });
    await expect(f.service.detach('product', 'image')).rejects.toMatchObject({ status: 422 });
    expect(f.imageTable.delete).not.toHaveBeenCalled();
    expect(f.images[0].isPrimary).toBe(true);
    expect(f.upload.status).toBe('UPLOADED');
  });

  it('defers cleanup after detaching an unpublished image', async () => {
    const f = fixture();
    f.images.push({ id: 'image', productId: 'product', uploadId: 'upload', publicId: f.publicId,
      secureUrl: f.url, altText: 'Gift', position: 0, isPrimary: true });
    await f.service.detach('product', 'image');
    expect(f.images).toHaveLength(0);
    expect(f.upload.status).toBe('CLEANUP_PENDING');
    expect(f.provider.destroy).not.toHaveBeenCalled();
  });

  it('does not call provider for an attached image during cleanup', async () => {
    const f = fixture();
    f.images.push({ id: 'image', productId: 'product', uploadId: 'upload', publicId: f.publicId,
      secureUrl: f.url, altText: 'Gift', position: 0, isPrimary: true });
    expect(await f.service.cleanupOnce()).toBe(false);
    expect(f.provider.destroy).not.toHaveBeenCalled();
  });

  it.each([['deleted', 'DELETED'], ['not_found', 'DELETED'], ['uncertain', 'CLEANUP_PENDING']] as const)(
    'records provider outcome %s as %s and increments cleanup attempts', async (outcome, status) => {
      const f = fixture();
      f.provider.destroy.mockResolvedValueOnce(outcome);
      expect(await f.service.cleanupOnce()).toBe(true);
      expect(f.provider.destroy).toHaveBeenCalledWith(f.publicId);
      expect(f.upload.status).toBe(status);
      expect(f.upload.cleanupAttempts).toBe(1);
      expect(f.upload.lastCleanupError).toBe(outcome === 'uncertain' ? 'Provider acknowledgement unavailable' : null);
    },
  );
});
