import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { buildDemoCatalog } from './shop-demo/dataset.js';
import { parseImageManifest } from './shop-demo/images-manifest.js';
import { seedShopDemo } from './shop-demo/seed.js';

const MANIFEST_PATH = fileURLToPath(new URL('./shop-demo/images.json', import.meta.url));

async function main() {
  const { products } = buildDemoCatalog();
  let manifest;
  if (existsSync(MANIFEST_PATH)) {
    manifest = parseImageManifest(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')), new Set(products.map((p) => p.sku)));
    console.log(`Manifiesto de imágenes: ${manifest.entries.length} entradas`);
  } else {
    console.log('Sin manifiesto de imágenes (src/prisma/shop-demo/images.json): los regalos se crean sin publicar.');
  }
  const result = await seedShopDemo(db, { manifest, adminEmail: process.env['SHOP_DEMO_ADMIN_EMAIL'] });
  console.log('Seed del catálogo demo completado:', result);
}

main()
  .catch((error) => {
    console.error('Error en el seed del catálogo demo:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.close());
