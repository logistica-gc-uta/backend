import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { shopError, ShopHttpExceptionFilter } from '../shop/shop-http.filter.js';
import { storeCoverageExceptionFactory } from './store-coverage-validation.js';

function responseText(exception: HttpException): string {
  return JSON.stringify(exception.getResponse()).toLowerCase();
}

/**
 * Global ValidationPipe still emits generic 400s. Map those onto the store-coverage codes.
 */
export function remapStoreCoverageException(exception: unknown): unknown {
  if (!(exception instanceof HttpException) || exception.getStatus() !== 400) {
    return exception;
  }
  const payload = exception.getResponse();
  if (payload && typeof payload === 'object' && (payload as { error?: { code?: unknown } }).error?.code) {
    return exception;
  }
  const text = responseText(exception);
  const locationHit = /\blocation\b|\blat\b|\blng\b/.test(text);
  const coverageHit = /\bcoverage\b/.test(text);
  if (locationHit && !coverageHit) {
    return storeCoverageExceptionFactory([{ property: 'lat', children: [], constraints: { max: 'mapped' } }]);
  }
  if (coverageHit && !locationHit) {
    return storeCoverageExceptionFactory([{ property: 'coverage', children: [], constraints: { type: 'mapped' } }]);
  }
  return shopError(400, 'VALIDATION_ERROR', 'Invalid request');
}

@Catch()
export class StoreCoverageHttpExceptionFilter implements ExceptionFilter {
  private readonly inner = new ShopHttpExceptionFilter();

  catch(exception: unknown, host: ArgumentsHost): void {
    this.inner.catch(remapStoreCoverageException(exception), host);
  }
}
