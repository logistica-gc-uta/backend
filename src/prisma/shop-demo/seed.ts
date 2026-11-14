import { randomUUID } from 'node:crypto';
import { bootstrapSimulatedCards } from '../../modules/shop/checkout/simulated-card.js';
import type { PrismaService } from '../../database/prisma.service.js';
import { buildDemoCatalog } from './dataset.js';
import type { DemoImageManifest } from './images-manifest.js';

type Client = PrismaService['client'];
type Transaction = Parameters<Parameters<Client['transaction']>[0]>[0];

export interface SeedShopDemoOptions {
  /** Imágenes ya subidas a Cloudinary. Sin manifiesto, el catálogo se crea sin publicar. */
  manifest?: DemoImageManifest;
  /** Correo del ADMIN que figura como autor de las imágenes. */
  adminEmail?: string;
}

export interface SeedShopDemoResult {
  categoriesCreated: number;
  productsCreated: number;
  imagesAttached: number;
  productsPublished: number;
  cardsBootstrapped: boolean;
}

export const DEFAULT_ADMIN_EMAIL = 'admin@delivery.com';

/** El simulador de pagos solo existe en test o demo con la bandera explícita (igual que en la API). */
export function cardsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const nodeEnv = (env.NODE_ENV ?? '').trim();
  return (nodeEnv === 'test' || nodeEnv === 'demo') && (env.SIMULATED_PAYMENTS_ENABLED ?? '').trim() === 'true';
}

const affected = (stats: unknown): number =>
  typeof stats === 'number' ? stats : ((stats as { affectedRows?: number } | null)?.affectedRows ?? 0);

/**
 * Siembra el catálogo de demostración de forma idempotente. Todo se identifica por clave natural
 * (slug, SKU, publicId) con ON CONFLICT DO NOTHING: una segunda ejecución no cambia nada y NUNCA
 * pisa precio, stock, estado de publicación ni saldos que alguien haya modificado después.
 */
export async function seedShopDemo(client: Client, options: SeedShopDemoOptions = {}): Promise<SeedShopDemoResult> {
  const { categories, products } = buildDemoCatalog();
  const manifest = options.manifest;
  const result: SeedShopDemoResult = {
    categoriesCreated: 0, productsCreated: 0, imagesAttached: 0, productsPublished: 0, cardsBootstrapped: false,
  };

  await client.transaction(async (tx: Transaction) => {
    for (const category of categories) {
      const plan = client.raw.sql`
        INSERT INTO public.category ("id", "name", "slug", "description", "isActive", "sortOrder", "createdAt", "updatedAt")
        VALUES (${randomUUID()}, ${category.name}, ${category.slug}, ${category.description}, true, ${category.sortOrder},
                clock_timestamp(), clock_timestamp())
        ON CONFLICT DO NOTHING`.affectedCount().build();
      result.categoriesCreated += affected(await tx.execute(plan));
    }

    for (const product of products) {
      const plan = client.raw.sql`
        INSERT INTO public.product ("id", "name", "description", "price", "priceCents", "sku", "categoryId",
                                    "isPublished", "isFeatured", "stock", "createdAt", "updatedAt")
        VALUES (${randomUUID()}, ${product.name}, ${product.description}, ${product.priceCents / 100},
                ${BigInt(product.priceCents)}, ${product.sku},
                (SELECT id FROM public.category WHERE slug = ${product.categorySlug}),
                false, ${product.isFeatured}, ${product.stock}, clock_timestamp(), clock_timestamp())
        ON CONFLICT ("sku") DO NOTHING`.affectedCount().build();
      result.productsCreated += affected(await tx.execute(plan));
    }

    if (manifest && manifest.entries.length > 0) {
      const adminEmail = options.adminEmail ?? DEFAULT_ADMIN_EMAIL;
      const adminRows = await tx.query(
        client.raw.sql`SELECT id FROM public."user" WHERE email = ${adminEmail} AND role = 'ADMIN'`
          .returnsRow({ id: 'pg/text@1' }).build(),
      );
      const actorId = adminRows[0]?.id;
      if (!actorId) throw new Error(`No existe un ADMIN con el correo ${adminEmail}; ejecuta primero "pnpm seed"`);

      for (const entry of manifest.entries) {
        await tx.execute(client.raw.sql`
          INSERT INTO public."uploadedAsset" ("id", "actorId", "publicId", "secureUrl", "format", "bytes", "width", "height",
                                              "status", "expiresAt", "createdAt", "attachedAt")
          SELECT ${randomUUID()}, ${actorId}, ${entry.publicId}, ${entry.secureUrl}, ${entry.format}, ${entry.bytes},
                 ${entry.width}, ${entry.height}, 'ATTACHED', clock_timestamp(), clock_timestamp(), clock_timestamp()
          WHERE EXISTS (SELECT 1 FROM public.product WHERE sku = ${entry.sku})
          ON CONFLICT ("publicId") DO NOTHING`.affectedCount().build());

        // Solo se adjunta si el producto aún no tiene imagen: nunca se reemplaza una elegida por el ADMIN.
        const attached = affected(await tx.execute(client.raw.sql`
          INSERT INTO public."productImage" ("id", "productId", "uploadId", "publicId", "secureUrl", "altText", "position", "isPrimary")
          SELECT ${randomUUID()}, p.id, u.id, u."publicId", u."secureUrl", ${entry.altText}, 0, true
          FROM public.product p JOIN public."uploadedAsset" u ON u."publicId" = ${entry.publicId}
          WHERE p.sku = ${entry.sku} AND u.status = 'ATTACHED'
            AND NOT EXISTS (SELECT 1 FROM public."productImage" i WHERE i."productId" = p.id)
            AND NOT EXISTS (SELECT 1 FROM public."productImage" i WHERE i."uploadId" = u.id)`.affectedCount().build()));
        result.imagesAttached += attached;

        // Se publica únicamente lo que esta ejecución dejó con imagen; lo que un ADMIN despublicó no se toca.
        if (attached > 0) {
          result.productsPublished += affected(await tx.execute(client.raw.sql`
            UPDATE public.product SET "isPublished" = true, "updatedAt" = clock_timestamp()
            WHERE sku = ${entry.sku} AND "isPublished" = false`.affectedCount().build()));
        }
      }
    }
  });

  if (cardsAllowed()) {
    await bootstrapSimulatedCards(client);
    result.cardsBootstrapped = true;
  }
  return result;
}
