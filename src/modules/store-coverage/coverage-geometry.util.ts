import { isValidLatitude, isValidLongitude } from '../orders/order-geography.util.js';

export const CoverageClassification = {
  INTERIOR: 'INTERIOR',
  BOUNDARY: 'BOUNDARY',
  EXTERIOR: 'EXTERIOR',
} as const;

export type CoverageClassification =
  (typeof CoverageClassification)[keyof typeof CoverageClassification];

export interface GeoLngLat {
  lng: number;
  lat: number;
}

export interface GeoLatLng {
  lat: number;
  lng: number;
}

export const MAX_COVERAGE_UNIQUE_VERTICES = 256;
const EPS = 1e-12;

export interface ParseCoverageOptions {
  /** Self-intersection and area checks. Skip on trusted persisted reads. */
  checkTopology?: boolean;
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPS;
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function pointOnSegment(p: GeoLngLat, a: GeoLngLat, b: GeoLngLat): boolean {
  const abx = b.lng - a.lng;
  const aby = b.lat - a.lat;
  const apx = p.lng - a.lng;
  const apy = p.lat - a.lat;
  const lenSq = abx * abx + aby * aby;
  if (lenSq <= EPS * EPS) {
    return nearlyEqual(p.lng, a.lng) && nearlyEqual(p.lat, a.lat);
  }
  const t = (apx * abx + apy * aby) / lenSq;
  if (t < -EPS || t > 1 + EPS) {
    return false;
  }
  const clampedT = Math.min(1, Math.max(0, t));
  const dx = p.lng - (a.lng + clampedT * abx);
  const dy = p.lat - (a.lat + clampedT * aby);
  return dx * dx + dy * dy <= EPS * EPS;
}

function orientation(a: GeoLngLat, b: GeoLngLat, c: GeoLngLat): number {
  return cross(b.lng - a.lng, b.lat - a.lat, c.lng - a.lng, c.lat - a.lat);
}

function onSegmentInclusive(a: GeoLngLat, b: GeoLngLat, c: GeoLngLat): boolean {
  return (
    Math.min(a.lng, b.lng) - EPS <= c.lng &&
    c.lng <= Math.max(a.lng, b.lng) + EPS &&
    Math.min(a.lat, b.lat) - EPS <= c.lat &&
    c.lat <= Math.max(a.lat, b.lat) + EPS
  );
}

function properOrImproperIntersect(a: GeoLngLat, b: GeoLngLat, c: GeoLngLat, d: GeoLngLat): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  if (Math.abs(o1) <= EPS && onSegmentInclusive(a, b, c)) return true;
  if (Math.abs(o2) <= EPS && onSegmentInclusive(a, b, d)) return true;
  if (Math.abs(o3) <= EPS && onSegmentInclusive(c, d, a)) return true;
  if (Math.abs(o4) <= EPS && onSegmentInclusive(c, d, b)) return true;

  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

function sharesEndpoint(a: GeoLngLat, b: GeoLngLat, c: GeoLngLat, d: GeoLngLat): boolean {
  return (
    (nearlyEqual(a.lng, c.lng) && nearlyEqual(a.lat, c.lat)) ||
    (nearlyEqual(a.lng, d.lng) && nearlyEqual(a.lat, d.lat)) ||
    (nearlyEqual(b.lng, c.lng) && nearlyEqual(b.lat, c.lat)) ||
    (nearlyEqual(b.lng, d.lng) && nearlyEqual(b.lat, d.lat))
  );
}

function assertFinitePosition(lng: unknown, lat: unknown): GeoLngLat {
  if (!isValidLongitude(lng) || !isValidLatitude(lat)) {
    throw new Error('Coverage positions must be finite [lng, lat] within WGS84 ranges');
  }
  return { lng, lat };
}

function twiceSignedArea(ring: GeoLngLat[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const a = ring[i];
    const b = ring[i + 1];
    if (!a || !b) {
      throw new Error('Coverage ring is malformed');
    }
    sum += a.lng * b.lat - b.lng * a.lat;
  }
  return sum;
}

function ringExtent(ring: GeoLngLat[]): number {
  let minLng = ring[0]!.lng;
  let maxLng = ring[0]!.lng;
  let minLat = ring[0]!.lat;
  let maxLat = ring[0]!.lat;
  for (const vertex of ring) {
    minLng = Math.min(minLng, vertex.lng);
    maxLng = Math.max(maxLng, vertex.lng);
    minLat = Math.min(minLat, vertex.lat);
    maxLat = Math.max(maxLat, vertex.lat);
  }
  return Math.max(maxLng - minLng, maxLat - minLat, EPS);
}

/**
 * Parses a GeoJSON Polygon: one exterior ring, closed, [lng, lat], no holes.
 * Writes also reject zero-area and self-intersecting rings.
 */
export function parseCoveragePolygon(input: unknown, options: ParseCoverageOptions = {}): GeoLngLat[] {
  const checkTopology = options.checkTopology !== false;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Coverage must be a GeoJSON Polygon object');
  }
  const candidate = input as { type?: unknown; coordinates?: unknown };
  if (candidate.type !== 'Polygon') {
    throw new Error('Coverage type must be Polygon');
  }
  if (!Array.isArray(candidate.coordinates) || candidate.coordinates.length !== 1) {
    throw new Error('Coverage must have exactly one exterior ring and no holes');
  }
  const ringRaw = candidate.coordinates[0];
  if (!Array.isArray(ringRaw) || ringRaw.length < 4) {
    throw new Error('Coverage ring must contain at least four positions including the closing vertex');
  }
  if (ringRaw.length - 1 > MAX_COVERAGE_UNIQUE_VERTICES) {
    throw new Error(`Coverage ring exceeds the ${MAX_COVERAGE_UNIQUE_VERTICES} vertex limit`);
  }

