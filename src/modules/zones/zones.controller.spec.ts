import { ZonesController } from './zones.controller.js';

describe('ZonesController', () => {
  let controller: ZonesController;
  let zonesServiceMock: any;

  beforeEach(() => {
    zonesServiceMock = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    controller = new ZonesController(zonesServiceMock);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('findAll debe delegar al servicio', async () => {
    const zones = [{ id: '1', name: 'Centro' }];
    zonesServiceMock.findAll.mockResolvedValue(zones);

    const result = await controller.findAll();
    expect(zonesServiceMock.findAll).toHaveBeenCalled();
    expect(result).toEqual(zones);
  });

  it('findOne debe delegar al servicio', async () => {
    const zone = { id: '1', name: 'Centro' };
    zonesServiceMock.findOne.mockResolvedValue(zone);

    const result = await controller.findOne('1');
    expect(zonesServiceMock.findOne).toHaveBeenCalledWith('1');
    expect(result).toEqual(zone);
  });

  it('create debe delegar al servicio', async () => {
    const dto = { name: 'Centro', code: 'CEN-01' };
    const created = { id: '1', ...dto };
    zonesServiceMock.create.mockResolvedValue(created);

    const result = await controller.create(dto);
    expect(zonesServiceMock.create).toHaveBeenCalledWith(dto);
    expect(result).toEqual(created);
  });

  it('update debe delegar al servicio', async () => {
    const dto = { name: 'Centro Histórico' };
    const updated = { id: '1', name: 'Centro Histórico', code: 'CEN-01' };
    zonesServiceMock.update.mockResolvedValue(updated);

    const result = await controller.update('1', dto);
    expect(zonesServiceMock.update).toHaveBeenCalledWith('1', dto);
    expect(result).toEqual(updated);
  });

  it('remove debe delegar al servicio', async () => {
    const deleted = { id: '1', name: 'Centro', code: 'CEN-01' };
    zonesServiceMock.remove.mockResolvedValue(deleted);

    const result = await controller.remove('1');
    expect(zonesServiceMock.remove).toHaveBeenCalledWith('1');
    expect(result).toEqual(deleted);
  });
});
