import { RouteHistoryService } from '../routes/route-history.service.js';
import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { emailAlreadyExists, isEmailUniqueViolation, normalizedEmail } from '../auth/email-identity.util.js';
import { hashNewPassword } from '../auth/password-hash.util.js';
import type { CreateDriverDto } from './dto/create-driver.dto.js';
import type { UpdateDriverDto } from './dto/update-driver.dto.js';
import { RouteAvailabilityService } from '../routes/route-availability.service.js';
import { DriverAvailabilityResponseDto } from '../routes/dto/driver-availability-response.dto.js';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { driverRouteDay } from './driver-route-date.util.js';
import { nowInstant } from '../../common/temporal.util.js';
import type { ChangeDriverStatusDto } from './dto/driver-status.dto.js';
import { PrismaService } from '../../database/prisma.service.js';

@Injectable()
export class DriversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: RouteAvailabilityService,
    private readonly history: RouteHistoryService,
  ) {}

  async findMyRoutes(userId: string, date?: string) {
    const day = driverRouteDay(date);
    if (!userId) throw new UnauthorizedException();
    const driver = await this.prisma.driver.where({ userId }).first();
    if (!driver) return [];

    let query = this.prisma.route.where({ driverId: driver.id });
    if (day) {
      query = query
        .where((route) => route.date.gte(day.start))
        .where((route) => route.date.lt(day.end));
    }
    const routes = await query
      .select(
        'id',
        'date',
        'status',
        'startedAt',
        'startedById',
        'completedAt',
        'completedById',
        'returnedAt',
        'returnedById',
      )
      .orderBy((route) => route.date.asc())
      .orderBy((route) => route.id.asc())
      .include('zone', (zone) => zone.select('id', 'name', 'code'))
      .all();
    const activeRoutes = routes.filter((route) => route.status !== 'CANCELLED');
    return this.history.project(activeRoutes);
  }

  async findMyAvailability(
    userId: string,
  ): Promise<DriverAvailabilityResponseDto> {
    if (!userId) throw new UnauthorizedException('Authenticated user required');
    const driver = await this.prisma.driver.where({ userId }).first();
    if (!driver) throw new NotFoundException('Driver profile not found');
    return this.availability.effective(driver.id);
  }

  async findAll() {
    const drivers = await this.prisma.driver
      .include('user', (user) =>
        user.select('id', 'name', 'email', 'role', 'createdAt'),
      )
      .all();
    return Promise.all(
      drivers.map(async (driver) => ({
        ...driver,
        effectiveAvailability: await this.availability.effective(driver.id),
      })),
    );
  }

  /** Perfil con la misma forma que `findAll`, sin hash ni secretos. */
  private async profile(driverId: string) {
    const driver = await this.prisma.driver
      .where({ id: driverId })
      .include('user', (user) =>
        user.select('id', 'name', 'email', 'role', 'createdAt'),
      )
      .first();
    if (!driver) throw new NotFoundException('Driver profile not found');
    return {
      ...driver,
      effectiveAvailability: await this.availability.effective(driver.id),
    };
  }

  /**
   * Alta ADMIN: crea la identidad DRIVER y su perfil en UNA transacción (si algo falla no queda ni usuario
   * ni perfil). El rol lo fija el servidor. El acceso inicial es una contraseña temporal aleatoria generada
   * aquí, guardada solo con hash y devuelta una única vez.
   */
  async create(dto: CreateDriverDto) {
    const email = normalizedEmail(dto.email);
    const temporaryPassword = randomBytes(18).toString('base64url');
    const password = await hashNewPassword(temporaryPassword);

    let driverId: string;
    try {
      driverId = await this.prisma.client.transaction(async (tx) => {
        if (await this.emailTaken(tx, email)) throw emailAlreadyExists();
        const user = await tx.orm.public.User.create({
          name: dto.name.trim(),
          email,
          password,
          role: 'DRIVER',
        });
        const driver = await tx.orm.public.Driver.create({
          userId: user.id,
          vehicle: dto.vehicle.trim(),
          vehicleCapacity: dto.vehicleCapacity ?? null,
          isAvailable: true,
        });
        return driver.id;
      });
    } catch (error) {
      if (isEmailUniqueViolation(error)) throw emailAlreadyExists();
      throw error;
    }
    return { ...(await this.profile(driverId)), temporaryPassword };
  }

  /**
   * Corrección ADMIN de nombre, correo, vehículo y capacidad. Bloquea la fila del repartidor y NO toca `isAvailable`,
   * el rol, las rutas ni las reservas: corregir un dato no libera a un repartidor ocupado ni reasigna nada.
   */
  async update(driverId: string, dto: UpdateDriverDto) {
    if (
      dto.name === undefined &&
      dto.email === undefined &&
      dto.vehicle === undefined &&
      dto.vehicleCapacity === undefined
    ) {
      throw new BadRequestException('Indica al menos un campo: name, email, vehicle o vehicleCapacity');
    }
    try {
      await this.prisma.client.transaction(async (tx) => {
        const driver = await tx.orm.public.Driver.where({ id: driverId }).first();
        if (!driver) throw new NotFoundException('Driver profile not found');
        // Mismo patrón de bloqueo que la asignación de rutas: serializa contra asignaciones simultáneas.
        const locked = await tx.orm.public.Driver.where({ id: driverId, userId: driver.userId }).update({ userId: driver.userId });
        if (!locked) throw new NotFoundException('Driver profile changed during update');

        const userChanges: { name?: string; email?: string } = {};
        if (dto.name !== undefined) userChanges.name = dto.name.trim();
        if (dto.email !== undefined) {
          const email = normalizedEmail(dto.email);
          if (await this.emailTaken(tx, email, driver.userId)) throw emailAlreadyExists();
          userChanges.email = email;
        }
        if (Object.keys(userChanges).length) {
          if (!(await tx.orm.public.User.where({ id: driver.userId }).update(userChanges))) {
            throw new NotFoundException('Driver identity not found');
          }
        }
        const driverChanges: { vehicle?: string; vehicleCapacity?: number | null } = {};
        if (dto.vehicle !== undefined) driverChanges.vehicle = dto.vehicle.trim();
        if (dto.vehicleCapacity !== undefined) driverChanges.vehicleCapacity = dto.vehicleCapacity;
        if (Object.keys(driverChanges).length) {
          await tx.orm.public.Driver.where({ id: driverId, userId: driver.userId }).update(driverChanges);
        }
      });
    } catch (error) {
      if (isEmailUniqueViolation(error)) throw emailAlreadyExists();
      throw error;
    }
    return this.profile(driverId);
  }

  /**
   * Baja operativa reversible (#82). Dentro de UNA transacción y con la fila del repartidor bloqueada (el mismo bloqueo que la
   * asignación de rutas): si tiene una ruta asignada, en curso o terminada/interrumpida sin regreso confirmado, o una reserva
   * viva, responde 409 `DRIVER_HAS_OPEN_ROUTE` y no cambia nada. No borra usuarios, rutas ni historial, y no toca las ausencias.
   */
  async deactivate(driverId: string, dto: ChangeDriverStatusDto, actorId: string) {
    await this.prisma.client.transaction(async (tx) => {
      const driver = await this.lockDriver(tx, driverId);
      if (driver.isActive === false) {
        throw new ConflictException({
          statusCode: 409,
          message: 'El repartidor ya está dado de baja',
          error: 'Conflict',
          code: 'DRIVER_ALREADY_INACTIVE',
        });
      }
      const holds = await this.availability.effective(driverId, tx);
      if (holds.hasPersistedHolds) {
        const blocking = [];
        for (const routeId of holds.blockingRouteIds) {
          const route = await tx.orm.public.Route.where({ id: routeId }).first();
          blocking.push({ routeId, status: route?.status ?? null, returnConfirmed: Boolean(route?.returnedAt) });
        }
        throw new ConflictException({
          statusCode: 409,
          message:
            'El repartidor tiene una ruta asignada, en curso o terminada sin regreso al depósito confirmado: resuélvela antes de darlo de baja',
          error: 'Conflict',
          code: 'DRIVER_HAS_OPEN_ROUTE',
          blockingRoutes: blocking,
        });
      }
      await this.recordStatus(tx, driver, false, dto.reason ?? null, actorId);
    });
    return this.profile(driverId);
  }

  /** Reactivación (#82): restablece el acceso y nada más; ausencias, reservas y bandera de disponibilidad no se tocan. */
  async activate(driverId: string, dto: ChangeDriverStatusDto, actorId: string) {
    await this.prisma.client.transaction(async (tx) => {
      const driver = await this.lockDriver(tx, driverId);
      if (driver.isActive !== false) {
        throw new ConflictException({
          statusCode: 409,
          message: 'El repartidor ya está activo',
          error: 'Conflict',
          code: 'DRIVER_ALREADY_ACTIVE',
        });
      }
      await this.recordStatus(tx, driver, true, dto.reason ?? null, actorId);
    });
    return this.profile(driverId);
  }

  /** Historial append-only de bajas y reactivaciones, del más reciente al más antiguo. */
  async statusHistory(driverId: string) {
    if (!(await this.prisma.driver.where({ id: driverId }).first())) throw new NotFoundException('Driver profile not found');
    const rows = await this.prisma.client.orm.public.DriverStatusChange.where({ driverId }).all();
    return rows
      .sort((a, b) => Temporal.Instant.compare(b.createdAt, a.createdAt) || b.id.localeCompare(a.id))
      .map((row) => ({
        id: row.id,
        active: row.active,
        reason: row.reason ?? null,
        actorId: row.actorId,
        createdAt: row.createdAt.toString(),
      }));
  }

  private async recordStatus(
    tx: Parameters<Parameters<PrismaService['client']['transaction']>[0]>[0],
    driver: { id: string; userId: string },
    active: boolean,
    reason: string | null,
    actorId: string,
  ) {
    const at = nowInstant();
    await tx.orm.public.DriverStatusChange.create({ driverId: driver.id, active, reason, actorId, createdAt: at });
    await tx.orm.public.Driver.where({ id: driver.id, userId: driver.userId }).update({
      isActive: active,
      statusChangedAt: at,
      statusChangedById: actorId,
      statusReason: reason,
    });
  }

  /** Mismo bloqueo que la asignación de rutas y las ausencias: serializa la baja contra una asignación simultánea. */
  private async lockDriver(
    tx: Parameters<Parameters<PrismaService['client']['transaction']>[0]>[0],
    driverId: string,
  ) {
    const driver = await tx.orm.public.Driver.where({ id: driverId }).first();
    if (!driver) throw new NotFoundException('Driver profile not found');
    const locked = await tx.orm.public.Driver.where({ id: driverId, userId: driver.userId }).update({ userId: driver.userId });
    if (!locked) throw new ConflictException('Driver profile changed during the status change');
    return locked;
  }

  private async emailTaken(
    tx: Parameters<Parameters<PrismaService['client']['transaction']>[0]>[0],
    email: string,
    exceptUserId?: string,
  ): Promise<boolean> {
    const query = this.prisma.client.raw.sql`
      SELECT "id" FROM public."user"
      WHERE lower("email") = ${email} AND "id" <> ${exceptUserId ?? ''}
      LIMIT 1
    `
      .returnsRow({ id: 'pg/text@1' })
      .build();
    return (await tx.query(query)).length > 0;
  }
}
