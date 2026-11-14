import { GIFT_CATEGORIES } from './gifts.js';

/** Número exacto de regalos del catálogo de demostración (CT-002: 17 páginas de 12, la última con 8). */
export const DEMO_PRODUCT_COUNT = 200;
export const DEMO_CATEGORY_COUNT = 10;
export const DEMO_PRODUCTS_PER_CATEGORY = 20;

export interface DemoCategory {
  name: string;
  slug: string;
  description: string;
  sortOrder: number;
}

export interface DemoProduct {
  /** Clave natural del seed: RG-NAV-001. Es única y nunca cambia. */
  sku: string;
  name: string;
  description: string;
  priceCents: number;
  stock: number;
  categorySlug: string;
  isFeatured: boolean;
}

export interface DemoCatalog {
  categories: DemoCategory[];
  products: DemoProduct[];
}

/** Regalos agotados a propósito (stock 0) para probar CT-003 sin tocar el resto del catálogo. */
export const OUT_OF_STOCK_SKUS: readonly string[] = [
  'RG-NAV-011',
  'RG-NAV-020',
  'RG-CUM-019',
  'RG-VAL-019',
  'RG-ANI-020',
  'RG-GRA-016',
  'RG-NAC-020',
  'RG-MAD-020',
  'RG-PAD-020',
  'RG-AMI-020',
  'RG-AGR-020',
];

/** Cada categoría destaca sus dos primeros regalos. */
const FEATURED_PER_CATEGORY = 2;

/** FNV-1a de 32 bits: pequeño, estable y sin dependencias; solo reparte el stock de forma reproducible. */
function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Stock reproducible por SKU: 0 en los agotados, 1 a 5 en aproximadamente una décima parte
 * (existencias bajas) y 10 a 120 en el resto.
 */
export function stockFor(sku: string): number {
  if (OUT_OF_STOCK_SKUS.includes(sku)) return 0;
  const hash = hash32(sku);
  if (hash % 10 === 0) return 1 + (hash >>> 8) % 5;
  return 10 + (hash >>> 8) % 111;
}

export const skuFor = (code: string, position: number): string => `RG-${code}-${String(position).padStart(3, '0')}`;

/** Construye el catálogo de demostración. Es una función pura: mismas entradas, mismo resultado. */
export function buildDemoCatalog(): DemoCatalog {
  const categories: DemoCategory[] = [];
  const products: DemoProduct[] = [];

  GIFT_CATEGORIES.forEach((source, categoryIndex) => {
    categories.push({
      name: source.name,
      slug: source.slug,
      description: source.description,
      sortOrder: (categoryIndex + 1) * 10,
    });
    source.gifts.forEach(([name, description, priceCents], giftIndex) => {
      const sku = skuFor(source.code, giftIndex + 1);
      products.push({
        sku,
        name,
        description,
        priceCents,
        stock: stockFor(sku),
        categorySlug: source.slug,
        isFeatured: giftIndex < FEATURED_PER_CATEGORY,
      });
    });
  });

  return { categories, products };
}
