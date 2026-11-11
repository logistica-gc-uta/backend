import { HttpStatus } from '@nestjs/common';
import { shopError } from '../shop/shop-http.filter.js';
import { StoreCoverageService } from '../store-coverage/store-coverage.service.js';

export async function assertDeliveryCovered(
  storeCoverage: StoreCoverageService,
  lat: number,
  lng: number,
): Promise<void> {
  const result = await storeCoverage.evaluatePoint({ lat, lng });
  if (!result.accepted) {
    throw shopError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'DELIVERY_OUTSIDE_COVERAGE',
      'Delivery point is outside the configured store coverage',
      { position: result.position },
    );
  }
}
