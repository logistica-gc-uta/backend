import { BadRequestException } from '@nestjs/common';
import type { GeoPoint } from '../routes/algorithms/geo.util.js';

export const PlanningIneligibilityReason = {
  MISSING_DELIVERY_COORDINATES: 'MISSING_DELIVERY_COORDINATES',
  INVALID_DELIVERY_COORDINATES: 'INVALID_DELIVERY_COORDINATES',
  MISSING_ZONE: 'MISSING_ZONE',
  MISSING_ZONE_DEPOT_COORDINATES: 'MISSING_ZONE_DEPOT_COORDINATES',
  INVALID_ZONE_DEPOT_COORDINATES: 'INVALID_ZONE_DEPOT_COORDINATES',
} as const;

export type PlanningIneligibilityReason =
  (typeof PlanningIneligibilityReason)[keyof typeof PlanningIneligibilityReason];

/**
 * Denotes geographic readiness only (destination and depot presence and validity),
 * NOT route assignment, lifecycle or business eligibility.
 */
export interface PlanningEligibility {
  eligible: boolean;
  reasons: PlanningIneligibilityReason[];
}

export function isValidLatitude(lat: unknown): lat is number {
  return typeof lat === 'number' && Number.isFinite(lat) && !Number.isNaN(lat) && lat >= -90 && lat <= 90;
}

export function isValidLongitude(lng: unknown): lng is number {
  return typeof lng === 'number' && Number.isFinite(lng) && !Number.isNaN(lng) && lng >= -180 && lng <= 180;
}

export function toGeoPoint(lat: unknown, lng: unknown): GeoPoint | null {
  if (isValidLatitude(lat) && isValidLongitude(lng)) {
    return { lat, lng };
  }
  return null;
}

export interface ValidatedCoordinatePair {
  lat: number | null;
  lng: number | null;
  hasCoordinates: boolean;
}

/**
 * Validates coordinate pair at the service boundary.
 * - Both omitted (undefined): { lat: null, lng: null, hasCoordinates: false }
 * - Both valid finite numbers in range: { lat, lng, hasCoordinates: true }
 * - Explicit nulls, incomplete pairs, NaN, Infinity, strings or out-of-range: throws BadRequestException
 */
export function validateCoordinatePair(
  lat: unknown,
  lng: unknown,
  context: 'delivery' | 'depot',
): ValidatedCoordinatePair {
  if (lat === undefined && lng === undefined) {
    return { lat: null, lng: null, hasCoordinates: false };
  }

  if (lat === null || lng === null) {
    throw new BadRequestException(
      `Explicit null coordinates are not allowed for ${context} location; omit both or provide valid finite numbers`,
    );
  }

  if (lat === undefined || lng === undefined) {
    throw new BadRequestException(
      `Incomplete coordinate pair for ${context} location; both latitude and longitude must be provided together`,
    );
  }

  if (!isValidLatitude(lat)) {
    throw new BadRequestException(
      `Invalid ${context} latitude: must be a finite number between -90 and 90`,
    );
  }

  if (!isValidLongitude(lng)) {
    throw new BadRequestException(
      `Invalid ${context} longitude: must be a finite number between -180 and 180`,
    );
  }

  return { lat, lng, hasCoordinates: true };
}

export function evaluateCoordinatePairStatus(
  lat: unknown,
  lng: unknown,
): 'valid' | 'missing' | 'invalid' {
  if (lat == null && lng == null) {
    return 'missing';
  }
  if (isValidLatitude(lat) && isValidLongitude(lng)) {
    return 'valid';
  }
  return 'invalid';
}

export function evaluatePlanningEligibility(
  order: { deliveryLat?: number | null; deliveryLng?: number | null },
  zone?: { depotLat?: number | null; depotLng?: number | null } | null,
): { deliveryLocation: GeoPoint | null; planningEligibility: PlanningEligibility } {
  const reasons: PlanningIneligibilityReason[] = [];

  const deliveryStatus = evaluateCoordinatePairStatus(order.deliveryLat, order.deliveryLng);
  if (deliveryStatus === 'missing') {
    reasons.push(PlanningIneligibilityReason.MISSING_DELIVERY_COORDINATES);
  } else if (deliveryStatus === 'invalid') {
    reasons.push(PlanningIneligibilityReason.INVALID_DELIVERY_COORDINATES);
  }

  if (!zone) {
    reasons.push(PlanningIneligibilityReason.MISSING_ZONE);
  } else {
    const depotStatus = evaluateCoordinatePairStatus(zone.depotLat, zone.depotLng);
    if (depotStatus === 'missing') {
      reasons.push(PlanningIneligibilityReason.MISSING_ZONE_DEPOT_COORDINATES);
    } else if (depotStatus === 'invalid') {
      reasons.push(PlanningIneligibilityReason.INVALID_ZONE_DEPOT_COORDINATES);
    }
  }

  const deliveryLocation =
    deliveryStatus === 'valid' && typeof order.deliveryLat === 'number' && typeof order.deliveryLng === 'number'
      ? { lat: order.deliveryLat, lng: order.deliveryLng }
      : null;

  return {
    deliveryLocation,
    planningEligibility: {
      eligible: reasons.length === 0,
      reasons,
    },
  };
}

export function enrichZoneWithGeography<T extends { depotLat?: number | null; depotLng?: number | null }>(
  zone: T,
): T & { depotLocation: GeoPoint | null } {
  return {
    ...zone,
    depotLocation: toGeoPoint(zone.depotLat, zone.depotLng),
  };
}

export function enrichOrderWithGeography<
  T extends {
    deliveryLat?: number | null;
    deliveryLng?: number | null;
    zone?: { depotLat?: number | null; depotLng?: number | null } | null;
  },
>(
  order: T,
): T & {
  deliveryLocation: GeoPoint | null;
  planningEligibility: PlanningEligibility;
} {
  const { deliveryLocation, planningEligibility } = evaluatePlanningEligibility(order, order.zone);
  const enrichedZone = order.zone ? enrichZoneWithGeography(order.zone) : order.zone;
  return {
    ...order,
    ...(order.zone !== undefined ? { zone: enrichedZone } : {}),
    deliveryLocation,
    planningEligibility,
  };
}
