import { createHash } from 'node:crypto';
import { CloudinaryUploadProvider } from './upload-provider.js';

const previous = {
  cloud: process.env.CLOUDINARY_CLOUD_NAME,
  key: process.env.CLOUDINARY_API_KEY,
  secret: process.env.CLOUDINARY_API_SECRET,
};
const originalFetch = globalThis.fetch;
const restore = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

describe('CloudinaryUploadProvider with a fetch double', () => {
  const fetchDouble = jest.fn();
  beforeEach(() => {
    process.env.CLOUDINARY_CLOUD_NAME = 'fixture';
    process.env.CLOUDINARY_API_KEY = 'fake-key';
    process.env.CLOUDINARY_API_SECRET = 'fake-secret';
    globalThis.fetch = fetchDouble;
    fetchDouble.mockReset();
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
    restore('CLOUDINARY_CLOUD_NAME', previous.cloud);
    restore('CLOUDINARY_API_KEY', previous.key);
    restore('CLOUDINARY_API_SECRET', previous.secret);
  });

  it('signs and posts bytes server-side without putting secrets in the URL or form', async () => {
    const payload = Buffer.from('image bytes');
    const data = { public_id: 'regalia/products/test', secure_url: 'https://res.cloudinary.com/fixture/image/upload/test.png',
      format: 'png', bytes: payload.length, width: 2, height: 2 };
    fetchDouble.mockResolvedValueOnce({ ok: true, json: async () => data });
    expect(await new CloudinaryUploadProvider().upload(payload, data.public_id)).toEqual({ publicId: data.public_id,
      secureUrl: data.secure_url, format: 'png', bytes: payload.length, width: 2, height: 2 });
    const [url, options] = fetchDouble.mock.calls[0] as [string, { body: FormData; method: string; signal: AbortSignal }];
    expect(url).toBe('https://api.cloudinary.com/v1_1/fixture/image/upload');
    expect(options.method).toBe('POST');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.body.get('file')).toBeInstanceOf(Blob);
    expect(options.body.get('api_key')).toBe('fake-key');
    const timestamp = options.body.get('timestamp');
    expect(typeof timestamp).toBe('string');
    const entries = ['overwrite=false', `public_id=${data.public_id}`, 'unique_filename=false', `timestamp=${String(timestamp)}`];
    expect(options.body.get('signature')).toBe(createHash('sha1').update(entries.sort().join('&') + 'fake-secret').digest('hex'));
    expect(url).not.toContain('fake-secret');
    expect([...options.body.keys()]).not.toContain('api_secret');
  });

  it.each([['ok', 'deleted'], ['not found', 'not_found'], ['unexpected', 'uncertain']])('maps destroy acknowledgement %s to %s', async (result, outcome) => {
    fetchDouble.mockResolvedValueOnce({ ok: true, json: async () => ({ result }) });
    expect(await new CloudinaryUploadProvider().destroy('regalia/products/test')).toBe(outcome);
    expect(fetchDouble.mock.calls[0][0]).toBe('https://api.cloudinary.com/v1_1/fixture/image/destroy');
  });

  it('never treats transport failures, non-2xx or malformed responses as successful cleanup', async () => {
    const provider = new CloudinaryUploadProvider();
    fetchDouble.mockRejectedValueOnce(new Error('network failed'));
    fetchDouble.mockResolvedValueOnce({ ok: false });
    fetchDouble.mockResolvedValueOnce({ ok: true, json: async () => null });
    expect(await provider.destroy('regalia/products/test')).toBe('uncertain');
    expect(await provider.destroy('regalia/products/test')).toBe('uncertain');
    expect(await provider.destroy('regalia/products/test')).toBe('uncertain');
  });

  it('refuses absent or malformed configuration before calling fetch', async () => {
    delete process.env.CLOUDINARY_API_SECRET;
    await expect(new CloudinaryUploadProvider().upload(Buffer.from('x'), 'id')).rejects.toThrow('configuration unavailable');
    process.env.CLOUDINARY_API_SECRET = 'fake-secret';
    process.env.CLOUDINARY_CLOUD_NAME = 'bad/cloud';
    await expect(new CloudinaryUploadProvider().upload(Buffer.from('x'), 'id')).rejects.toThrow('configuration unavailable');
    expect(fetchDouble).not.toHaveBeenCalled();
  });
});
