import { DriversController } from './drivers.controller.js';

describe('DriversController', () => {
  it('findAll debe delegar al servicio', async () => {
    const drivers = [{ id: 'd1', isAvailable: true }];
    const driversServiceMock: any = { findAll: jest.fn().mockResolvedValue(drivers) };
    const controller = new DriversController(driversServiceMock);

    const result = await controller.findAll();

    expect(driversServiceMock.findAll).toHaveBeenCalled();
    expect(result).toEqual(drivers);
  });
});
