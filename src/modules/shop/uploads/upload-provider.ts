import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';

export const UPLOAD_PROVIDER = Symbol('UPLOAD_PROVIDER');
export interface ProviderUpload { publicId: string; secureUrl: string; format: string; bytes: number; width: number; height: number }
export interface UploadProvider {
  upload(bytes: Buffer, publicId: string): Promise<ProviderUpload>;
  destroy(publicId: string): Promise<'deleted' | 'not_found' | 'uncertain'>;
}

/** Cloudinary's signed server-side Upload API; no signatures or credentials leave this process. */
@Injectable()
export class CloudinaryUploadProvider implements UploadProvider {
  private config() {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME;
    const key = process.env.CLOUDINARY_API_KEY;
    const secret = process.env.CLOUDINARY_API_SECRET;
    if (!cloud || !key || !secret || !/^[a-zA-Z0-9_-]+$/.test(cloud)) throw new Error('Cloudinary configuration unavailable');
    return { cloud, key, secret };
  }

  private async request(operation: 'upload' | 'destroy', fields: Record<string, string>, bytes?: Buffer): Promise<Record<string, unknown>> {
    const { cloud, key, secret } = this.config();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signed = { ...fields, timestamp };
    const signature = createHash('sha1').update(Object.entries(signed).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`).join('&') + secret).digest('hex');
    const body = new FormData();
    for (const [k, v] of Object.entries(signed)) body.append(k, v);
    body.append('api_key', key);
    body.append('signature', signature);
    if (bytes) body.append('file', new Blob([new Uint8Array(bytes)]), 'image');
    const response = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/${operation}`, { method: 'POST', body, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('Cloudinary request failed');
    const json: unknown = await response.json();
    if (!json || typeof json !== 'object') throw new Error('Invalid Cloudinary response');
    return json as Record<string, unknown>;
  }

  async upload(bytes: Buffer, publicId: string): Promise<ProviderUpload> {
    const result = await this.request('upload', { public_id: publicId, overwrite: 'false', unique_filename: 'false' }, bytes);
    return { publicId: result.public_id as string, secureUrl: result.secure_url as string, format: result.format as string,
      bytes: result.bytes as number, width: result.width as number, height: result.height as number };
  }

  async destroy(publicId: string): Promise<'deleted' | 'not_found' | 'uncertain'> {
    try {
      const result = await this.request('destroy', { public_id: publicId });
      return result.result === 'ok' ? 'deleted' : result.result === 'not found' ? 'not_found' : 'uncertain';
    } catch { return 'uncertain'; }
  }
}
