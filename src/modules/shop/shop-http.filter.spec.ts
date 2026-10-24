import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { ShopHttpExceptionFilter, shopError } from './shop-http.filter.js';

describe('ShopHttpExceptionFilter', () => {
  let filter: ShopHttpExceptionFilter;
  let mockStatus: jest.Mock;
  let mockJson: jest.Mock;
  let mockResponse: { status: jest.Mock };
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new ShopHttpExceptionFilter();
    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnValue({ json: mockJson });
    mockResponse = { status: mockStatus };
    mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => ({}),
        getNext: () => ({}),
      }),
    } as unknown as ArgumentsHost;
  });

  it('preserves explicit 422 CARD_INVALID error envelope', () => {
    const error = shopError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'CARD_INVALID',
      'Los datos de la tarjeta son inválidos',
      { field: 'number' },
    );

    filter.catch(error, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(422);
    expect(mockJson).toHaveBeenCalledWith({
      error: {
        code: 'CARD_INVALID',
        message: 'Los datos de la tarjeta son inválidos',
        details: { field: 'number' },
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    });
  });

  it('preserves explicit 409 STOCK_UNAVAILABLE error envelope', () => {
    const error = shopError(
      HttpStatus.CONFLICT,
      'STOCK_UNAVAILABLE',
      'Inventario insuficiente',
      { productId: 'p1', availableStock: 0 },
    );

    filter.catch(error, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(409);
    expect(mockJson).toHaveBeenCalledWith({
      error: {
        code: 'STOCK_UNAVAILABLE',
        message: 'Inventario insuficiente',
        details: { productId: 'p1', availableStock: 0 },
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    });
  });

  it('preserves explicit 503 PAYMENT_SIMULATION_DISABLED error envelope', () => {
    const error = shopError(
      HttpStatus.SERVICE_UNAVAILABLE,
      'PAYMENT_SIMULATION_DISABLED',
      'El simulador de pagos no está habilitado en este entorno',
      {},
    );

    filter.catch(error, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(503);
    expect(mockJson).toHaveBeenCalledWith({
      error: {
        code: 'PAYMENT_SIMULATION_DISABLED',
        message: 'El simulador de pagos no está habilitado en este entorno',
        details: {},
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    });
  });

  it('masks unknown 500 exceptions as generic INTERNAL_ERROR without leaking internal info', () => {
    const error = new Error('Database connection failed: password=secret');

    filter.catch(error, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(500);
    expect(mockJson).toHaveBeenCalledWith({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Request could not be completed',
        details: {},
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    });
  });

  it('maps generic 502 to UPLOAD_FAILED without leaking provider error', () => {
    const error = new HttpException('Bad Gateway from Cloudinary', HttpStatus.BAD_GATEWAY);

    filter.catch(error, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(502);
    expect(mockJson).toHaveBeenCalledWith({
      error: {
        code: 'UPLOAD_FAILED',
        message: 'Request could not be completed',
        details: {},
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    });
  });
});
