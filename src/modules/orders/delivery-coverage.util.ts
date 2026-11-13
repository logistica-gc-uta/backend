import { HttpStatus } from '@nestjs/common';
import { shopError } from '../shop/shop-http.filter.js';
import { StoreCoverageService } from '../store-coverage/store-coverage.service.js';

export type StoreCoverageTransaction = Parameters<StoreCoverageService['evaluatePoint']>[1];

export async function assertDeliveryCovered(
  storeCoverage: StoreCoverageService,
  lat: number,
  lng: number,
  tx?: StoreCoverageTransaction,
): Promise<void> {
  const result =
    tx !== undefined
      ? await storeCoverage.evaluatePoint({ lat, lng }, tx)
      : await storeCoverage.evaluatePoint({ lat, lng });
  if (!result.accepted) {
    throw shopError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'DELIVERY_OUTSIDE_COVERAGE',
      'Delivery point is outside the configured store coverage',
      { position: result.position },
    );
  }
}
