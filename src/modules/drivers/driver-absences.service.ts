import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { businessDay, nowInstant } from '../../common/temporal.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RouteAvailabilityService } from '../routes/route-availability.service.js';
import type {
  CancelDriverAbsenceDto,
  CreateDriverAbsenceDto,
  ListDriverAbsencesQueryDto,
} from './dto/driver-absence.dto.js';

type Tx = Parameters<Parameters<PrismaService['client']['transaction']>[0]>[0];

function dayError(field: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    message: `${field} debe ser una fecha de calendario válida YYYY-MM-DD`,
    error: 'Bad Request',
    code: 'INVALID_DATE',
  });
}

/** Día de calendario estricto (rechaza 2030-02-30). Se compara como texto ISO, que ordena igual que las fechas. */
function parseDay(value: string, field: string): Temporal.PlainDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw dayError(field);
  try {
    return Temporal.PlainDate.from(value, { overflow: 'reject' });
  } catch {
    throw dayError(field);
  }
}

const today = (): Temporal.PlainDate => businessDay(nowInstant());

/**
 * Ausencias de repartidores por rango de días operativos (#44).
 * - Una ausencia es un calendario, distinto de la reserva por una ruta y de la bandera `Driver.isAvailable`.
 * - Registrar una ausencia con ruta asignada NO cancela, libera ni reasigna nada: se informa el conflicto.
 * - Levantar (anular) una ausencia NO libera reservas operativas pendientes.
 * - Las ausencias no se editan ni se borran: se anulan (auditado) y, si hace falta, se registra otra.
 */
