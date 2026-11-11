import { HttpException, HttpStatus } from '@nestjs/common';
import { assertDeliveryCovered } from './delivery-coverage.util.js';

describe('assertDeliveryCovered', () => {
  it('allows interior and boundary results', async () => {
    const storeCoverage = {
      evaluatePoint: jest.fn().mockResolvedValue({ accepted: true, position: 'BOUNDARY' }),
    };
    await expect(assertDeliveryCovered(storeCoverage as any, -1.24, -78.61)).resolves.toBeUndefined();
  });

  it('rejects exterior points as DELIVERY_OUTSIDE_COVERAGE', async () => {
    const storeCoverage = {
      evaluatePoint: jest.fn().mockResolvedValue({ accepted: false, position: 'EXTERIOR' }),
    };
    try {
      await assertDeliveryCovered(storeCoverage as any, 0, 0);
      throw new Error('expected exterior to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect((error as HttpException).getResponse()).toMatchObject({
        error: { code: 'DELIVERY_OUTSIDE_COVERAGE', details: { position: 'EXTERIOR' } },
      });
    }
  });
});
