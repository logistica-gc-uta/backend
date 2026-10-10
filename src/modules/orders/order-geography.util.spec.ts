import {
  enrichOrderWithGeography,
  enrichZoneWithGeography,
  evaluatePlanningEligibility,
  PlanningIneligibilityReason,
  toGeoPoint,
  validateCoordinatePair,
} from './order-geography.util.js';
import { BadRequestException } from '@nestjs/common';

describe('order-geography.util', () => {
  describe('toGeoPoint and boundaries', () => {
    it('maps valid coordinates including zero and extremes to GeoPoint', () => {
      expect(toGeoPoint(0, 0)).toEqual({ lat: 0, lng: 0 });
      expect(toGeoPoint(-90, -180)).toEqual({ lat: -90, lng: -180 });
      expect(toGeoPoint(90, 180)).toEqual({ lat: 90, lng: 180 });
      expect(toGeoPoint(-1.249, -78.616)).toEqual({ lat: -1.249, lng: -78.616 });
    });

    it('returns null for out-of-range, nonfinite, null, undefined, or strings', () => {
      expect(toGeoPoint(90.1, 0)).toBeNull();
      expect(toGeoPoint(-90.1, 0)).toBeNull();
      expect(toGeoPoint(0, 180.1)).toBeNull();
      expect(toGeoPoint(0, -180.1)).toBeNull();
      expect(toGeoPoint(NaN, 10)).toBeNull();
      expect(toGeoPoint(10, Infinity)).toBeNull();
      expect(toGeoPoint(null, null)).toBeNull();
      expect(toGeoPoint(undefined, undefined)).toBeNull();
      expect(toGeoPoint('0', 0)).toBeNull();
      expect(toGeoPoint(0, '0')).toBeNull();
    });

    it('preserves explicit named lat/lng mapping', () => {
      const point = toGeoPoint(-1.25, -78.62);
      expect(point?.lat).toBe(-1.25);
      expect(point?.lng).toBe(-78.62);
    });
  });

  describe('validateCoordinatePair (service boundary)', () => {
    it('accepts omitted pair (both undefined) as null coordinates', () => {
      expect(validateCoordinatePair(undefined, undefined, 'delivery')).toEqual({
        lat: null,
        lng: null,
        hasCoordinates: false,
      });
    });

    it('accepts valid finite coordinates', () => {
      expect(validateCoordinatePair(-1.2, -78.5, 'delivery')).toEqual({
        lat: -1.2,
        lng: -78.5,
        hasCoordinates: true,
      });
    });

    it('rejects explicit null coordinates with BadRequestException', () => {
      expect(() => validateCoordinatePair(null, null, 'delivery')).toThrow(BadRequestException);
      expect(() => validateCoordinatePair(-1.2, null, 'depot')).toThrow(BadRequestException);
      expect(() => validateCoordinatePair(null, -78.5, 'delivery')).toThrow(BadRequestException);
    });

    it('rejects incomplete pairs (one undefined) with BadRequestException', () => {
      expect(() => validateCoordinatePair(-1.2, undefined, 'delivery')).toThrow(BadRequestException);
      expect(() => validateCoordinatePair(undefined, -78.5, 'depot')).toThrow(BadRequestException);
    });

    it('rejects nonfinite numbers, strings and out-of-range values', () => {
      expect(() => validateCoordinatePair(NaN, 10, 'delivery')).toThrow(BadRequestException);
      expect(() => validateCoordinatePair(10, Infinity, 'depot')).toThrow(BadRequestException);
      expect(() => validateCoordinatePair('10', 20, 'delivery')).toThrow(BadRequestException);
      expect(() => validateCoordinatePair(91, 0, 'delivery')).toThrow(BadRequestException);
      expect(() => validateCoordinatePair(0, 181, 'depot')).toThrow(BadRequestException);
    });
  });

  describe('evaluatePlanningEligibility and reasons', () => {
    it('returns eligible: true when destination and depot are both valid', () => {
      const result = evaluatePlanningEligibility(
        { deliveryLat: -1.25, deliveryLng: -78.62 },
        { depotLat: -1.24, depotLng: -78.61 },
      );
      expect(result.planningEligibility).toEqual({ eligible: true, reasons: [] });
      expect(result.deliveryLocation).toEqual({ lat: -1.25, lng: -78.62 });
    });

    it('reports MISSING_DELIVERY_COORDINATES when order coordinates are null/undefined', () => {
      const result = evaluatePlanningEligibility(
        { deliveryLat: null, deliveryLng: null },
        { depotLat: -1.24, depotLng: -78.61 },
      );
      expect(result.planningEligibility.eligible).toBe(false);
      expect(result.planningEligibility.reasons).toEqual([
        PlanningIneligibilityReason.MISSING_DELIVERY_COORDINATES,
      ]);
      expect(result.deliveryLocation).toBeNull();
    });

    it('reports INVALID_DELIVERY_COORDINATES when order coordinates are partial or out-of-range', () => {
      const result = evaluatePlanningEligibility(
        { deliveryLat: 95, deliveryLng: 0 },
        { depotLat: -1.24, depotLng: -78.61 },
      );
      expect(result.planningEligibility.eligible).toBe(false);
      expect(result.planningEligibility.reasons).toEqual([
        PlanningIneligibilityReason.INVALID_DELIVERY_COORDINATES,
      ]);
    });

    it('reports MISSING_ZONE when order has no zone', () => {
      const result = evaluatePlanningEligibility({ deliveryLat: -1.25, deliveryLng: -78.62 }, null);
      expect(result.planningEligibility.eligible).toBe(false);
      expect(result.planningEligibility.reasons).toEqual([PlanningIneligibilityReason.MISSING_ZONE]);
    });

    it('reports MISSING_ZONE_DEPOT_COORDINATES when zone depot coordinates are null', () => {
      const result = evaluatePlanningEligibility(
        { deliveryLat: -1.25, deliveryLng: -78.62 },
        { depotLat: null, depotLng: null },
      );
      expect(result.planningEligibility.eligible).toBe(false);
      expect(result.planningEligibility.reasons).toEqual([
        PlanningIneligibilityReason.MISSING_ZONE_DEPOT_COORDINATES,
      ]);
    });

    it('reports INVALID_ZONE_DEPOT_COORDINATES when zone depot coordinates are incomplete or invalid', () => {
      const result = evaluatePlanningEligibility(
        { deliveryLat: -1.25, deliveryLng: -78.62 },
        { depotLat: 10, depotLng: null },
      );
      expect(result.planningEligibility.eligible).toBe(false);
      expect(result.planningEligibility.reasons).toEqual([
        PlanningIneligibilityReason.INVALID_ZONE_DEPOT_COORDINATES,
      ]);
    });

    it('combines multiple reasons when both order and depot have defects', () => {
      const result = evaluatePlanningEligibility(
        { deliveryLat: null, deliveryLng: null },
        { depotLat: null, depotLng: null },
      );
      expect(result.planningEligibility.eligible).toBe(false);
      expect(result.planningEligibility.reasons).toEqual([
        PlanningIneligibilityReason.MISSING_DELIVERY_COORDINATES,
        PlanningIneligibilityReason.MISSING_ZONE_DEPOT_COORDINATES,
      ]);
    });
  });

  describe('enrichment helpers', () => {
    it('enriches zone with depotLocation without altering raw fields', () => {
      const zone = { id: 'z1', name: 'Centro', code: 'CEN-01', depotLat: -1.25, depotLng: -78.62 };
      const enriched = enrichZoneWithGeography(zone);
      expect(enriched.depotLocation).toEqual({ lat: -1.25, lng: -78.62 });
      expect(enriched.id).toBe('z1');
      expect(enriched.depotLat).toBe(-1.25);
    });

    it('enriches order with deliveryLocation and planningEligibility preserving raw fields and relations', () => {
      const order = {
        id: 'o1',
        deliveryAddress: 'Av. 123',
        deliveryLat: -1.25,
        deliveryLng: -78.62,
        zone: { id: 'z1', depotLat: -1.24, depotLng: -78.61 },
      };
      const enriched = enrichOrderWithGeography(order);
      expect(enriched.deliveryLocation).toEqual({ lat: -1.25, lng: -78.62 });
      expect(enriched.planningEligibility.eligible).toBe(true);
      expect(enriched.zone?.depotLocation).toEqual({ lat: -1.24, lng: -78.61 });
    });
  });
});
