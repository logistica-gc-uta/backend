import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/** Explicit business failures; the controller-scoped filter adds server-owned trace IDs. */
export function shopError(status: number, code: string, message: string, details: Record<string, unknown> = {}): HttpException {
  return new HttpException({ error: { code, message, details } }, status);
}

/** Applied only to new catalog controllers: legacy/auth error contracts stay unchanged. */
@Catch()
export class ShopHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const payload = exception instanceof HttpException ? exception.getResponse() : undefined;
    const response = host.switchToHttp().getResponse();
    const object = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const explicit = object.error && typeof object.error === 'object'
      ? object.error as Record<string, unknown> : undefined;
    const defaults: Record<number, [string, string]> = {
      400: ['VALIDATION_ERROR', 'Invalid request'],
      401: ['UNAUTHENTICATED', 'Authentication required'],
      403: ['FORBIDDEN', 'Insufficient permissions'],
      404: ['PRODUCT_NOT_FOUND', 'Resource not found'],
      413: ['IMAGE_TOO_LARGE', 'Image exceeds the supported size'],
      415: ['IMAGE_UNSUPPORTED', 'Unsupported image content'],
    };
    const [fallbackCode, fallbackMessage] = defaults[status] ?? ['INTERNAL_ERROR', 'Request could not be completed'];
    const isExplicitSimulationDisabled = status === 503 && explicit?.code === 'PAYMENT_SIMULATION_DISABLED';
    const safeExplicit = (status < 500 || isExplicitSimulationDisabled) && typeof explicit?.code === 'string' && typeof explicit?.message === 'string';
    // Provider/DB exceptions never leak upstream messages or credentials. Explicit 502s remain generic.
    response.status(status).json({ error: {
      code: status === 502 ? 'UPLOAD_FAILED' : safeExplicit ? explicit.code : fallbackCode,
      message: safeExplicit ? explicit.message : fallbackMessage,
      details: safeExplicit && explicit.details && typeof explicit.details === 'object' ? explicit.details : {},
      requestId: randomUUID(),
    } });
  }
}
