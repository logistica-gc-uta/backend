import sharp from 'sharp';
import { UploadsService } from './uploads.service.js';
import type { UploadProvider } from './upload-provider.js';

// Focused seam test: no network/DB, checks reservation ordering and durable tracking.
describe('UploadsService reservation failure boundaries', () => {
  const previous = {
    cloud: process.env.CLOUDINARY_CLOUD_NAME,
    key: process.env.CLOUDINARY_API_KEY,
    secret: process.env.CLOUDINARY_API_SECRET,
  };
  afterAll(() => {
    for (const [key, value] of Object.entries({ CLOUDINARY_CLOUD_NAME: previous.cloud,
      CLOUDINARY_API_KEY: previous.key, CLOUDINARY_API_SECRET: previous.secret })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const image = () => sharp({ create: { width: 1, height: 1, channels: 3, background: '#123456' } }).png().toBuffer();
  const provider: jest.Mocked<UploadProvider> = { upload: jest.fn(), destroy: jest.fn() };
  beforeEach(() => {
    provider.upload.mockReset();
    process.env.CLOUDINARY_CLOUD_NAME = 'fixture';
    process.env.CLOUDINARY_API_KEY = 'placeholder';
    process.env.CLOUDINARY_API_SECRET = 'placeholder';
  });

  it('never calls provider when the durable reservation insert fails', async () => {
    const client = { transaction: jest.fn().mockRejectedValue(new Error('storage unavailable')) };
    const service = new UploadsService({ client } as any, provider);
    await expect(service.upload({ buffer: await image(), mimetype: 'image/png' }, 'actor')).rejects.toMatchObject({ status: 500 });
    expect(client.transaction).toHaveBeenCalledTimes(1);
    expect(provider.upload).not.toHaveBeenCalled();
  });

  it('refuses provider requests when configuration is incomplete', async () => {
    delete process.env.CLOUDINARY_API_KEY;
    const client = { transaction: jest.fn() };
    const service = new UploadsService({ client } as any, provider);
    await expect(service.upload({ buffer: await image(), mimetype: 'image/png' }, 'actor')).rejects.toMatchObject({ status: 502 });
    expect(client.transaction).not.toHaveBeenCalled();
    expect(provider.upload).not.toHaveBeenCalled();
  });

  it('rejects missing, oversized, malformed and mislabeled payloads before any reservation', async () => {
    const client = { transaction: jest.fn() };
    const service = new UploadsService({ client } as any, provider);
    for (const [file, status] of [
      [undefined, 400],
      [{ buffer: Buffer.alloc(0), mimetype: 'image/png' }, 415],
      [{ buffer: Buffer.alloc(5 * 1024 * 1024 + 1), mimetype: 'image/png' }, 413],
      [{ buffer: Buffer.from('not an image'), mimetype: 'image/png' }, 415],
      [{ buffer: await image(), mimetype: 'image/jpeg' }, 415],
    ] as const) {
      await expect(service.upload(file, 'actor')).rejects.toMatchObject({ status });
    }
    expect(client.transaction).not.toHaveBeenCalled();
    expect(provider.upload).not.toHaveBeenCalled();
  });
});
