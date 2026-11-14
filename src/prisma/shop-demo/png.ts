import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

export type Rgb = readonly [number, number, number];

/** FNV-1a de 32 bits: reparte formas y tonos de forma reproducible a partir del SKU. */
export function seedFrom(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/**
 * Tarjeta ilustrativa de un regalo: degradado vertical del color de su categoría con un círculo
 * "lazo" cuyo tamaño y posición salen del SKU. Es una imagen generada, no una foto del producto.
 */
export function renderGiftPng(sku: string, base: Rgb, size = 600): Buffer {
  const seed = seedFrom(sku);
  const light = mix(base, [255, 255, 255], 0.55);
  const centerX = size * (0.35 + ((seed >>> 4) % 30) / 100);
  const centerY = size * (0.35 + ((seed >>> 12) % 30) / 100);
  const radius = size * (0.14 + ((seed >>> 20) % 12) / 100);
  const accent: Rgb = mix(base, [20, 20, 20], 0.35);

  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    const [gr, gg, gb] = mix(light, base, y / (size - 1));
    for (let x = 0; x < size; x++) {
      const inside = (x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2;
      const [r, g, b] = inside ? accent : [gr, gg, gb];
      const offset = rowStart + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // profundidad de bits
  header[9] = 2; // color verdadero RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
