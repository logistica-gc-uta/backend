import { Injectable, UnauthorizedException } from '@nestjs/common';
import { driverRouteDay } from './driver-route-date.util.js';
import { PrismaService } from '../../database/prisma.service.js';

@Injectable()
export class DriversService {
  constructor(private readonly prisma: PrismaService) {}

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
      .select('id', 'date')
      .orderBy((route) => route.date.asc())
      .orderBy((route) => route.id.asc())
      .include('zone', (zone) => zone.select('id', 'name', 'code'))
      .include('orders', (orders) =>
        orders.select(
          'id',
          'deliveryAddress',
          'status',
          'scheduledDeliveryDate',
          'stopOrder',
        ),
      )
      .all();

    return routes.map((route) => ({
      id: route.id,
      date: route.date,
      zone: route.zone,
      orders: [...route.orders].sort(
        (a, b) =>
          (a.stopOrder ?? Infinity) - (b.stopOrder ?? Infinity) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      ),
    }));
  }

  async findAll() {
    return this.prisma.driver.include('user').all();
  }
}
