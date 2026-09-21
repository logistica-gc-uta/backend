import { AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { OrderStatus } from './dto/update-order-status.dto.js';
import { OrdersController } from './orders.controller.js';

describe('OrdersController', () => {
  let controller: OrdersController;
  let ordersServiceMock: any;

  beforeEach(() => {
    ordersServiceMock = {
      createOrder: jest.fn(),
      findMyOrders: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      updateStatus: jest.fn(),
    };
    controller = new OrdersController(ordersServiceMock);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('create debe delegar a createOrder con userId y dto', async () => {
    const dto = {
      zoneId: 'zone-1',
      deliveryAddress: 'Calle 123',
      items: [{ productId: 'prod-1', quantity: 2 }],
    };
    const createdOrder = { id: 'order-1', ...dto };
    ordersServiceMock.createOrder.mockResolvedValue(createdOrder);

    const result = await controller.create('user-1', dto);
    expect(ordersServiceMock.createOrder).toHaveBeenCalledWith('user-1', dto);
    expect(result).toEqual(createdOrder);
  });

  it('findMyOrders debe delegar con userId', async () => {
    const orders = [{ id: 'order-1' }];
    ordersServiceMock.findMyOrders.mockResolvedValue(orders);

    const result = await controller.findMyOrders('user-1');
    expect(ordersServiceMock.findMyOrders).toHaveBeenCalledWith('user-1');
    expect(result).toEqual(orders);
  });

  it('findAll debe delegar al servicio', async () => {
    const orders = [{ id: 'order-1' }];
    ordersServiceMock.findAll.mockResolvedValue(orders);

    const result = await controller.findAll();
    expect(ordersServiceMock.findAll).toHaveBeenCalled();
    expect(result).toEqual(orders);
  });

  it('findOne debe delegar al servicio', async () => {
    const order = { id: 'order-1' };
    ordersServiceMock.findOne.mockResolvedValue(order);

    const result = await controller.findOne('order-1');
    expect(ordersServiceMock.findOne).toHaveBeenCalledWith('order-1');
    expect(result).toEqual(order);
  });

  it('updateStatus debe delegar con id, dto y user', async () => {
    const dto = { status: OrderStatus.IN_TRANSIT };
    const user: AuthenticatedUser = { userId: 'driver-1', email: 'd@d.com', role: 'DRIVER' };
    const updated = { id: 'order-1', status: OrderStatus.IN_TRANSIT };
    ordersServiceMock.updateStatus.mockResolvedValue(updated);

    const result = await controller.updateStatus('order-1', dto, user);
    expect(ordersServiceMock.updateStatus).toHaveBeenCalledWith('order-1', dto, user);
    expect(result).toEqual(updated);
  });
});
