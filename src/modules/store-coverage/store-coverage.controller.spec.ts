import { AdminStoreCoverageController } from './admin-store-coverage.controller.js';
import { StoreCoverageController } from './store-coverage.controller.js';

describe('StoreCoverageController', () => {
  const service = {
    getCoverage: jest.fn(),
    evaluatePoint: jest.fn(),
    upsertCoverage: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delegates public read and evaluate', async () => {
    const controller = new StoreCoverageController(service as any);
    service.getCoverage.mockResolvedValue({ configured: false });
    await expect(controller.getCoverage()).resolves.toEqual({ configured: false });
    service.evaluatePoint.mockResolvedValue({ accepted: true, position: 'INTERIOR' });
    await expect(controller.evaluate({ lat: 5, lng: 5 })).resolves.toEqual({
      accepted: true,
      position: 'INTERIOR',
    });
  });

  it('delegates ADMIN upsert with the actor id', async () => {
    const controller = new AdminStoreCoverageController(service as any);
    const dto = { location: { lat: 1, lng: 1 }, coverage: { type: 'Polygon', coordinates: [] } };
    service.upsertCoverage.mockResolvedValue({ configured: true });
    await expect(controller.upsert('admin-1', dto as any)).resolves.toEqual({ configured: true });
    expect(service.upsertCoverage).toHaveBeenCalledWith('admin-1', dto);
  });
});
