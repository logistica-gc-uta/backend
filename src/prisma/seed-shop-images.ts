import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CloudinaryUploadProvider } from '../modules/shop/uploads/upload-provider.js';
import { buildDemoCatalog } from './shop-demo/dataset.js';
import {
  IMAGE_MANIFEST_VERSION,
  parseImageManifest,
  publicIdFor,
  type DemoImageEntry,
  type DemoImageFormat,
  type DemoImageManifest,
} from './shop-demo/images-manifest.js';
import { renderGiftPng, type Rgb } from './shop-demo/png.js';

/**
 * Genera una imagen ilustrativa por regalo y la sube a Cloudinary con el mismo proveedor firmado
 * que usa la API. Sin `--upload` solo simula: no toca la red ni el manifiesto.
 * Es reanudable: los SKU que ya figuran en images.json no se vuelven a subir.
 */
const MANIFEST_PATH = fileURLToPath(new URL('./shop-demo/images.json', import.meta.url));
const CATEGORY_COLORS: readonly Rgb[] = [
  [198, 40, 40], [255, 143, 0], [216, 27, 96], [142, 36, 170], [57, 73, 171],
  [2, 136, 209], [0, 137, 123], [67, 160, 71], [121, 85, 72], [84, 110, 122],
];
const FORMATS: readonly string[] = ['jpg', 'png', 'webp'];

async function main() {
  const upload = process.argv.includes('--upload');
  const { categories, products } = buildDemoCatalog();
  const skus = new Set(products.map((p) => p.sku));
  const colorOf = new Map(categories.map((category, index) => [category.slug, CATEGORY_COLORS[index % CATEGORY_COLORS.length]!]));

  const done = new Map<string, DemoImageEntry>();
  let cloudName = process.env['CLOUDINARY_CLOUD_NAME'] ?? '';
  if (existsSync(MANIFEST_PATH)) {
    const previous = parseImageManifest(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')), skus);
    for (const entry of previous.entries) done.set(entry.sku, entry);
    cloudName = previous.cloudName;
  }
  const pending = products.filter((product) => !done.has(product.sku));
  console.log(`Regalos: ${products.length}. Con imagen en el manifiesto: ${done.size}. Pendientes: ${pending.length}.`);

  if (!upload) {
    console.log('Simulación (sin --upload): no se sube nada. Ejecuta con --upload para subir las pendientes.');
    return;
  }
  for (const name of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) {
    if (!process.env[name]) throw new Error(`Falta ${name} en el .env local`);
  }
  if (done.size > 0 && cloudName !== process.env['CLOUDINARY_CLOUD_NAME']) {
    throw new Error('El manifiesto pertenece a otra cuenta de Cloudinary; bórralo o usa la cuenta correcta');
  }
  cloudName = process.env['CLOUDINARY_CLOUD_NAME']!;

  const provider = new CloudinaryUploadProvider();
  const save = () => {
    const entries = products.flatMap((product) => done.get(product.sku) ?? []);
    const manifest: DemoImageManifest = { version: IMAGE_MANIFEST_VERSION, cloudName, generatedAt: new Date().toISOString(), entries };
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  };

  let uploaded = 0;
  for (const product of pending) {
    const png = renderGiftPng(product.sku, colorOf.get(product.categorySlug)!);
    const result = await provider.upload(png, publicIdFor(product.sku));
    if (!FORMATS.includes(result.format)) throw new Error(`Formato inesperado de Cloudinary para ${product.sku}`);
    done.set(product.sku, {
      sku: product.sku,
      publicId: result.publicId,
      secureUrl: result.secureUrl,
      format: result.format as DemoImageFormat,
      bytes: result.bytes,
      width: result.width,
      height: result.height,
      altText: `Regalo: ${product.name}`.slice(0, 160),
    });
    uploaded++;
    if (uploaded % 10 === 0) {
      save(); // guarda el avance: si algo falla se reanuda sin repetir lo ya subido
      console.log(`  ${uploaded}/${pending.length} subidas`);
    }
  }
  save();
  console.log(`Listo: ${uploaded} imágenes subidas; manifiesto con ${done.size} entradas.`);
}

main().catch((error) => {
  // Solo el mensaje: nunca se imprimen credenciales ni el objeto de error completo.
  console.error('Error al subir las imágenes:', error instanceof Error ? error.message : 'desconocido');
  process.exitCode = 1;
});
