import { DriversController } from './drivers.controller.js';

describe('DriversController', () => {
  it('findAll debe delegar al servicio', async () => {
    const drivers = [{ id: 'd1', isAvailable: true }];
    const driversServiceMock: any = {
      findAll: jest.fn().mockResolvedValue(drivers),
    };
    const controller = new DriversController(driversServiceMock);

    const result = await controller.findAll();

    expect(driversServiceMock.findAll).toHaveBeenCalled();
    expect(result).toEqual(drivers);
  });
});

describe('driver-owned routes', () => {
  it('passes only the authenticated user and date to the service', async () => {
    const service: any = { findMyRoutes: jest.fn().mockResolvedValue([]) };
    const controller = new DriversController(service);
    expect(
      await controller.findMyRoutes('jwt-user', { date: '2024-02-29' }),
    ).toEqual([]);
    expect(service.findMyRoutes).toHaveBeenCalledWith('jwt-user', '2024-02-29');
  });
});

describe('Driver availability identity', () => {
  it('delegates only authenticated ownership to the shared availability projection', async () => {
    const service: any = {
      findMyAvailability: jest
        .fn()
        .mockResolvedValue({ isAvailable: false, blockingRouteIds: ['route'] }),
    };
    const controller = new DriversController(service);
    expect(await controller.findMyAvailability('jwt-owner')).toEqual({
      isAvailable: false,
      blockingRouteIds: ['route'],
    });
    expect(service.findMyAvailability).toHaveBeenCalledWith('jwt-owner');
  });
});
