import { ConflictException, NotFoundException } from '@nestjs/common';
import { DriversService } from './drivers.service.js';
import { assertDriverActive, driverInactiveConflict, isDriverInactive } from './driver-status.util.js';

/** Base en memoria con lo mínimo del ORM que usan la baja, la reactivación y el historial (#82). */
function setup(options: { holds?: string[]; routes?: any[]; driver?: Record<string, unknown> } = {}) {
  const tables: Record<string, any[]> = {
    User: [{ id: 'u-driver', name: 'Carlos', email: 'carlos@delivery.com', role: 'DRIVER', createdAt: Temporal.Now.instant() }],
    Driver: [
      {
        id: 'driver',
        userId: 'u-driver',
        vehicle: 'Moto',
        vehicleCapacity: 6,
        isAvailable: true,
        isActive: true,
        statusChangedAt: null,
        statusChangedById: null,
        statusReason: null,
        createdAt: Temporal.Now.instant(),
        ...options.driver,
      },
    ],
    Route: options.routes ?? [],
    DriverStatusChange: [],
  };
  const match = (filter: Record<string, unknown>) => (row: any) => Object.entries(filter).every(([key, value]) => row[key] === value);
  let counter = 0;
  const model = (name: string) => ({
    where: (filter: Record<string, unknown>) => ({
      first: async () => tables[name]!.find(match(filter)) ?? null,
      all: async () => tables[name]!.filter(match(filter)),
      update: async (value: Record<string, unknown>) => {
        const row = tables[name]!.find(match(filter));
        return row ? Object.assign(row, value) : null;
      },
    }),
    create: async (value: any) => {
      const row = { id: `${name}-${++counter}`, createdAt: Temporal.Now.instant(), ...value };
      tables[name]!.push(row);
      return row;
    },
  });
  const orm = { public: { User: model('User'), Driver: model('Driver'), Route: model('Route'), DriverStatusChange: model('DriverStatusChange') } };
  const withUser = (driver: any) => {
    if (!driver) return null;
    const user = tables.User!.find((u) => u.id === driver.userId);
    return { ...driver, user: { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt } };
  };
  const snapshot = () => JSON.stringify(tables);
  const client = {
    orm,
    transaction: jest.fn(async (fn: any) => {
      const before = snapshot();
      try {
        return await fn({ orm });
      } catch (error) {
        const restored = JSON.parse(before) as Record<string, any[]>;
        for (const key of Object.keys(tables)) tables[key]!.splice(0, tables[key]!.length, ...restored[key]!);
        throw error;
      }
    }),
  };
  const prisma: any = {
    client,
    driver: {
      where: (filter: any) => ({
        first: async () => tables.Driver!.find(match(filter)) ?? null,
        include: () => ({ first: async () => withUser(tables.Driver!.find(match(filter))) }),
      }),
    },
  };
  const holds = options.holds ?? [];
  const availability: any = {
    effective: jest.fn(async () => ({ isAvailable: holds.length === 0, hasPersistedHolds: holds.length > 0, blockingRouteIds: holds })),
  };
  return { tables, service: new DriversService(prisma, availability, {} as any), availability };
}

