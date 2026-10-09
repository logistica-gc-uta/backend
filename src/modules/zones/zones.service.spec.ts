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
    it('debe listar todas las zonas de entrega enriquecidas con depotLocation', async () => {
      const mockZones = [
        { id: 'zone-1', name: 'Centro', code: 'CEN-01', depotLat: null, depotLng: null },
        { id: 'zone-2', name: 'Ficoa', code: 'FIC-02', depotLat: -1.24, depotLng: -78.61 },
      ];
      prismaMock.zone.all.mockResolvedValue(mockZones);

      const result = await service.findAll();
      expect(result).toEqual([
        { id: 'zone-1', name: 'Centro', code: 'CEN-01', depotLat: null, depotLng: null, depotLocation: null },
        { id: 'zone-2', name: 'Ficoa', code: 'FIC-02', depotLat: -1.24, depotLng: -78.61, depotLocation: { lat: -1.24, lng: -78.61 } },
      ]);
    });
  });

  describe('findOne', () => {
    it('debe encontrar y retornar una zona por su ID enriquecida con depotLocation', async () => {
      const mockZone = { id: 'zone-1', name: 'Centro', code: 'CEN-01', depotLat: -1.25, depotLng: -78.62 };
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(mockZone),
      });

      const result = await service.findOne('zone-1');
      expect(result).toEqual({
        ...mockZone,
        depotLocation: { lat: -1.25, lng: -78.62 },
      });
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
      expect(result).toEqual(expect.objectContaining(newZone));
    });

    it('debe persistir coordenadas válidas del depósito y retornar depotLocation', async () => {
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(null),
      });

      const zoneWithCoords = {
        id: 'zone-geo',
        name: 'Ficoa Geo',
        code: 'FIC-GEO',
        depotLat: -1.249,
        depotLng: -78.616,
      };
      prismaMock.zone.create.mockResolvedValue(zoneWithCoords);

      const result = await service.create({
        name: 'Ficoa Geo',
        code: 'FIC-GEO',
        depotLat: -1.249,
        depotLng: -78.616,
      });

      expect(prismaMock.zone.create).toHaveBeenCalledWith({
        name: 'Ficoa Geo',
        code: 'FIC-GEO',
        depotLat: -1.249,
        depotLng: -78.616,
      });
      expect(result.depotLocation).toEqual({ lat: -1.249, lng: -78.616 });
    });

    it('debe rechazar par incompleto o nulo en creación a nivel de servicio', async () => {
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.create({ name: 'Z1', code: 'Z-01', depotLat: -1.2 } as any),
      ).rejects.toThrow();

      await expect(
        service.create({ name: 'Z2', code: 'Z-02', depotLat: null, depotLng: null } as any),
      ).rejects.toThrow();
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
    const existingZone = { id: 'zone-1', name: 'Centro', code: 'CEN-01', depotLat: -1.25, depotLng: -78.62 };

    it('debe actualizar exitosamente una zona preservando coordenadas existentes si se omiten', async () => {
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
      expect(result.depotLat).toBe(-1.25);
      expect(result.depotLng).toBe(-78.62);
      expect(result.depotLocation).toEqual({ lat: -1.25, lng: -78.62 });
    });

    it('debe actualizar coordenadas atómicamente cuando se proporciona un par válido', async () => {
      const updateMock = jest.fn().mockResolvedValue({
        ...existingZone,
        depotLat: -1.3,
        depotLng: -78.7,
      });

      prismaMock.zone.where.mockImplementation((filter: { id?: string }) => {
        if (filter.id) {
          return {
            first: jest.fn().mockResolvedValue(existingZone),
            update: updateMock,
          };
        }
        return { first: jest.fn().mockResolvedValue(null) };
      });

      const result = await service.update('zone-1', { depotLat: -1.3, depotLng: -78.7 });
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({ depotLat: -1.3, depotLng: -78.7 }),
      );
      expect(result.depotLocation).toEqual({ lat: -1.3, lng: -78.7 });
    });

    it('debe rechazar par incompleto o nulo en update a nivel de servicio (sin borrado parcial)', async () => {
      prismaMock.zone.where.mockReturnValue({
        first: jest.fn().mockResolvedValue(existingZone),
      });

      await expect(
        service.update('zone-1', { depotLat: -1.3 } as any),
      ).rejects.toThrow();

      await expect(
        service.update('zone-1', { depotLat: null, depotLng: null } as any),
      ).rejects.toThrow();
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

    it('debe lanzar NotFoundException si la actualización no retorna registro tras el precheck', async () => {
      prismaMock.zone.where.mockImplementation((filter: { id?: string }) => {
        if (filter.id) {
          return {
            first: jest.fn().mockResolvedValue(existingZone),
            update: jest.fn().mockResolvedValue(null),
          };
        }
        return { first: jest.fn().mockResolvedValue(null) };
      });

      await expect(
        service.update('zone-1', { name: 'Centro Actualizado' }),
      ).rejects.toThrow(NotFoundException);
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
