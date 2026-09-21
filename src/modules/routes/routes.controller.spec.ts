import { RoutesController } from './routes.controller.js';

describe('RoutesController', () => {
  let controller: RoutesController;
  let routesServiceMock: any;

  beforeEach(() => {
    routesServiceMock = {
      assignRoute: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
    };
    controller = new RoutesController(routesServiceMock);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('assign debe delegar al servicio assignRoute', async () => {
    const dto = { driverId: 'driver-1', zoneId: 'zone-1', orderIds: ['order-1'] };
    const createdRoute = { id: 'route-1', ...dto };
    routesServiceMock.assignRoute.mockResolvedValue(createdRoute);

    const result = await controller.assign(dto);
    expect(routesServiceMock.assignRoute).toHaveBeenCalledWith(dto);
    expect(result).toEqual(createdRoute);
  });

  it('findAll debe delegar al servicio findAll', async () => {
    const routes = [{ id: 'route-1' }];
    routesServiceMock.findAll.mockResolvedValue(routes);

    const result = await controller.findAll();
    expect(routesServiceMock.findAll).toHaveBeenCalled();
    expect(result).toEqual(routes);
  });

  it('findOne debe delegar al servicio findOne', async () => {
    const route = { id: 'route-1' };
    routesServiceMock.findOne.mockResolvedValue(route);

    const result = await controller.findOne('route-1');
    expect(routesServiceMock.findOne).toHaveBeenCalledWith('route-1');
    expect(result).toEqual(route);
  });
});
