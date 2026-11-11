import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { ShopHttpExceptionFilter } from '../shop/shop-http.filter.js';

function hasShopEnvelope(exception: unknown): boolean {
  if (!(exception instanceof HttpException)) return false;
  const payload = exception.getResponse();
  if (!payload || typeof payload !== 'object') return false;
  const error = (payload as { error?: unknown }).error;
  return (
    !!error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

/**
 * Create keeps Shop coverage/hours envelopes and Nest bodies for legacy order errors.
 * Catalog/checkout keep using ShopHttpExceptionFilter unchanged.
 */
@Catch()
export class OrdersCreateHttpExceptionFilter implements ExceptionFilter {
  private readonly shop = new ShopHttpExceptionFilter();

  catch(exception: unknown, host: ArgumentsHost): void {
    if (hasShopEnvelope(exception)) {
      this.shop.catch(exception, host);
      return;
    }
    const response = host.switchToHttp().getResponse();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      response.status(status).json(
        typeof payload === 'object' && payload !== null
          ? payload
          : { statusCode: status, message: payload },
      );
      return;
    }
    response.status(500).json({
      statusCode: 500,
      message: 'Internal server error',
    });
  }
}
