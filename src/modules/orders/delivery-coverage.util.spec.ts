import { HttpException, HttpStatus } from '@nestjs/common';
import { assertDeliveryCovered } from './delivery-coverage.util.js';

describe('assertDeliveryCovered', () => {
  it('allows interior and boundary results', async () => {
    const storeCoverage = {
      evaluatePoint: jest.fn().mockResolvedValue({ accepted: true, position: 'BOUNDARY' }),
    };
    await expect(assertDeliveryCovered(storeCoverage as any, -1.24, -78.61)).resolves.toBeUndefined();
    expect(storeCoverage.evaluatePoint).toHaveBeenCalledWith({ lat: -1.24, lng: -78.61 });
  });

  it('forwards an active transaction executor when provided', async () => {
    const storeCoverage = {
      evaluatePoint: jest.fn().mockResolvedValue({ accepted: true, position: 'INTERIOR' }),
    };
    const tx = { orm: {} } as any;
    await expect(assertDeliveryCovered(storeCoverage as any, -1.24, -78.61, tx)).resolves.toBeUndefined();
    expect(storeCoverage.evaluatePoint).toHaveBeenCalledWith({ lat: -1.24, lng: -78.61 }, tx);
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
