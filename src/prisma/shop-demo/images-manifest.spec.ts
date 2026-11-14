import { DEMO_PUBLIC_ID_PREFIX, parseImageManifest, publicIdFor } from './images-manifest.js';

const SKUS = new Set(['RG-NAV-001', 'RG-NAV-002', 'RG-CUM-001']);

const entry = (sku: string, overrides: Record<string, unknown> = {}) => ({
  sku,
  publicId: publicIdFor(sku),
  secureUrl: `https://res.cloudinary.com/demo-cloud/image/upload/v1/${publicIdFor(sku)}.png`,
  format: 'png',
  bytes: 4096,
  width: 800,
  height: 800,
  altText: `Foto de ${sku}`,
  ...overrides,
});

const manifest = (entries: unknown[], overrides: Record<string, unknown> = {}) => ({
  version: 1,
  cloudName: 'demo-cloud',
  generatedAt: '2026-11-04T15:00:00Z',
  entries,
  ...overrides,
});

describe('manifiesto de imágenes del catálogo demo', () => {
  it('acepta un manifiesto válido y lo devuelve tipado', () => {
    const parsed = parseImageManifest(manifest([entry('RG-NAV-001'), entry('RG-CUM-001', { format: 'webp' })]), SKUS);

    expect(parsed.entries.map((e) => e.sku)).toEqual(['RG-NAV-001', 'RG-CUM-001']);
    expect(parsed.cloudName).toBe('demo-cloud');
  });

  it('el publicId es determinista y vive bajo regalia/demo/', () => {
    expect(publicIdFor('RG-NAV-001')).toBe('regalia/demo/rg-nav-001');
    expect(publicIdFor('RG-NAV-001').startsWith(DEMO_PUBLIC_ID_PREFIX)).toBe(true);
  });

  it('acepta un manifiesto sin entradas', () => {
    expect(parseImageManifest(manifest([]), SKUS).entries).toEqual([]);
  });

  it.each([
    ['no es un objeto', 'texto'],
    ['es un arreglo', []],
    ['es null', null],
  ])('rechaza un manifiesto que %s', (_label, value) => {
    expect(() => parseImageManifest(value, SKUS)).toThrow('objeto JSON');
  });

  it('rechaza una versión desconocida y un cloudName inválido', () => {
    expect(() => parseImageManifest(manifest([], { version: 2 }), SKUS)).toThrow('version debe ser 1');
    expect(() => parseImageManifest(manifest([], { cloudName: 'mal nombre!' }), SKUS)).toThrow('cloudName inválido');
  });

  it('rechaza un SKU que no pertenece al catálogo y SKU repetidos', () => {
    expect(() => parseImageManifest(manifest([entry('RG-XXX-999')]), SKUS)).toThrow('no pertenece al catálogo');
    expect(() => parseImageManifest(manifest([entry('RG-NAV-001'), entry('RG-NAV-001')]), SKUS)).toThrow('sku repetido');
  });

  it('rechaza un publicId que no es el determinista del SKU', () => {
    expect(() => parseImageManifest(manifest([entry('RG-NAV-001', { publicId: 'otra/cosa' })]), SKUS)).toThrow('publicId debe ser regalia/demo/rg-nav-001');
  });

  it.each([
    ['http en lugar de https', 'http://res.cloudinary.com/demo-cloud/image/upload/v1/regalia/demo/rg-nav-001.png'],
    ['otro dominio', 'https://example.com/demo-cloud/image/upload/v1/regalia/demo/rg-nav-001.png'],
    ['otra cuenta de Cloudinary', 'https://res.cloudinary.com/otra-cuenta/image/upload/v1/regalia/demo/rg-nav-001.png'],
    ['no contiene el publicId', 'https://res.cloudinary.com/demo-cloud/image/upload/v1/otra-imagen.png'],
  ])('rechaza una secureUrl con %s', (_label, secureUrl) => {
    expect(() => parseImageManifest(manifest([entry('RG-NAV-001', { secureUrl })]), SKUS)).toThrow('secureUrl');
  });

  it('rechaza formatos, pesos y dimensiones fuera de los límites de la base de datos', () => {
    expect(() => parseImageManifest(manifest([entry('RG-NAV-001', { format: 'svg' })]), SKUS)).toThrow('format');
    expect(() => parseImageManifest(manifest([entry('RG-NAV-001', { bytes: 0 })]), SKUS)).toThrow('bytes');
    expect(() => parseImageManifest(manifest([entry('RG-NAV-001', { bytes: 5_242_881 })]), SKUS)).toThrow('bytes');
    expect(() => parseImageManifest(manifest([entry('RG-NAV-001', { width: 8193 })]), SKUS)).toThrow('width');
    expect(() => parseImageManifest(manifest([entry('RG-NAV-001', { height: 1.5 })]), SKUS)).toThrow('height');
  });

  it('rechaza un texto alternativo vacío o demasiado largo', () => {
    expect(() => parseImageManifest(manifest([entry('RG-NAV-001', { altText: '   ' })]), SKUS)).toThrow('altText');
    expect(() => parseImageManifest(manifest([entry('RG-NAV-001', { altText: 'a'.repeat(161) })]), SKUS)).toThrow('altText');
  });

  it('informa todos los problemas a la vez, no solo el primero', () => {
    const bad = manifest([entry('RG-XXX-999', { bytes: 0 }), entry('RG-NAV-001', { format: 'gif' })]);

    let message = '';
    try {
      parseImageManifest(bad, SKUS);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('no pertenece al catálogo');
    expect(message).toContain('bytes');
    expect(message).toContain('format');
  });

  it('rechaza entradas que no son objetos y un entries que no es un arreglo', () => {
    expect(() => parseImageManifest(manifest(['texto']), SKUS)).toThrow('debe ser un objeto');
    expect(() => parseImageManifest(manifest([], { entries: {} }), SKUS)).toThrow('entries debe ser un arreglo');
  });
});
