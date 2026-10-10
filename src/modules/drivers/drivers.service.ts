import { RouteHistoryService } from '../routes/route-history.service.js';
import { NotFoundException } from '@nestjs/common';
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
    const drivers = await this.prisma.driver.include('user').all();
    return Promise.all(
      drivers.map(async (driver) => ({
        ...driver,
        effectiveAvailability: await this.availability.effective(driver.id),
      })),
    );
  }
}
