import { RouteAvailabilityService } from '../routes/route-availability.service.js';
import { DriverAbsencesService } from './driver-absences.service.js';

const plus = (days: number) => Temporal.Now.zonedDateTimeISO('America/Guayaquil').toPlainDate().add({ days }).toString();
const at = (offset: number) => Temporal.Instant.from(`${plus(offset)}T15:00:00Z`);

/** Base de datos en memoria con la forma mínima del ORM que usa el servicio. */
function setup(initial: { routes?: any[]; orders?: any[]; absences?: any[]; drivers?: any[]; failLock?: boolean } = {}) {
  const withDefaults = (row: any) => ({ reason: null, cancelledAt: null, cancelledById: null, cancelReason: null, createdAt: Temporal.Now.instant(), ...row });
  const tables: Record<string, any[]> = {
    Driver: initial.drivers ?? [{ id: 'driver', userId: 'driver-user', isAvailable: true }],
    DriverAbsence: (initial.absences ?? []).map(withDefaults),
    Route: initial.routes ?? [],
    Order: initial.orders ?? [],
    DriverReservation: [],
    LegacyRouteReconciliation: [],
  };
  const match = (filter: Record<string, unknown>) => (row: any) => Object.entries(filter).every(([key, value]) => row[key] === value);
  const model = (name: string) => ({
    where: (filter: Record<string, unknown>) => ({
      first: async () => tables[name]!.find(match(filter)) ?? null,
      all: async () => tables[name]!.filter(match(filter)),
      update: async (value: Record<string, unknown>) => {
        if (initial.failLock && name === 'Driver') return null;
        const row = tables[name]!.find(match(filter));
        return row ? Object.assign(row, value) : null;
      },
    }),
    create: async (value: any) => {
      const row = withDefaults(value);
      tables[name]!.push(row);
      return row;
    },
  });
  const orm = { public: Object.fromEntries(Object.keys(tables).map((name) => [name, model(name)])) };
  const client = { orm, transaction: jest.fn(async (fn: any) => fn({ orm })) };
  const prisma: any = { client, driver: orm.public.Driver };
  const availability = new RouteAvailabilityService(prisma);
  return { tables, service: new DriverAbsencesService(prisma, availability), client };
}

