/**
 * Manifiesto de las imágenes del catálogo de demostración: qué assets reales de Cloudinary
 * corresponden a cada SKU. El seeder NUNCA inventa URLs ni identificadores: solo adjunta lo
 * que aparece aquí y que haya sido subido de verdad (lo genera `seed:shop-images`).
 */
export const IMAGE_MANIFEST_VERSION = 1;
/** Carpeta de Cloudinary reservada a las imágenes del seed (separa los assets de los reales del negocio). */
export const DEMO_PUBLIC_ID_PREFIX = 'regalia/demo/';

export type DemoImageFormat = 'jpg' | 'png' | 'webp';
const FORMATS: readonly DemoImageFormat[] = ['jpg', 'png', 'webp'];

// Mismos límites que la tabla uploadedAsset.
const MAX_BYTES = 5_242_880;
const MAX_DIMENSION = 8192;

export interface DemoImageEntry {
  sku: string;
  publicId: string;
  secureUrl: string;
  format: DemoImageFormat;
  bytes: number;
  width: number;
  height: number;
  altText: string;
}

export interface DemoImageManifest {
  version: typeof IMAGE_MANIFEST_VERSION;
  cloudName: string;
  generatedAt: string;
  entries: DemoImageEntry[];
}

/** El publicId de un SKU es determinista: dos ejecuciones del script apuntan al mismo asset. */
export const publicIdFor = (sku: string): string => `${DEMO_PUBLIC_ID_PREFIX}${sku.toLowerCase()}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isIntInRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/**
 * Valida un manifiesto leído de disco. Devuelve el manifiesto tipado o lanza un Error con TODOS
 * los problemas encontrados (no solo el primero), para corregirlos de una vez.
 */
export function parseImageManifest(raw: unknown, knownSkus: ReadonlySet<string>): DemoImageManifest {
  const problems: string[] = [];
  if (!isRecord(raw)) throw new Error('El manifiesto de imágenes debe ser un objeto JSON');

  if (raw.version !== IMAGE_MANIFEST_VERSION) problems.push(`version debe ser ${IMAGE_MANIFEST_VERSION}`);
  const cloudName = raw.cloudName;
  if (typeof cloudName !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(cloudName)) problems.push('cloudName inválido');
  if (typeof raw.generatedAt !== 'string' || Number.isNaN(Date.parse(raw.generatedAt))) {
    problems.push('generatedAt debe ser una fecha ISO 8601');
  }
  if (!Array.isArray(raw.entries)) throw new Error(`Manifiesto inválido: ${[...problems, 'entries debe ser un arreglo'].join('; ')}`);

  const skus = new Set<string>();
  const publicIds = new Set<string>();
  const entries: DemoImageEntry[] = [];

  raw.entries.forEach((item: unknown, index: number) => {
    const where = `entries[${index}]`;
    if (!isRecord(item)) {
      problems.push(`${where} debe ser un objeto`);
      return;
    }
    const { sku, publicId, secureUrl, format, bytes, width, height, altText } = item;

    if (typeof sku !== 'string' || !knownSkus.has(sku)) problems.push(`${where}.sku no pertenece al catálogo`);
    else if (skus.has(sku)) problems.push(`${where}.sku repetido (${sku})`);
    else skus.add(sku);

    if (typeof publicId !== 'string' || typeof sku !== 'string' || publicId !== publicIdFor(sku)) {
      problems.push(`${where}.publicId debe ser ${typeof sku === 'string' ? publicIdFor(sku) : 'regalia/demo/<sku>'}`);
    } else if (publicIds.has(publicId)) problems.push(`${where}.publicId repetido`);
    else publicIds.add(publicId);

    if (
      typeof secureUrl !== 'string' ||
      typeof cloudName !== 'string' ||
      typeof publicId !== 'string' ||
      !secureUrl.startsWith(`https://res.cloudinary.com/${cloudName}/image/upload/`) ||
      !secureUrl.includes(publicId)
    ) {
      problems.push(`${where}.secureUrl debe ser una URL https de res.cloudinary.com/${String(cloudName)} que contenga el publicId`);
    }
    if (typeof format !== 'string' || !FORMATS.includes(format as DemoImageFormat)) problems.push(`${where}.format debe ser jpg, png o webp`);
    if (!isIntInRange(bytes, 1, MAX_BYTES)) problems.push(`${where}.bytes fuera de rango (1 a ${MAX_BYTES})`);
    if (!isIntInRange(width, 1, MAX_DIMENSION)) problems.push(`${where}.width fuera de rango (1 a ${MAX_DIMENSION})`);
    if (!isIntInRange(height, 1, MAX_DIMENSION)) problems.push(`${where}.height fuera de rango (1 a ${MAX_DIMENSION})`);
    if (typeof altText !== 'string' || altText.trim().length < 1 || altText.length > 160) problems.push(`${where}.altText debe tener de 1 a 160 caracteres`);

    entries.push(item as unknown as DemoImageEntry);
  });

  if (problems.length > 0) throw new Error(`Manifiesto de imágenes inválido:\n- ${problems.join('\n- ')}`);
  return { version: IMAGE_MANIFEST_VERSION, cloudName: cloudName as string, generatedAt: raw.generatedAt as string, entries };
}
