import { PrismaService } from '../../database/prisma.service.js';
import { RouteAvailabilityService } from './route-availability.service.js';

/** Disponibilidad por día operativo (#44): la ausencia se suma a las reservas/rutas sin sustituirlas. */
describe('RouteAvailabilityService con ausencias por fecha', () => {
  const day = (iso: string) => Temporal.PlainDate.from(iso);
  const evaluate = (options: { absences?: unknown[]; routes?: unknown[]; reservations?: unknown[]; flag?: boolean }, forDay?: Temporal.PlainDate) => {
    const model = (rows: unknown[]) => ({ where: () => ({ all: async () => rows, first: async () => rows[0] ?? null }) });
    const tx = {
      orm: {
        public: {
          Route: model(options.routes ?? []),
          DriverReservation: model(options.reservations ?? []),
          LegacyRouteReconciliation: model([]),
          Driver: model([{ isAvailable: options.flag ?? true }]),
          DriverAbsence: model(options.absences ?? []),
          User: { where: () => ({ first: async () => ({ role: 'ADMIN' }) }) },
        },
      },
    };
    return new RouteAvailabilityService({ client: tx } as unknown as PrismaService).effective('driver', undefined, forDay);
  };
  const absent = (startDate: string, endDate: string, extra: Record<string, unknown> = {}) => ({
    id: `absence-${startDate}`, startDate, endDate, reason: null, cancelledAt: null, ...extra,
  });

  it('sin día conserva exactamente la forma histórica y no consulta ausencias', async () => {
    const result = await evaluate({ absences: [absent('2030-01-01', '2030-12-31')] });
    expect(result).toEqual({ isAvailable: true, hasPersistedHolds: false, compatibilityFlagBlocks: false, blockingRouteIds: [] });
  });

  it('ausente ese día: no elegible, sin inventar bloqueos de ruta, y expone la ausencia', async () => {
    const result = await evaluate({ absences: [absent('2030-02-14', '2030-02-15', { reason: 'Cita' })] }, day('2030-02-14'));
    expect(result).toMatchObject({
      isAvailable: false, hasPersistedHolds: false, compatibilityFlagBlocks: false, blockingRouteIds: [],
      date: '2030-02-14', absence: { startDate: '2030-02-14', endDate: '2030-02-15', reason: 'Cita' },
    });
  });

  it.each(['2030-02-13', '2030-02-16'])('una ausencia de otros días (%s) no bloquea ese día', async (other) => {
    const result = await evaluate({ absences: [absent('2030-02-14', '2030-02-15')] }, day(other));
    expect(result).toMatchObject({ isAvailable: true, absence: null, date: other });
  });

  it('el rango es cerrado: incluye el primer y el último día', async () => {
    const absences = [absent('2030-02-14', '2030-02-16')];
    for (const included of ['2030-02-14', '2030-02-15', '2030-02-16']) {
      expect((await evaluate({ absences }, day(included))).isAvailable).toBe(false);
    }
  });

  it('una ausencia anulada no bloquea', async () => {
    const cancelled = absent('2030-02-14', '2030-02-15', { cancelledAt: '2030-02-10T00:00:00Z' });
    expect(await evaluate({ absences: [cancelled] }, day('2030-02-14'))).toMatchObject({ isAvailable: true, absence: null });
  });

  it('las reservas siguen bloqueando aunque no haya ausencia, y la ausencia no las libera ni las crea', async () => {
    const held = await evaluate({ reservations: [{ routeId: 'route' }] }, day('2030-02-14'));
    expect(held).toMatchObject({ isAvailable: false, hasPersistedHolds: true, blockingRouteIds: ['route'], absence: null });
    const both = await evaluate({ reservations: [{ routeId: 'route' }], absences: [absent('2030-02-14', '2030-02-14')] }, day('2030-02-14'));
    expect(both).toMatchObject({ isAvailable: false, hasPersistedHolds: true, blockingRouteIds: ['route'] });
    expect(both.absence).not.toBeNull();
  });

  it('si hay dos ausencias que cubren el día se informa la que empieza antes (determinista)', async () => {
    const result = await evaluate({ absences: [absent('2030-02-14', '2030-02-20', { id: 'b' }), absent('2030-02-10', '2030-02-14', { id: 'a' })] }, day('2030-02-14'));
    expect(result.absence).toMatchObject({ id: 'a' });
  });
});
