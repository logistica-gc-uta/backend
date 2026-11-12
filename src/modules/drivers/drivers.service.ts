import { RouteHistoryService } from '../routes/route-history.service.js';
import { randomBytes } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { emailAlreadyExists, isEmailUniqueViolation, normalizedEmail } from '../auth/email-identity.util.js';
import { hashNewPassword } from '../auth/password-hash.util.js';
import type { CreateDriverDto } from './dto/create-driver.dto.js';
import type { UpdateDriverDto } from './dto/update-driver.dto.js';
import { RouteAvailabilityService } from '../routes/route-availability.service.js';
import { DriverAvailabilityResponseDto } from '../routes/dto/driver-availability-response.dto.js';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { driverRouteDay } from './driver-route-date.util.js';
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
    return this.history.project(routes);
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
   * Corrección ADMIN de nombre, correo y vehículo. Bloquea la fila del repartidor y NO toca `isAvailable`,
   * el rol, las rutas ni las reservas: corregir un dato no libera a un repartidor ocupado ni reasigna nada.
   */
  async update(driverId: string, dto: UpdateDriverDto) {
    if (dto.name === undefined && dto.email === undefined && dto.vehicle === undefined) {
      throw new BadRequestException('Indica al menos un campo: name, email o vehicle');
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
        if (dto.vehicle !== undefined) {
          await tx.orm.public.Driver.where({ id: driverId, userId: driver.userId }).update({ vehicle: dto.vehicle.trim() });
        }
      });
    } catch (error) {
      if (isEmailUniqueViolation(error)) throw emailAlreadyExists();
      throw error;
    }
    return this.profile(driverId);
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