@Injectable()
export class DriverAbsencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: RouteAvailabilityService,
  ) {}

  async create(driverId: string, dto: CreateDriverAbsenceDto, actorId: string) {
    const start = parseDay(dto.startDate, 'startDate');
    const end = parseDay(dto.endDate, 'endDate');
    if (Temporal.PlainDate.compare(start, today()) < 0) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'La ausencia debe empezar hoy o en una fecha futura',
        error: 'Bad Request',
        code: 'ABSENCE_DATE_IN_PAST',
      });
    }
    if (Temporal.PlainDate.compare(end, start) < 0) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'endDate no puede ser anterior a startDate',
        error: 'Bad Request',
        code: 'ABSENCE_RANGE_INVALID',
      });
    }

    const id = randomUUID();
    const conflicts = await this.prisma.client.transaction(async (tx) => {
      await this.lockDriver(tx, driverId);
      const overlapping = (await tx.orm.public.DriverAbsence.where({ driverId, cancelledAt: null }).all()).find(
        (row) => row.startDate <= end.toString() && start.toString() <= row.endDate,
      );
      if (overlapping) {
        throw new ConflictException({
          statusCode: 409,
          message: 'Ya existe una ausencia activa que se cruza con ese rango',
          error: 'Conflict',
          code: 'ABSENCE_OVERLAP',
          absenceId: overlapping.id,
        });
      }
      await tx.orm.public.DriverAbsence.create({
        id,
        driverId,
        startDate: start.toString(),
        endDate: end.toString(),
        reason: dto.reason ?? null,
        createdById: actorId,
      });
      return this.conflictsFor(tx, driverId, start, end);
    });
    return this.view(await this.requireAbsence(driverId, id), conflicts);
  }

  async list(driverId: string, query: ListDriverAbsencesQueryDto) {
    await this.requireDriver(driverId);
    const from = query.from ? parseDay(query.from, 'from') : today();
    const rows = (await this.prisma.client.orm.public.DriverAbsence.where({ driverId }).all())
      .filter((row) => (query.includeCancelled || !row.cancelledAt) && row.endDate >= from.toString())
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
    return Promise.all(
      rows.map(async (row) =>
        this.view(
          row,
          row.cancelledAt ? [] : await this.conflictsFor(this.prisma.client, driverId, parseDay(row.startDate, 'startDate'), parseDay(row.endDate, 'endDate')),
        ),
      ),
    );
  }

  async cancel(driverId: string, absenceId: string, dto: CancelDriverAbsenceDto, actorId: string) {
    await this.prisma.client.transaction(async (tx) => {
      await this.lockDriver(tx, driverId);
      const absence = await tx.orm.public.DriverAbsence.where({ id: absenceId, driverId }).first();
      if (!absence) throw new NotFoundException('Driver absence not found');
      if (absence.cancelledAt) {
        throw new ConflictException({
          statusCode: 409,
          message: 'La ausencia ya estaba anulada',
          error: 'Conflict',
          code: 'ABSENCE_ALREADY_CANCELLED',
        });
      }
      if (absence.endDate < today().toString()) {
        throw new ConflictException({
          statusCode: 409,
          message: 'La ausencia ya terminó: el historial no se modifica',
          error: 'Conflict',
          code: 'ABSENCE_ALREADY_ELAPSED',
        });
      }
      // Solo se marca la anulación: las reservas y rutas del repartidor no se tocan.
      await tx.orm.public.DriverAbsence.where({ id: absenceId, driverId }).update({
        cancelledAt: nowInstant(),
        cancelledById: actorId,
        cancelReason: dto.reason ?? null,
      });
    });
    return this.view(await this.requireAbsence(driverId, absenceId), []);
  }

  /** Disponibilidad efectiva de un día operativo: reservas/rutas persistidas + bandera + ausencia. */
  async availabilityOn(driverId: string, date?: string) {
    const day = date ? parseDay(date, 'date') : today();
    if (Temporal.PlainDate.compare(day, today()) < 0) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Solo se consulta la disponibilidad de hoy o de fechas futuras',
        error: 'Bad Request',
        code: 'AVAILABILITY_DATE_IN_PAST',
      });
    }
    await this.requireDriver(driverId);
    return this.availability.effective(driverId, undefined, day);
  }

  private async requireDriver(driverId: string) {
    const driver = await this.prisma.driver.where({ id: driverId }).first();
    if (!driver) throw new NotFoundException('Driver profile not found');
    return driver;
  }

  private async requireAbsence(driverId: string, id: string) {
    const row = await this.prisma.client.orm.public.DriverAbsence.where({ id, driverId }).first();
    if (!row) throw new NotFoundException('Driver absence not found');
    return row;
  }

  /** Mismo bloqueo que la asignación de rutas: serializa el registro de la ausencia contra una asignación concurrente. */
  private async lockDriver(tx: Tx, driverId: string) {
    const driver = await tx.orm.public.Driver.where({ id: driverId }).first();
    if (!driver) throw new NotFoundException('Driver profile not found');
    const locked = await tx.orm.public.Driver.where({ id: driverId, userId: driver.userId }).update({ userId: driver.userId });
    if (!locked) throw new ConflictException('Driver profile changed during the absence operation');
    return locked;
  }

  /** Rutas asignadas o en curso del repartidor dentro del rango: solo informativo, no se modifican. */
  private async conflictsFor(
    reader: Pick<Tx, 'orm'>,
    driverId: string,
    start: Temporal.PlainDate,
    end: Temporal.PlainDate,
  ) {
    const from = start.toZonedDateTime('America/Guayaquil').toInstant();
    const until = end.add({ days: 1 }).toZonedDateTime('America/Guayaquil').toInstant();
    const routes = (await reader.orm.public.Route.where({ driverId }).all()).filter(
      (route) =>
        (route.status === 'ASSIGNED' || route.status === 'IN_PROGRESS') &&
        Temporal.Instant.compare(route.date, from) >= 0 &&
        Temporal.Instant.compare(route.date, until) < 0,
    );
    return Promise.all(
      routes
        .sort((a, b) => Temporal.Instant.compare(a.date, b.date) || a.id.localeCompare(b.id))
        .map(async (route) => ({
          routeId: route.id,
          status: route.status as string,
          date: route.date.toString(),
          orderIds: (await reader.orm.public.Order.where({ routeId: route.id }).all()).map((order) => order.id).sort(),
        })),
    );
  }

  private view(row: any, conflicts: { routeId: string; status: string; date: string; orderIds: string[] }[]) {
    return {
      id: row.id as string,
      driverId: row.driverId as string,
      startDate: row.startDate as string,
      endDate: row.endDate as string,
      reason: (row.reason ?? null) as string | null,
      status: row.cancelledAt ? 'CANCELLED' : 'ACTIVE',
      createdById: row.createdById as string,
      createdAt: row.createdAt.toString() as string,
      cancelledAt: (row.cancelledAt ? row.cancelledAt.toString() : null) as string | null,
      cancelledById: (row.cancelledById ?? null) as string | null,
      cancelReason: (row.cancelReason ?? null) as string | null,
      conflicts,
    };
  }
}
