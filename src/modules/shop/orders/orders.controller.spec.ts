import { OrdersController } from './orders.controller.js';
import { ShopOrdersService } from './orders.service.js';
import { AuthenticatedUser } from '../../auth/decorators/current-user.decorator.js';

describe('OrdersController unit tests (public behavior)', () => {
  let controller: OrdersController;
  let mockOrdersService: {
    listOrders: jest.Mock;
    getOrderDetail: jest.Mock;
    getOrderReceipt: jest.Mock;
  };

  const clientUser: AuthenticatedUser = {
    userId: 'client-uuid-1',
    email: 'client@regalia.test',
    role: 'CLIENT',
  };

  beforeEach(() => {
    mockOrdersService = {
      listOrders: jest.fn(),
      getOrderDetail: jest.fn(),
      getOrderReceipt: jest.fn(),
    };

    controller = new OrdersController(mockOrdersService as unknown as ShopOrdersService);
  });

  it('delegates listOrders to service with authenticated userId', async () => {
    const expected = { items: [], total: 0, page: 1, pageSize: 10, totalPages: 0 };
    mockOrdersService.listOrders.mockResolvedValueOnce(expected);

    const result = await controller.listOrders(clientUser, { page: 1, pageSize: 10 });
    expect(mockOrdersService.listOrders).toHaveBeenCalledWith('client-uuid-1', { page: 1, pageSize: 10 });
    expect(result).toBe(expected);
  });

  it('delegates getOrderDetail to service with authenticated userId and orderId', async () => {
    const expected = { id: 'order-1' } as any;
    mockOrdersService.getOrderDetail.mockResolvedValueOnce(expected);

    const result = await controller.getOrderDetail(clientUser, '00000000-0000-4000-8000-000000000001');
    expect(mockOrdersService.getOrderDetail).toHaveBeenCalledWith('client-uuid-1', '00000000-0000-4000-8000-000000000001');
    expect(result).toBe(expected);
  });

  it('delegates getOrderReceipt to service with authenticated userId and orderId', async () => {
    const expected = { id: 'receipt-1' } as any;
    mockOrdersService.getOrderReceipt.mockResolvedValueOnce(expected);

    const result = await controller.getOrderReceipt(clientUser, '00000000-0000-4000-8000-000000000001');
    expect(mockOrdersService.getOrderReceipt).toHaveBeenCalledWith('client-uuid-1', '00000000-0000-4000-8000-000000000001');
    expect(result).toBe(expected);
  });
});
