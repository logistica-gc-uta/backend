import { ArgumentsHost, BadRequestException, HttpStatus, NotFoundException } from '@nestjs/common';
import { shopError } from '../shop/shop-http.filter.js';
import { OrdersCreateHttpExceptionFilter } from './orders-create-http.filter.js';

describe('OrdersCreateHttpExceptionFilter', () => {
  let filter: OrdersCreateHttpExceptionFilter;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new OrdersCreateHttpExceptionFilter();
    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnValue({ json: mockJson });
    mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({ status: mockStatus }),
        getRequest: () => ({}),
        getNext: () => ({}),
      }),
    } as unknown as ArgumentsHost;
  });

  it('keeps Nest 404 for a missing registered client', () => {
    filter.catch(new NotFoundException('Registered client not found'), mockHost);
    expect(mockStatus).toHaveBeenCalledWith(404);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 404,
      message: 'Registered client not found',
      error: 'Not Found',
    });
  });

  it('keeps Nest 400 for insufficient stock', () => {
    filter.catch(
      new BadRequestException(
        "Stock insuficiente para el producto 'Product'. Solicitado: 10001, Disponible: 10000",
      ),
      mockHost,
    );
    expect(mockStatus).toHaveBeenCalledWith(400);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 400,
      message:
        "Stock insuficiente para el producto 'Product'. Solicitado: 10001, Disponible: 10000",
      error: 'Bad Request',
    });
  });

  it('keeps Shop coverage envelopes including requestId', () => {
    filter.catch(
      shopError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'DELIVERY_OUTSIDE_COVERAGE',
        'Delivery point is outside the configured store coverage',
        { position: 'exterior' },
      ),
      mockHost,
    );
    expect(mockStatus).toHaveBeenCalledWith(422);
    expect(mockJson).toHaveBeenCalledWith({
      error: {
        code: 'DELIVERY_OUTSIDE_COVERAGE',
        message: 'Delivery point is outside the configured store coverage',
        details: { position: 'exterior' },
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    });
  });
});
