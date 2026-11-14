import {
  DEMO_CATEGORY_COUNT,
  DEMO_PRODUCT_COUNT,
  DEMO_PRODUCTS_PER_CATEGORY,
  OUT_OF_STOCK_SKUS,
  buildDemoCatalog,
  skuFor,
  stockFor,
} from './dataset.js';

const { categories, products } = buildDemoCatalog();

describe('catálogo de demostración de regalos', () => {
  it('tiene exactamente 200 regalos en 10 categorías de 20', () => {
    expect(products).toHaveLength(DEMO_PRODUCT_COUNT);
    expect(categories).toHaveLength(DEMO_CATEGORY_COUNT);
    for (const category of categories) {
      expect(products.filter((p) => p.categorySlug === category.slug)).toHaveLength(DEMO_PRODUCTS_PER_CATEGORY);
    }
  });

  it('incluye las categorías temáticas pedidas', () => {
    const slugs = categories.map((c) => c.slug);
    expect(slugs).toEqual(
      expect.arrayContaining(['navidad', 'cumpleanos', 'san-valentin', 'aniversarios', 'graduaciones', 'nacimientos']),
    );
    expect(slugs.length).toBeGreaterThan(6);
  });

  it('la paginación de 12 da 17 páginas y la última tiene 8 (CT-002)', () => {
    expect(Math.ceil(products.length / 12)).toBe(17);
    expect(products.length - 16 * 12).toBe(8);
  });

  it('cada SKU es único, tiene el formato RG-XXX-NNN y respeta el largo del backend (3 a 50)', () => {
    const skus = products.map((p) => p.sku);
    expect(new Set(skus).size).toBe(products.length);
    for (const sku of skus) {
      expect(sku).toMatch(/^RG-[A-Z]{3}-\d{3}$/);
      expect(sku.length).toBeGreaterThanOrEqual(3);
      expect(sku.length).toBeLessThanOrEqual(50);
    }
  });

  it('los nombres son únicos y respetan el largo del contrato (3 a 160)', () => {
    expect(new Set(products.map((p) => p.name.toLowerCase())).size).toBe(products.length);
    for (const { name } of products) {
      expect(name.length).toBeGreaterThanOrEqual(3);
      expect(name.length).toBeLessThanOrEqual(160);
    }
  });

  it('toda descripción está presente, tiene hasta 2000 caracteres y no contiene enlaces', () => {
    for (const { description } of products) {
      expect(description.trim().length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(2000);
      expect(description).not.toMatch(/https?:\/\//i);
    }
  });

  it('los precios son enteros en centavos, positivos y con una variedad razonable', () => {
    for (const { priceCents } of products) {
      expect(Number.isInteger(priceCents)).toBe(true);
      expect(priceCents).toBeGreaterThanOrEqual(100);
      expect(priceCents).toBeLessThanOrEqual(100_000);
    }
    const prices = products.map((p) => p.priceCents);
    expect(Math.min(...prices)).toBeLessThan(1000);
    expect(Math.max(...prices)).toBeGreaterThan(5000);
    expect(new Set(prices).size).toBeGreaterThanOrEqual(40);
  });

  it('las categorías cumplen las restricciones de la base de datos', () => {
    expect(new Set(categories.map((c) => c.slug)).size).toBe(categories.length);
    expect(new Set(categories.map((c) => c.name)).size).toBe(categories.length);
    for (const category of categories) {
      expect(category.name.length).toBeGreaterThanOrEqual(2);
      expect(category.name.length).toBeLessThanOrEqual(80);
      expect(category.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(category.description.length).toBeLessThanOrEqual(300);
      expect(category.sortOrder).toBeGreaterThanOrEqual(0);
      expect(category.sortOrder).toBeLessThanOrEqual(9999);
    }
  });

  it('el stock es variado: agotados exactos, existencias bajas y abundantes', () => {
    const zero = products.filter((p) => p.stock === 0).map((p) => p.sku);
    expect(zero.sort()).toEqual([...OUT_OF_STOCK_SKUS].sort());
    expect(products.filter((p) => p.stock >= 1 && p.stock <= 5).length).toBeGreaterThanOrEqual(8);
    expect(products.filter((p) => p.stock >= 10).length).toBeGreaterThan(120);
    for (const { stock } of products) {
      expect(Number.isInteger(stock)).toBe(true);
      expect(stock).toBeGreaterThanOrEqual(0);
      expect(stock).toBeLessThanOrEqual(120);
    }
  });

  it('el stock de un SKU siempre es el mismo (reproducible)', () => {
    expect(stockFor('RG-NAV-001')).toBe(stockFor('RG-NAV-001'));
    expect(stockFor('RG-NAV-011')).toBe(0);
  });

  it('destaca dos regalos por categoría', () => {
    expect(products.filter((p) => p.isFeatured)).toHaveLength(DEMO_CATEGORY_COUNT * 2);
    for (const category of categories) {
      expect(products.filter((p) => p.categorySlug === category.slug && p.isFeatured)).toHaveLength(2);
    }
  });

  it('construirlo dos veces da exactamente lo mismo', () => {
    expect(buildDemoCatalog()).toEqual({ categories, products });
  });

  it('cada SKU de los agotados existe realmente en el catálogo', () => {
    const skus = new Set(products.map((p) => p.sku));
    for (const sku of OUT_OF_STOCK_SKUS) expect(skus.has(sku)).toBe(true);
    expect(skuFor('NAV', 7)).toBe('RG-NAV-007');
  });
});