  const ring: GeoLngLat[] = [];
  for (const position of ringRaw) {
    if (!Array.isArray(position) || position.length !== 2) {
      throw new Error('Each coverage position must be [longitude, latitude]');
    }
    ring.push(assertFinitePosition(position[0], position[1]));
  }

  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last || !nearlyEqual(first.lng, last.lng) || !nearlyEqual(first.lat, last.lat)) {
    throw new Error('Coverage ring must be closed (first position equals last)');
  }

  const uniqueCount = ring.length - 1;
  if (uniqueCount < 3) {
    throw new Error('Coverage ring must have at least three distinct vertices');
  }

  const segmentCount = uniqueCount;
  for (let i = 0; i < segmentCount; i += 1) {
    const a = ring[i];
    const b = ring[i + 1];
    if (!a || !b) {
      throw new Error('Coverage ring is malformed');
    }
    if (nearlyEqual(a.lng, b.lng) && nearlyEqual(a.lat, b.lat)) {
      throw new Error('Coverage ring cannot contain zero-length segments');
    }
  }

  if (!checkTopology) {
    return ring;
  }

  const area = Math.abs(twiceSignedArea(ring));
  const extent = ringExtent(ring);
  if (area <= EPS * extent * extent) {
    throw new Error('Coverage ring must enclose a non-zero area');
  }

  for (let i = 0; i < segmentCount; i += 1) {
    const a = ring[i];
    const b = ring[i + 1];
    if (!a || !b) {
      throw new Error('Coverage ring is malformed');
    }
    for (let j = i + 1; j < segmentCount; j += 1) {
      const c = ring[j];
      const d = ring[j + 1];
      if (!c || !d) {
        throw new Error('Coverage ring is malformed');
      }
      const adjacent = j === i + 1 || (i === 0 && j === segmentCount - 1);
      if (adjacent) {
        continue;
      }
      if (sharesEndpoint(a, b, c, d) && !properOrImproperIntersect(a, b, c, d)) {
        continue;
      }
      if (properOrImproperIntersect(a, b, c, d)) {
        throw new Error('Coverage ring must not self-intersect');
      }
    }
  }

  return ring;
}

function rayCrossesEdge(p: GeoLngLat, a: GeoLngLat, b: GeoLngLat): boolean {
  const left = a.lat > p.lat !== b.lat > p.lat;
  if (!left) {
    return false;
  }
  const dy = b.lat - a.lat;
  if (Math.abs(dy) <= EPS) {
    return false;
  }
  const xIntersect = a.lng + ((p.lat - a.lat) * (b.lng - a.lng)) / dy;
  return p.lng < xIntersect;
}

export function classifyPointInCoverage(point: GeoLatLng, coverage: unknown): CoverageClassification {
  if (!isValidLatitude(point.lat) || !isValidLongitude(point.lng)) {
    throw new Error('Point coordinates must be finite WGS84 lat/lng');
  }
  const ring = parseCoveragePolygon(coverage, { checkTopology: false });
  const p: GeoLngLat = { lng: point.lng, lat: point.lat };

  for (let i = 0; i < ring.length - 1; i += 1) {
    const a = ring[i];
    const b = ring[i + 1];
    if (a && b && pointOnSegment(p, a, b)) {
      return CoverageClassification.BOUNDARY;
    }
  }

  let crossings = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const a = ring[i];
    const b = ring[i + 1];
    if (a && b && rayCrossesEdge(p, a, b)) {
      crossings += 1;
    }
  }

  return crossings % 2 === 1 ? CoverageClassification.INTERIOR : CoverageClassification.EXTERIOR;
}

export function coverageToGeoJson(ring: GeoLngLat[]): { type: 'Polygon'; coordinates: number[][][] } {
  return {
    type: 'Polygon',
    coordinates: [ring.map((vertex) => [vertex.lng, vertex.lat])],
  };
}
