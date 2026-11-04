import { inflateSync } from 'node:zlib';
import { renderGiftPng, seedFrom } from './png.js';

describe('imagen ilustrativa de regalo (PNG generado)', () => {
  const png = renderGiftPng('RG-NAV-001', [200, 40, 50]);

  it('es un PNG válido de 600x600', () => {
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(600);
    expect(png.readUInt32BE(20)).toBe(600);
    expect(png.subarray(png.length - 8, png.length - 4).toString('ascii')).toBe('IEND');
  });

  it('el contenido descomprimido tiene exactamente el tamaño de los píxeles', () => {
    const idatLength = png.readUInt32BE(33);
    const data = png.subarray(41, 41 + idatLength);
    expect(inflateSync(data).length).toBe(600 * (600 * 3 + 1));
  });

  it('pesa muy por debajo del límite de 5 MB de la base de datos', () => {
    expect(png.length).toBeLessThan(200_000);
  });

  it('es reproducible por SKU y distinto entre SKU', () => {
    expect(renderGiftPng('RG-NAV-001', [200, 40, 50]).equals(png)).toBe(true);
    expect(renderGiftPng('RG-NAV-002', [200, 40, 50]).equals(png)).toBe(false);
    expect(seedFrom('RG-NAV-001')).toBe(seedFrom('RG-NAV-001'));
  });
});