describe('DriverAbsencesService (#44) con una base de datos en memoria', () => {
  describe('create', () => {
    it('registra la ausencia con quién la creó y sin conflictos cuando no hay rutas', async () => {
      const { service, tables } = setup();
      const result = await service.create('driver', { startDate: plus(1), endDate: plus(2), reason: 'Cita' }, 'admin');
      expect(result).toMatchObject({ driverId: 'driver', startDate: plus(1), endDate: plus(2), reason: 'Cita', status: 'ACTIVE', createdById: 'admin', conflicts: [] });
      expect(tables.DriverAbsence).toHaveLength(1);
    });

    it('un repartidor inexistente da 404 sin crear nada', async () => {
      const { service, tables } = setup({ drivers: [] });
      await expect(service.create('nadie', { startDate: plus(1), endDate: plus(1) }, 'admin')).rejects.toMatchObject({ status: 404 });
      expect(tables.DriverAbsence).toHaveLength(0);
    });

    it('un rango que se cruza con una ausencia activa da ABSENCE_OVERLAP y no crea otra', async () => {
      const { service, tables } = setup({ absences: [{ id: 'a1', driverId: 'driver', startDate: plus(2), endDate: plus(4), createdById: 'admin' }] });
      await expect(service.create('driver', { startDate: plus(4), endDate: plus(5) }, 'admin')).rejects.toMatchObject({ response: { code: 'ABSENCE_OVERLAP', absenceId: 'a1' } });
      expect(tables.DriverAbsence).toHaveLength(1);
    });

    it('no considera las ausencias anuladas ni las contiguas como cruce', async () => {
      const { service } = setup({
        absences: [
          { id: 'old', driverId: 'driver', startDate: plus(2), endDate: plus(4), createdById: 'admin', cancelledAt: Temporal.Now.instant() },
          { id: 'next', driverId: 'driver', startDate: plus(6), endDate: plus(7), createdById: 'admin' },
        ],
      });
      await expect(service.create('driver', { startDate: plus(2), endDate: plus(5) }, 'admin')).resolves.toMatchObject({ status: 'ACTIVE' });
    });

    it('lista como conflicto las rutas asignadas o en curso dentro del rango, con sus pedidos, y omite el resto', async () => {
      const { service } = setup({
        routes: [
          { id: 'r-assigned', driverId: 'driver', status: 'ASSIGNED', date: at(1) },
          { id: 'r-progress', driverId: 'driver', status: 'IN_PROGRESS', date: at(1) },
          { id: 'r-draft', driverId: 'driver', status: 'DRAFT', date: at(1) },
          { id: 'r-outside', driverId: 'driver', status: 'ASSIGNED', date: at(9) },
          { id: 'r-other', driverId: 'otro', status: 'ASSIGNED', date: at(1) },
        ],
        orders: [{ id: 'o2', routeId: 'r-assigned' }, { id: 'o1', routeId: 'r-assigned' }, { id: 'o3', routeId: 'r-progress' }],
      });
      const result = await service.create('driver', { startDate: plus(1), endDate: plus(2) }, 'admin');
      expect(result.conflicts.map((c) => [c.routeId, c.status, c.orderIds])).toEqual([
        ['r-assigned', 'ASSIGNED', ['o1', 'o2']],
        ['r-progress', 'IN_PROGRESS', ['o3']],
      ]);
    });
  });

  describe('list', () => {
    const absences = [
      { id: 'b', driverId: 'driver', startDate: plus(5), endDate: plus(6), createdById: 'admin' },
      { id: 'a', driverId: 'driver', startDate: plus(1), endDate: plus(2), createdById: 'admin' },
      { id: 'c', driverId: 'driver', startDate: plus(3), endDate: plus(3), createdById: 'admin', cancelledAt: Temporal.Now.instant(), cancelledById: 'admin' },
      { id: 'past', driverId: 'driver', startDate: plus(-9), endDate: plus(-8), createdById: 'admin' },
      { id: 'foreign', driverId: 'otro', startDate: plus(1), endDate: plus(2), createdById: 'admin' },
    ];

    it('devuelve las activas que no han terminado, ordenadas por fecha, y oculta las anuladas', async () => {
      const { service } = setup({ absences });
      expect((await service.list('driver', {})).map((a) => a.id)).toEqual(['a', 'b']);
    });

    it('con includeCancelled incluye las anuladas y con from filtra por fin', async () => {
      const { service } = setup({ absences });
      expect((await service.list('driver', { includeCancelled: true })).map((a) => [a.id, a.status])).toEqual([['a', 'ACTIVE'], ['c', 'CANCELLED'], ['b', 'ACTIVE']]);
      expect((await service.list('driver', { from: plus(4) })).map((a) => a.id)).toEqual(['b']);
    });

    it('un repartidor inexistente da 404 y una fecha inválida 400', async () => {
      const { service } = setup({ absences });
      await expect(service.list('nadie', {})).rejects.toMatchObject({ status: 404 });
      await expect(service.list('driver', { from: '2030-02-30' })).rejects.toMatchObject({ response: { code: 'INVALID_DATE' } });
    });
  });

  describe('cancel', () => {
    const active = () => ({ id: 'a1', driverId: 'driver', startDate: plus(1), endDate: plus(3), createdById: 'admin' });

    it('marca quién y cuándo anula y no borra el registro', async () => {
      const { service, tables } = setup({ absences: [active()] });
      const result = await service.cancel('driver', 'a1', { reason: 'Se reincorpora' }, 'admin-2');
      expect(result).toMatchObject({ status: 'CANCELLED', cancelledById: 'admin-2', cancelReason: 'Se reincorpora', conflicts: [] });
      expect(tables.DriverAbsence).toHaveLength(1);
    });

    it('anular sin motivo deja el motivo en null', async () => {
      const { service } = setup({ absences: [active()] });
      expect(await service.cancel('driver', 'a1', {}, 'admin')).toMatchObject({ cancelReason: null });
    });

    it('rechaza una ausencia inexistente, de otro repartidor, ya anulada o ya terminada, sin modificarla', async () => {
      const { service, tables } = setup({
        absences: [
          active(),
          { id: 'done', driverId: 'driver', startDate: plus(-5), endDate: plus(-4), createdById: 'admin' },
          { id: 'cancelled', driverId: 'driver', startDate: plus(1), endDate: plus(2), createdById: 'admin', cancelledAt: Temporal.Now.instant(), cancelledById: 'admin' },
        ],
      });
      await expect(service.cancel('driver', 'nope', {}, 'admin')).rejects.toMatchObject({ status: 404 });
      await expect(service.cancel('otro', 'a1', {}, 'admin')).rejects.toMatchObject({ status: 404 });
      await expect(service.cancel('driver', 'cancelled', {}, 'admin')).rejects.toMatchObject({ response: { code: 'ABSENCE_ALREADY_CANCELLED' } });
      await expect(service.cancel('driver', 'done', {}, 'admin')).rejects.toMatchObject({ response: { code: 'ABSENCE_ALREADY_ELAPSED' } });
      expect(tables.DriverAbsence.find((a) => a.id === 'a1').cancelledAt).toBeNull();
      expect(tables.DriverAbsence.find((a) => a.id === 'done').cancelledAt).toBeNull();
    });
  });

  describe('availabilityOn', () => {
    it('usa hoy por defecto y expone la ausencia de ese día', async () => {
      const { service } = setup({ absences: [{ id: 'a1', driverId: 'driver', startDate: plus(0), endDate: plus(0), createdById: 'admin' }] });
      expect(await service.availabilityOn('driver')).toMatchObject({ date: plus(0), isAvailable: false, absence: { id: 'a1' } });
    });

    it('una fecha futura sin ausencia es elegible y una ausencia de otro día no bloquea', async () => {
      const { service } = setup({ absences: [{ id: 'a1', driverId: 'driver', startDate: plus(0), endDate: plus(0), createdById: 'admin' }] });
      expect(await service.availabilityOn('driver', plus(3))).toMatchObject({ date: plus(3), isAvailable: true, absence: null });
    });

    it('rechaza fechas pasadas y repartidores inexistentes', async () => {
      const { service } = setup();
      await expect(service.availabilityOn('driver', plus(-1))).rejects.toMatchObject({ response: { code: 'AVAILABILITY_DATE_IN_PAST' } });
      await expect(service.availabilityOn('nadie', plus(1))).rejects.toMatchObject({ status: 404 });
    });
  });

  it('el bloqueo del repartidor falla con 409 si el perfil cambia durante la operación y no deja nada', async () => {
    const { service, tables } = setup({ failLock: true });
    await expect(service.create('driver', { startDate: plus(1), endDate: plus(1) }, 'admin')).rejects.toMatchObject({ status: 409 });
    expect(tables.DriverAbsence).toHaveLength(0);
  });
});
