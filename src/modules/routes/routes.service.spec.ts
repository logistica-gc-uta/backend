import { RouteHistoryService } from './route-history.service.js';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { RouteAssignmentService } from './route-assignment.service.js';
import { RoutesService } from './routes.service.js';

describe('RoutesService compatibility and shared primitives', () => {
  let service: RoutesService;
  let route: any;
  let assignment: any;
  let transaction: jest.Mock;
  beforeEach(() => {
    route = {
      include: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      all: jest.fn(),
      first: jest.fn(),
    };
    assignment = {
      assignLegacy: jest.fn(),
      confirmDraft: jest.fn(),
      assignDraft: jest.fn(),
    };
    transaction = jest.fn();
    service = new RoutesService(
      { route, client: { transaction } } as unknown as PrismaService,
      assignment as RouteAssignmentService,
      { project: async (rows: unknown[]) => rows } as RouteHistoryService,
    );
  });
  it('delegates compatibility request and authenticated actor to one shared primitive', async () => {
    const dto = { driverId: 'driver', zoneId: 'zone', orderIds: ['one'] };
    assignment.assignLegacy.mockResolvedValue({
      id: 'route',
      status: 'ASSIGNED',
    });
    expect(await service.assignRoute(dto, 'admin')).toEqual({
      id: 'route',
      status: 'ASSIGNED',
    });
    expect(assignment.assignLegacy).toHaveBeenCalledWith(dto, 'admin');
    expect(transaction).not.toHaveBeenCalled();
  });
  it('delegates explicit confirmation and assignment with authenticated actor', async () => {
    const dto = {
      zoneId: 'zone',
      orderIds: ['order'],
      routeDate: '2026-10-10T00:00:00Z',
    };
    await service.confirmDraft(dto, 'admin');
    expect(assignment.confirmDraft).toHaveBeenCalledWith(dto, 'admin');
    await service.assignDraft('route', { driverId: 'driver' }, 'admin');
    expect(assignment.assignDraft).toHaveBeenCalledWith(
      'route',
      { driverId: 'driver' },
      'admin',
    );
  });
  it('preserves existing relation-rich route reads', async () => {
    const stored = { id: 'route', driver: {}, zone: {}, orders: [] };
    route.all.mockResolvedValue([stored]);
    route.first.mockResolvedValue(stored);
    await expect(service.findAll()).resolves.toEqual([stored]);
    await expect(service.findOne('route')).resolves.toEqual(stored);
    expect(route.where).toHaveBeenCalledWith({ id: 'route' });
  });
  it('preserves missing-route read errors', async () => {
    route.first.mockResolvedValue(null);
    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
