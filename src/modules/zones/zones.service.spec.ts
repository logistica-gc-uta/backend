import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../database/prisma.service.js';
import { ZonesService } from './zones.service.js';

describe('ZonesService', () => {
  let service: ZonesService;
  let prismaMock: any;

  beforeEach(async () => {
    prismaMock = {
      zone: {
        where: jest.fn(),
        all: jest.fn(),
        create: jest.fn(),
      },
      order: {
        where: jest.fn(),
      },
      route: {
        where: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ZonesService,
        {
          provide: PrismaService,
          useValue: prismaMock,
        },
      ],
    }).compile();

    service = module.get<ZonesService>(ZonesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAll', () => {
    it('debe listar todas las zonas de entrega', async () => {
      const mockZones = [
        { id: 'zone-1', name: 'Centro', code: 'CEN-01' },
        { id: 'zone-2', name: 'Ficoa', code: 'FIC-02' },
      ];
      prismaMock.zone.all.mockResolvedValue(mockZones);

      const result = await service.findAll();
      expect(result).toEqual(mockZones);
    });
  });

  describe('findOne', () => {
    it('debe encontrar y retornar una zona por su ID', async () => {
      const mockZone = { id: 'zone-1', name: 'Centro', code: 'CEN-01' };
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(mockZone),
      });

      const result = await service.findOne('zone-1');
      expect(result).toEqual(mockZone);
    });

    it('debe lanzar NotFoundException si la zona no existe', async () => {
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(null),
      });

      await expect(service.findOne('invalid-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    it('debe crear exitosamente una zona si no hay duplicados', async () => {
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(null),
      });

      const newZone = { id: 'zone-3', name: 'Huachi', code: 'HUA-03' };
      prismaMock.zone.create.mockResolvedValue(newZone);

      const result = await service.create({ name: 'Huachi', code: 'HUA-03' });
      expect(result).toEqual(newZone);
    });

    it('debe lanzar ConflictException si el código ya está registrado', async () => {
      prismaMock.zone.where.mockImplementation((filter: { code?: string; name?: string }) => {
        if (filter.code) {
          return { first: jest.fn().mockResolvedValue({ id: 'existing', code: 'CEN-01' }) };
        }
        return { first: jest.fn().mockResolvedValue(null) };
      });

      await expect(
        service.create({ name: 'Nuevo Centro', code: 'CEN-01' }),
      ).rejects.toThrow(ConflictException);
    });

    it('debe lanzar ConflictException si el nombre ya está registrado', async () => {
      prismaMock.zone.where.mockImplementation((filter: { code?: string; name?: string }) => {
        if (filter.code) {
          return { first: jest.fn().mockResolvedValue(null) };
        }
        if (filter.name) {
          return { first: jest.fn().mockResolvedValue({ id: 'existing', name: 'Centro' }) };
        }
        return { first: jest.fn().mockResolvedValue(null) };
      });

      await expect(
        service.create({ name: 'Centro', code: 'NUEVO-01' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('update', () => {
    const existingZone = { id: 'zone-1', name: 'Centro', code: 'CEN-01' };

    it('debe actualizar exitosamente una zona', async () => {
      prismaMock.zone.where.mockImplementation((filter: { id?: string; code?: string; name?: string }) => {
        if (filter.id) {
          return {
            first: jest.fn().mockResolvedValue(existingZone),
            update: jest.fn().mockResolvedValue({ ...existingZone, name: 'Centro Histórico' }),
          };
        }
        return { first: jest.fn().mockResolvedValue(null) };
      });

      const result = await service.update('zone-1', { name: 'Centro Histórico' });
      expect(result.name).toBe('Centro Histórico');
    });

    it('debe lanzar ConflictException si el nuevo código ya pertenece a otra zona', async () => {
      prismaMock.zone.where.mockImplementation((filter: { id?: string; code?: string; name?: string }) => {
        if (filter.id) {
          return { first: jest.fn().mockResolvedValue(existingZone) };
        }
        if (filter.code === 'FIC-02') {
          return { first: jest.fn().mockResolvedValue({ id: 'zone-2', code: 'FIC-02' }) };
        }
        return { first: jest.fn().mockResolvedValue(null) };
      });

      await expect(
        service.update('zone-1', { code: 'FIC-02' }),
      ).rejects.toThrow(ConflictException);
    });

    it('debe lanzar ConflictException si el nuevo nombre ya pertenece a otra zona', async () => {
      prismaMock.zone.where.mockImplementation((filter: { id?: string; code?: string; name?: string }) => {
        if (filter.id) {
          return { first: jest.fn().mockResolvedValue(existingZone) };
        }
        if (filter.name === 'Ficoa') {
          return { first: jest.fn().mockResolvedValue({ id: 'zone-2', name: 'Ficoa' }) };
        }
        return { first: jest.fn().mockResolvedValue(null) };
      });

      await expect(
        service.update('zone-1', { name: 'Ficoa' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('remove', () => {
    const existingZone = { id: 'zone-1', name: 'Centro', code: 'CEN-01' };

    it('debe eliminar la zona si no tiene pedidos ni rutas asociadas', async () => {
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(existingZone),
        delete: jest.fn().mockResolvedValue(existingZone),
      });

      prismaMock.order.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(null),
      });

      prismaMock.route.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(null),
      });

      const result = await service.remove('zone-1');
      expect(result).toEqual(existingZone);
    });

    it('debe lanzar ConflictException si la zona tiene pedidos asociados', async () => {
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(existingZone),
      });

      prismaMock.order.where.mockReturnValue({
        first: jest.fn().mockResolvedValue({ id: 'order-1', zoneId: 'zone-1' }),
      });

      await expect(service.remove('zone-1')).rejects.toThrow(
        new ConflictException('No se puede eliminar la zona porque tiene pedidos asociados'),
      );
    });

    it('debe lanzar ConflictException si la zona tiene rutas asociadas', async () => {
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(existingZone),
      });

      prismaMock.order.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(null),
      });

      prismaMock.route.where.mockReturnValue({
        first: jest.fn().mockResolvedValue({ id: 'route-1', zoneId: 'zone-1' }),
      });

      await expect(service.remove('zone-1')).rejects.toThrow(
        new ConflictException('No se puede eliminar la zona porque tiene rutas asociadas'),
      );
    });
  });
});
