import {
  classifyPointInCoverage,
  CoverageClassification,
  parseCoveragePolygon,
} from './coverage-geometry.util.js';

/** Axis-aligned test square: lng/lat [0,0]–[10,10], closed GeoJSON ring. */
const square = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
  ],
};

describe('coverage-geometry.util', () => {
  describe('parseCoveragePolygon', () => {
    it('accepts a closed simple GeoJSON Polygon with [lng, lat] positions', () => {
      const ring = parseCoveragePolygon(square);
      expect(ring).toHaveLength(5);
      expect(ring[0]).toEqual({ lng: 0, lat: 0 });
      expect(ring[4]).toEqual({ lng: 0, lat: 0 });
    });

    it('rejects missing type, holes, unclosed rings, and too few positions', () => {
      expect(() => parseCoveragePolygon({ type: 'Point', coordinates: [0, 0] })).toThrow();
      expect(() =>
        parseCoveragePolygon({
          type: 'Polygon',
          coordinates: [
            square.coordinates[0],
            [
              [1, 1],
              [2, 1],
              [2, 2],
              [1, 1],
            ],
          ],
        }),
      ).toThrow();
      expect(() =>
        parseCoveragePolygon({
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 10],
            ],
          ],
        }),
      ).toThrow();
      expect(() =>
        parseCoveragePolygon({
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [0, 0],
            ],
          ],
        }),
      ).toThrow();
    });

    it('rejects out-of-range coordinates and self-intersecting rings', () => {
      expect(() =>
        parseCoveragePolygon({
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [200, 0],
              [200, 1],
              [0, 1],
              [0, 0],
            ],
          ],
        }),
      ).toThrow();
      expect(() =>
        parseCoveragePolygon({
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [10, 10],
              [10, 0],
              [0, 10],
              [0, 0],
            ],
          ],
        }),
      ).toThrow();
    });
  });

  describe('classifyPointInCoverage', () => {
    it('accepts an interior point', () => {
      expect(classifyPointInCoverage({ lat: 5, lng: 5 }, square)).toBe(
        CoverageClassification.INTERIOR,
      );
    });

    it('accepts a point exactly on a boundary segment', () => {
      expect(classifyPointInCoverage({ lat: 0, lng: 5 }, square)).toBe(
        CoverageClassification.BOUNDARY,
      );
    });

    it('accepts a vertex as boundary', () => {
      expect(classifyPointInCoverage({ lat: 0, lng: 0 }, square)).toBe(
        CoverageClassification.BOUNDARY,
      );
    });

    it('rejects an exterior point', () => {
      expect(classifyPointInCoverage({ lat: 5, lng: 15 }, square)).toBe(
        CoverageClassification.EXTERIOR,
      );
    });

    it('does not treat a distant point as boundary of a tiny polygon', () => {
      const tiny = {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1e-9, 0],
            [1e-9, 1e-9],
            [0, 1e-9],
            [0, 0],
          ],
        ],
      };
      expect(classifyPointInCoverage({ lng: 5e-10, lat: -0.0005 }, tiny)).toBe(
        CoverageClassification.EXTERIOR,
      );
    });
  });

  describe('degenerate and oversized rings', () => {
    it('rejects a collinear ring with no area', () => {
      expect(() =>
        parseCoveragePolygon({
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [2, 0],
              [0, 0],
            ],
          ],
        }),
      ).toThrow(/area/i);
    });

    it('accepts a ring at the vertex cap', () => {
      const vertices: number[][] = [];
      for (let i = 0; i < 256; i += 1) {
        const angle = (2 * Math.PI * i) / 256;
        vertices.push([Math.cos(angle), Math.sin(angle)]);
      }
      vertices.push(vertices[0]!);
      expect(parseCoveragePolygon({ type: 'Polygon', coordinates: [vertices] })).toHaveLength(257);
    });

    it('rejects a ring above the vertex cap', () => {
      const vertices: number[][] = [];
      for (let i = 0; i < 257; i += 1) {
        const angle = (2 * Math.PI * i) / 257;
        vertices.push([Math.cos(angle), Math.sin(angle)]);
      }
      vertices.push(vertices[0]!);
      expect(() =>
        parseCoveragePolygon({ type: 'Polygon', coordinates: [vertices] }),
      ).toThrow(/vertex/i);
    });
  });
});
