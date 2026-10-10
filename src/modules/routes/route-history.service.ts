import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { RouteHistoryEventDto } from './dto/route-history-response.dto.js';

type RouteAudit = {
  id: string;
  status?: string | null;
  startedAt?: { toString(): string } | null;
  startedById?: string | null;
  completedAt?: { toString(): string } | null;
  completedById?: string | null;
  returnedAt?: { toString(): string } | null;
  returnedById?: string | null;
};

@Injectable()
export class RouteHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async project<T extends RouteAudit>(
    routes: T[],
    fullCommercialFields = false,
  ) {
    if (!routes.length) return [];
    const stops = await this.prisma.client.orm.public.RouteStop.where((stop) =>
      stop.routeId.in(routes.map((route) => route.id)),
    )
      .include('order')
      .all();
    const attempts = stops.length
      ? await this.prisma.client.orm.public.DeliveryAttempt.where((attempt) =>
          attempt.stopId.in(stops.map((stop) => stop.id)),
        ).all()
      : [];
    const byStop = new Map<string, typeof attempts>();
    for (const attempt of attempts) {
      const group = byStop.get(attempt.stopId) ?? [];
      group.push(attempt);
      byStop.set(attempt.stopId, group);
    }
    const byRoute = new Map<string, typeof stops>();
    for (const stop of stops) {
      const group = byRoute.get(stop.routeId) ?? [];
      group.push(stop);
      byRoute.set(stop.routeId, group);
    }
    const directOrders = this.prisma.client.orm.public.Order
      ? await this.prisma.client.orm.public.Order.where((order) =>
          order.routeId.in(routes.map((route) => route.id)),
        ).all()
      : [];
    const directByRoute = new Map<string, typeof directOrders>();
    for (const order of directOrders) {
      const group = directByRoute.get(order.routeId!) ?? [];
      group.push(order);
      directByRoute.set(order.routeId!, group);
    }
    return routes.map((route) => {
      const routeStops = byRoute.get(route.id) ?? [];
      const ordered = routeStops.sort(
        (a, b) =>
          (a.sequence ?? Infinity) - (b.sequence ?? Infinity) ||
          a.id.localeCompare(b.id),
      );
      const events: RouteHistoryEventDto[] = [];
      for (const [kind, time, actor] of [
        ['STARTED', route.startedAt, route.startedById],
        ['COMPLETED', route.completedAt, route.completedById],
        ['RETURNED', route.returnedAt, route.returnedById],
      ] as const) {
        if (time && actor)
          events.push({ kind, actorId: actor, recordedAt: time.toString() });
      }
      const orders = ordered.length
        ? ordered.map(({ order, sequence }) => ({
            ...(fullCommercialFields ? order : {}),
            id: order.id,
            deliveryAddress: order.deliveryAddress,
            status: order.status,
            scheduledDeliveryDate:
              order.scheduledDeliveryDate?.toString() ?? null,
            stopOrder: sequence,
          }))
        : (directByRoute.get(route.id) ?? [])
            .sort(
              (a, b) =>
                (a.stopOrder ?? Infinity) - (b.stopOrder ?? Infinity) ||
                (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
            )
            .map((order) => ({
              ...(fullCommercialFields ? order : {}),
              id: order.id,
              deliveryAddress: order.deliveryAddress,
              status: order.status,
              scheduledDeliveryDate:
                order.scheduledDeliveryDate?.toString() ?? null,
              stopOrder: order.stopOrder,
            }));
      return {
        ...route,
        status: route.status ?? 'UNVERIFIED',
        orders,
        stops: ordered.map(({ order: _order, ...stop }) => ({
          ...stop,
          createdAt: stop.createdAt?.toString() ?? null,
          attempts: (byStop.get(stop.id) ?? [])
            .sort(
              (a, b) =>
                Temporal.Instant.compare(
                  a.recordedAt.toString(),
                  b.recordedAt.toString(),
                ) || a.id.localeCompare(b.id),
            )
            .map((attempt) => ({
              id: attempt.id,
              stopId: attempt.stopId,
              driverId: attempt.driverId,
              recordedAt: attempt.recordedAt.toString(),
              outcome: attempt.outcome,
              failureReason: attempt.failureReason,
              context:
                typeof attempt.context === 'object' &&
                attempt.context !== null &&
                'description' in attempt.context &&
                typeof attempt.context.description === 'string'
                  ? attempt.context.description
                  : null,
            })),
        })),
        events,
      };
    });
  }
}