describe('Baja operativa de repartidores (#82)', () => {
  describe('deactivate', () => {
    it('registra la baja con actor, momento y motivo, y la deja en el historial; no toca la bandera de disponibilidad', async () => {
      const { service, tables } = setup();
      const result = await service.deactivate('driver', { reason: 'Licencia vencida' }, 'admin-1');
      expect(result).toMatchObject({ id: 'driver', isActive: false, statusChangedById: 'admin-1', statusReason: 'Licencia vencida', isAvailable: true });
      expect(result.statusChangedAt).not.toBeNull();
      expect(tables.DriverStatusChange).toEqual([expect.objectContaining({ driverId: 'driver', active: false, reason: 'Licencia vencida', actorId: 'admin-1' })]);
    });

    it('el motivo es opcional', async () => {
      const { service, tables } = setup();
      await service.deactivate('driver', {}, 'admin-1');
      expect(tables.Driver![0]).toMatchObject({ isActive: false, statusReason: null });
    });

    it.each([
      ['ASSIGNED', null],
      ['IN_PROGRESS', null],
      ['COMPLETED', null],
      ['INTERRUPTED', null],
    ])('una ruta %s sin regreso confirmado bloquea la baja con 409 DRIVER_HAS_OPEN_ROUTE y no cambia nada', async (status) => {
      const { service, tables } = setup({ holds: ['route-1'], routes: [{ id: 'route-1', status, returnedAt: null }] });
      await expect(service.deactivate('driver', { reason: 'x' }, 'admin-1')).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: 'DRIVER_HAS_OPEN_ROUTE', blockingRoutes: [{ routeId: 'route-1', status, returnConfirmed: false }] }),
      });
      expect(tables.Driver![0]).toMatchObject({ isActive: true, statusChangedAt: null, statusReason: null });
      expect(tables.DriverStatusChange).toHaveLength(0);
    });

    it('sin rutas ni reservas vivas (p. ej. solo rutas devueltas o borradores) la baja procede', async () => {
      const { service, availability } = setup({ holds: [] });
      await expect(service.deactivate('driver', {}, 'admin-1')).resolves.toMatchObject({ isActive: false });
      expect(availability.effective).toHaveBeenCalledWith('driver', expect.anything());
    });

    it('un repartidor ya dado de baja responde 409 DRIVER_ALREADY_INACTIVE y no duplica el historial', async () => {
      const { service, tables } = setup({ driver: { isActive: false, statusChangedAt: Temporal.Now.instant(), statusChangedById: 'a' } });
      await expect(service.deactivate('driver', {}, 'admin-1')).rejects.toMatchObject({ response: expect.objectContaining({ code: 'DRIVER_ALREADY_INACTIVE' }) });
      expect(tables.DriverStatusChange).toHaveLength(0);
    });

    it('un repartidor inexistente es 404', async () => {
      const { service } = setup();
      await expect(service.deactivate('otro', {}, 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('activate', () => {
    const inactive = () => ({ isActive: false, statusChangedAt: Temporal.Now.instant(), statusChangedById: 'admin-0', statusReason: 'Baja', isAvailable: false });

    it('reactiva, registra el cambio y no modifica la bandera de disponibilidad ni las rutas', async () => {
      const { service, tables } = setup({ driver: inactive(), routes: [{ id: 'old', status: 'COMPLETED', returnedAt: Temporal.Now.instant() }] });
      const result = await service.activate('driver', { reason: 'Renovó la licencia' }, 'admin-2');
      expect(result).toMatchObject({ isActive: true, statusChangedById: 'admin-2', statusReason: 'Renovó la licencia', isAvailable: false });
      expect(tables.DriverStatusChange).toEqual([expect.objectContaining({ active: true, actorId: 'admin-2' })]);
      expect(tables.Route).toHaveLength(1);
    });

    it('un repartidor ya activo responde 409 DRIVER_ALREADY_ACTIVE', async () => {
      const { service } = setup();
      await expect(service.activate('driver', {}, 'admin-1')).rejects.toMatchObject({ response: expect.objectContaining({ code: 'DRIVER_ALREADY_ACTIVE' }) });
    });

    it('una baja seguida de una reactivación deja ambos hechos en el historial, del más reciente al más antiguo', async () => {
      const { service } = setup();
      await service.deactivate('driver', { reason: 'Baja' }, 'admin-1');
      await service.activate('driver', { reason: 'Alta' }, 'admin-1');
      const history = await service.statusHistory('driver');
      expect(history.map((h) => h.active)).toEqual([true, false]);
      expect(history.map((h) => h.reason)).toEqual(['Alta', 'Baja']);
    });
  });

  describe('statusHistory', () => {
    it('un repartidor inexistente es 404 y uno sin cambios devuelve una lista vacía', async () => {
      const { service } = setup();
      await expect(service.statusHistory('otro')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.statusHistory('driver')).resolves.toEqual([]);
    });
  });

  describe('util', () => {
    it('solo un false explícito es una baja: filas sin la marca cuentan como activas', () => {
      expect(isDriverInactive({ isActive: false })).toBe(true);
      expect(isDriverInactive({ isActive: true })).toBe(false);
      expect(isDriverInactive({})).toBe(false);
      expect(isDriverInactive(null)).toBe(false);
      expect(() => assertDriverActive({ isActive: false })).toThrow(ConflictException);
      expect(() => assertDriverActive({ isActive: true })).not.toThrow();
      expect(driverInactiveConflict().getResponse()).toMatchObject({ statusCode: 409, code: 'DRIVER_INACTIVE' });
    });
  });
});
