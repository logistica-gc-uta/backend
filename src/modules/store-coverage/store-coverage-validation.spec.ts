import { BadRequestException, HttpException } from '@nestjs/common';
import { remapStoreCoverageException } from './store-coverage-http.filter.js';
import { storeCoverageExceptionFactory } from './store-coverage-validation.js';

describe('storeCoverageExceptionFactory', () => {
  it('maps location and point field failures to STORE_LOCATION_INVALID', () => {
    const error = storeCoverageExceptionFactory([
      { property: 'location', children: [{ property: 'lat', children: [], constraints: { max: 'too big' } }] },
    ] as any);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getResponse()).toMatchObject({ error: { code: 'STORE_LOCATION_INVALID' } });

    const evaluate = storeCoverageExceptionFactory([
      { property: 'lat', children: [], constraints: { max: 'too big' } },
    ] as any);
    expect(evaluate.getResponse()).toMatchObject({ error: { code: 'STORE_LOCATION_INVALID' } });
  });

  it('maps coverage field failures to STORE_COVERAGE_INVALID', () => {
    const error = storeCoverageExceptionFactory([
      { property: 'coverage', children: [{ property: 'type', children: [], constraints: { equals: 'Polygon' } }] },
    ] as any);
    expect(error.getResponse()).toMatchObject({ error: { code: 'STORE_COVERAGE_INVALID' } });
  });

  it('maps mixed or unknown request-shape failures to VALIDATION_ERROR', () => {
    const extra = storeCoverageExceptionFactory([
      { property: 'unexpected', children: [], constraints: { whitelist: 'not allowed' } },
    ] as any);
    expect(extra.getResponse()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('remaps global ValidationPipe 400s that mention lat to STORE_LOCATION_INVALID', () => {
    const remapped = remapStoreCoverageException(
      new BadRequestException({ statusCode: 400, message: ['lat must not be greater than 90'] }),
    ) as HttpException;
    expect(remapped.getResponse()).toMatchObject({ error: { code: 'STORE_LOCATION_INVALID' } });
  });
});
