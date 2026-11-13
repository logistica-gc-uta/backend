import {
  parseDeliveryTiming,
  assertDeliveryFuture,
  deliveryClock,
} from '../orders/order-delivery.util.js';
import {
  evaluatePlanningEligibility,
  type GeoPoint,
} from '../orders/order-geography.util.js';
import { StoreCoverageService } from '../store-coverage/store-coverage.service.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { businessDay, nowInstant } from '../../common/temporal.util.js';
import { RouteAssignmentService } from './route-assignment.service.js';
import { RouteAvailabilityService } from './route-availability.service.js';
import { RouteUrgencyService } from './route-urgency.service.js';
import { DispatchLossService } from './dispatch-loss.service.js';
import { DispatchEmergencyService } from './dispatch-emergency.service.js';
import {
  canMutateRouteStructure,
  RouteStatus,
} from './route-lifecycle.policy.js';
import {
  DispatchAuditDto,
  DispatchInterventionDto,
} from './dto/dispatch-intervention.dto.js';
import {
  REALTIME_PUBLISHER,
  type RealtimeChange,
  type RealtimePublisher,
} from '../realtime/realtime.contract.js';

type Transaction = Parameters<
  Parameters<PrismaService['client']['transaction']>[0]
>[0];
type Audit = NonNullable<
  Awaited<
    ReturnType<
      PrismaService['client']['orm']['public']['DispatchIntervention']['first']
    >
  >
>;
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );

@Injectable()
export class DispatchInterventionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assignment: RouteAssignmentService,
    private readonly availability: RouteAvailabilityService,
    private readonly urgency: RouteUrgencyService,
    @Optional()
    @Inject(REALTIME_PUBLISHER)
    private readonly realtime?: RealtimePublisher,
    @Optional()
    private readonly storeCoverage?: StoreCoverageService,
    @Optional()
    emergencyService?: DispatchEmergencyService,
  ) {
    this.losses = new DispatchLossService(prisma);
    this.emergencies =
      emergencyService ?? new DispatchEmergencyService(prisma, availability);
  }
  private readonly losses: DispatchLossService;
  private readonly emergencies: DispatchEmergencyService;

  private async publishCommitted(changes: readonly RealtimeChange[]) {
    if (!changes.length || !this.realtime) return;
    try {
      await this.realtime.publish(changes);
    } catch {
      // A delivery fault cannot turn a committed REST operation into a failure.
    }
  }

  private response(a: Audit): DispatchAuditDto {
    return {
      id: a.id,
      requestId: a.requestId,
      actorId: a.actorId,
      orderId: a.orderId,
      routeId: a.routeId,
      action: a.action,
      reason: a.reason,
      outcome: a.outcome,
      recordedAt: a.recordedAt.toString(),
      result: a.result,
    };
  }
  listLosses(orderId: string) {
    return this.losses.list(orderId);
  }
  async audit() {
    return (
      await this.prisma.client.orm.public.DispatchIntervention.orderBy((a) =>
        a.recordedAt.desc(),
      ).all()
    ).map((a) => this.response(a));
  }
  private replay(a: Audit, actorId: string, dto: DispatchInterventionDto) {
    if (a.actorId !== actorId || canonical(a.payload) !== canonical(dto))
      throw new ConflictException(
        'Idempotency key belongs to another actor or payload',
      );
    return this.response(a);
  }
  private validate(dto: DispatchInterventionDto) {
    const fields: Record<string, string[]> = {
      CONFIRM: ['orderId', 'fingerprint', 'driverId'],
      REJECT: ['orderId', 'fingerprint'],
      REORDER: ['routeId', 'orderIds'],
      MOVE: ['orderId', 'routeId', 'targetRouteId'],
      REASSIGN_DRIVER: ['routeId', 'driverId'],
      PRIORITIZE: ['orderId'],
      CONTACT: [
        'orderId',
        'attemptId',
        'emergencyId',
        'agreementConfirmed',
        'scheduledDeliveryDate',
        'deliveryWindowStart',
        'deliveryWindowEnd',
      ],
      RESCHEDULE: ['orderId', 'agreementId'],
      PICKUP_AGREE: ['orderId', 'attemptId', 'emergencyId'],
      PICKUP_DECLINE: ['orderId', 'attemptId'],
      PICKUP_CONFIRM: ['orderId'],
      RELEASE_DRAFT: ['routeId'],
      LOSS_DECLARE: ['orderId', 'orderItemId', 'unitNumber', 'attemptId', 'emergencyId'],
      REPLACEMENT_PREPARE: ['lossId'],
      ORIGINAL_RECOVER: ['lossId', 'recoveryCondition'],
      LOSS_CANCEL: ['lossId'],
      EMERGENCY_DECLARE: ['routeId'],
      UNIT_RECOVERY_CONFIRM: ['recoveryId'],
      EMERGENCY_CLOSE: ['routeId'],
      EMERGENCY_DRIVER_RELEASE: ['routeId'],
      EMERGENCY_REQUEUE: ['orderId', 'emergencyId'],
    };
    const required: Record<string, string[]> = {
      CONFIRM: ['orderId', 'fingerprint'],
      REJECT: ['orderId', 'fingerprint'],
      REORDER: ['routeId', 'orderIds'],
      MOVE: ['orderId', 'routeId', 'targetRouteId'],
      REASSIGN_DRIVER: ['routeId', 'driverId'],
      PRIORITIZE: ['orderId'],
      CONTACT: ['orderId'],
      RESCHEDULE: ['orderId', 'agreementId'],
      PICKUP_AGREE: ['orderId'],
      PICKUP_DECLINE: ['orderId'],
      PICKUP_CONFIRM: ['orderId'],
      RELEASE_DRAFT: ['routeId'],
      LOSS_DECLARE: ['orderId', 'orderItemId'],
      REPLACEMENT_PREPARE: ['lossId'],
      ORIGINAL_RECOVER: ['lossId', 'recoveryCondition'],
      LOSS_CANCEL: ['lossId'],
      EMERGENCY_DECLARE: ['routeId'],
      UNIT_RECOVERY_CONFIRM: ['recoveryId'],
      EMERGENCY_CLOSE: ['routeId'],
      EMERGENCY_DRIVER_RELEASE: ['routeId'],
      EMERGENCY_REQUEUE: ['orderId', 'emergencyId'],
    };
    const allowed = fields[dto.action];
    if (
      !allowed ||
      Object.entries(dto).some(
        ([k, v]) =>
          v !== undefined &&
          !['action', 'reason', 'requestId', ...allowed].includes(k),
      ) ||
      required[dto.action]!.some(
        (k) => !(dto as unknown as Record<string, unknown>)[k],
      )
    )
      throw new BadRequestException(
        'Action requires its exact resource fields',
      );
  }
  private async lockResources(
    tx: Transaction,
    routes: string[],
    drivers: string[],
    orders: string[],
  ) {
    // Shared with start/assignment: drivers, sorted routes, sorted orders.
    for (const id of [...new Set(drivers)].sort())
      await this.assignment.lockDriver(tx, id);
    for (const id of [...new Set(routes)].sort()) {
      const r = await tx.orm.public.Route.where({ id }).update({ id });
      if (!r) throw new NotFoundException('Route not found');
      if (!canMutateRouteStructure(r.status as RouteStatus | null))
        throw new ConflictException('Route structure is frozen');
      if (r.driverId && !drivers.includes(r.driverId))
        throw new ConflictException('Route driver changed; refresh decision');
    }
    for (const id of [...new Set(orders)].sort())
      if (!(await tx.orm.public.Order.where({ id }).update({ id })))
        throw new NotFoundException('Order not found');
  }
  private createAudit(
    tx: Transaction,
    dto: DispatchInterventionDto,
    actorId: string,
    routeId: string | null,
    result: Record<string, unknown>,
    orderId: string | null = dto.orderId ?? null,
  ) {
    return tx.orm.public.DispatchIntervention.create({
      requestId: dto.requestId,
      actorId,
      orderId,
      routeId,
      action: dto.action,
      reason: dto.reason.trim(),
      outcome: dto.action === 'REJECT' ? 'REJECTED' : 'APPLIED',
      payload: JSON.parse(canonical(dto)),
      result: JSON.parse(canonical(result)),
      recordedAt: nowInstant(),
    });
  }
  private async assertEmergencyContext(
    tx: Transaction,
    orderId: string,
    emergencyId: string,
  ) {
    const db = tx.orm.public;
    const emergency = await db.RouteEmergency.where({ id: emergencyId }).first();
    if (!emergency) throw new NotFoundException('Route emergency not found');
    const unit = await db.RouteUnitRecovery.where({
      emergencyId: emergency.id,
      orderId,
    }).first();
    if (!unit)
      throw new ConflictException(
        'Order does not belong to the specified route emergency',
      );
    for (const stop of await db.RouteStop.where({ orderId }).all()) {
      for (const attempt of await db.DeliveryAttempt.where({
        stopId: stop.id,
        outcome: 'FAILED',
      }).all()) {
        if (
          Temporal.Instant.compare(attempt.recordedAt, emergency.declaredAt) >= 0
        ) {
          throw new ConflictException(
            'Order has a failed delivery attempt at or after the emergency declaration',
          );
        }
      }
    }
    return emergency;
  }

  private async schedule(
    tx: Transaction,
    dto: DispatchInterventionDto,
    actorId: string,
    changes: RealtimeChange[],
  ) {
    const db = tx.orm.public;
    const initial = await db.Order.where({ id: dto.orderId! }).first();
    if (!initial) throw new NotFoundException('Order not found');
    let route = initial.routeId
      ? await db.Route.where({ id: initial.routeId }).first()
      : null;
    if (route) {
      if (route.driverId) await this.assignment.lockDriver(tx, route.driverId);
      route = await db.Route.where({ id: route.id }).update({ id: route.id });
    }
    const order = await db.Order.where({ id: initial.id }).update({
      id: initial.id,
    });
    if (!order || order.routeId !== initial.routeId)
      throw new ConflictException('Order route changed; refresh decision');
    if (order.status === 'DELIVERED' || order.status === 'CANCELLED')
      throw new ConflictException(
        'Commercially resolved order cannot be rescheduled',
      );
    if (!(await this.emergencies.isOrderRecoveryResolved(tx, order.id))) {
      throw this.pickupConflict(
        'RECOVERY_PENDING',
        'Order has unrecovered units from route emergency',
      );
    }
    const attempts = [];
    for (const stop of await db.RouteStop.where({
      orderId: order.id,
      outcome: 'FAILED',
    }).all()) {
      for (const attempt of await db.DeliveryAttempt.where({
        stopId: stop.id,
        outcome: 'FAILED',
      }).all())
        attempts.push(attempt);
    }
    attempts.sort(
      (a, b) =>
        Temporal.Instant.compare(b.recordedAt, a.recordedAt) ||
        b.id.localeCompare(a.id),
    );
    const latest = attempts[0];
    if (dto.action === 'CONTACT') {
      if (typeof dto.agreementConfirmed !== 'boolean')
        throw new BadRequestException(
          'Explicit agreementConfirmed boolean required',
        );
      if (dto.attemptId && dto.emergencyId)
        throw new BadRequestException(
          'Provide either attemptId or emergencyId, not both',
        );
      let contactEmergency: Awaited<
        ReturnType<DispatchInterventionService['assertEmergencyContext']>
      > | null = null;
      if (order.requiresAdministrativeReview) {
        if (dto.emergencyId) {
          contactEmergency = await this.assertEmergencyContext(
            tx,
            order.id,
            dto.emergencyId,
          );
        } else if (!latest || dto.attemptId !== latest.id) {
          throw new ConflictException(
            'Contact must refer to the latest failed attempt',
          );
        }
      } else if (dto.attemptId || dto.emergencyId) {
        throw new ConflictException('No unresolved failed attempt');
      }
      if (dto.agreementConfirmed) {
        const timing = parseDeliveryTiming(dto, true);
        if (!timing.deliveryWindowStart || !timing.deliveryWindowEnd)
          throw new BadRequestException('Agreed delivery window required');
        assertDeliveryFuture(
          timing,
          await deliveryClock(tx, this.prisma.client.raw),
        );
      } else if (
        dto.scheduledDeliveryDate !== undefined ||
        dto.deliveryWindowStart !== undefined ||
        dto.deliveryWindowEnd !== undefined
      )
        throw new BadRequestException(
          'Unconfirmed contact cannot record an agreed schedule',
        );
      const auditRouteId = contactEmergency?.routeId ?? order.routeId;
      const audit = await this.createAudit(tx, dto, actorId, auditRouteId, {
        orderId: order.id,
        routeId: auditRouteId,
        attemptId: dto.emergencyId ? null : (latest?.id ?? null),
        ...(dto.emergencyId ? { emergencyId: dto.emergencyId } : {}),
      });
      changes.push({
        type: 'dispatch.incident.updated',
        orderId: order.id,
        action: 'CONTACT',
        requiresAdministrativeReview: order.requiresAdministrativeReview,
      });
      return this.response(audit);
    }
    const contact = await db.DispatchIntervention.where({
      id: dto.agreementId!,
      orderId: order.id,
      action: 'CONTACT',
      outcome: 'APPLIED',
    }).first();
    const payload = contact?.payload as
      | {
          agreementConfirmed?: boolean;
          attemptId?: string;
          emergencyId?: string;
          scheduledDeliveryDate?: string;
          deliveryWindowStart?: string;
          deliveryWindowEnd?: string;
        }
      | undefined;
    if (!contact || payload?.agreementConfirmed !== true)
      throw new ConflictException(
        'Persisted explicit date/window agreement required',
      );
    let rescheduleEmergency: Awaited<
      ReturnType<DispatchInterventionService['assertEmergencyContext']>
    > | null = null;
    if (order.requiresAdministrativeReview) {
      if (payload.emergencyId) {
        rescheduleEmergency = await this.assertEmergencyContext(
          tx,
          order.id,
          payload.emergencyId,
        );
      } else if (!latest || payload.attemptId !== latest.id) {
        throw new ConflictException(
          'Agreement must resolve the latest failed attempt',
        );
      }
    } else if (payload.attemptId || payload.emergencyId) {
      throw new ConflictException(
        'Failed attempt already administratively resolved',
      );
    }
    const timing = parseDeliveryTiming(payload, true);
    if (!timing.deliveryWindowStart || !timing.deliveryWindowEnd)
      throw new ConflictException('Agreed delivery window required');
    assertDeliveryFuture(
      timing,
      await deliveryClock(tx, this.prisma.client.raw),
    );
    const storeCoverage = this.storeCoverage ? await this.storeCoverage.getCoverage() : null;
    const storeRow = !storeCoverage
      ? await db.StoreCoverage?.where({ singletonKey: 'GLOBAL' }).first()
      : null;
    const storeOrigin: GeoPoint | null = storeCoverage?.configured
      ? { lat: storeCoverage.location.lat, lng: storeCoverage.location.lng }
      : storeRow && typeof storeRow.lat === 'number' && typeof storeRow.lng === 'number'
        ? { lat: storeRow.lat, lng: storeRow.lng }
        : null;
    const orderZone = order.zoneId
      ? await db.Zone.where({ id: order.zoneId }).first()
      : null;
    if (
      !evaluatePlanningEligibility(order, orderZone, storeOrigin)
        .planningEligibility.eligible
    )
      throw new ConflictException(
        'Confirmed delivery and depot coordinates required',
      );
    const claim = await db.OrderClaim.where({
      orderId: order.id,
      releasedAt: null,
    }).first();
    if (
      route &&
      !canMutateRouteStructure(route.status as RouteStatus | null) &&
      route.status !== 'COMPLETED' &&
      route.status !== 'INTERRUPTED'
    )
      throw new ConflictException('Route structure is frozen or unverified');
    if (order.requiresAdministrativeReview) {
      if (payload.emergencyId) {
        if (claim || order.routeId !== null)
          throw new ConflictException(
            'Emergency order must be detached from route before retry',
          );
      } else if (
        (route?.status !== 'COMPLETED' && route?.status !== 'INTERRUPTED') ||
        claim
      ) {
        throw new ConflictException(
          'Failed original route must complete and release the order before retry',
        );
      }
    }
    if (claim && (!route || claim.routeId !== route.id || !claim.claimedAt))
      throw new ConflictException('Matching verified source claim required');
    if (
      (
        await db.DispatchIntervention.where({
          orderId: order.id,
          action: 'RESCHEDULE',
          outcome: 'APPLIED',
        }).all()
      ).some(
        (a) =>
          (a.payload as { agreementId?: string })?.agreementId === contact.id,
      )
    )
      throw new ConflictException('Agreement already consumed');
    const auditRouteId = order.routeId ?? rescheduleEmergency?.routeId ?? null;
    const audit = await this.createAudit(tx, dto, actorId, auditRouteId, {
      orderId: order.id,
      routeId: auditRouteId,
      agreementId: contact.id,
      attemptId: payload.emergencyId ? null : (latest?.id ?? null),
      ...(payload.emergencyId ? { emergencyId: payload.emergencyId } : {}),
      scheduledDeliveryDate: timing.scheduledDeliveryDate!.toString(),
    });
    if (claim && route) {
      const stops = await db.RouteStop.where({ routeId: route.id }).all();
      if (stops.length <= 1)
        throw new ConflictException(
          'Rescheduling cannot empty a reserved route',
        );
      // Rescheduling one pre-start stop is the same central structural operation as moving it.
      const ids = stops
        .filter((s) => s.orderId !== order.id)
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
        .map((s) => s.orderId);
      await this.assignment.replaceStops(tx, route.id, ids, changes);
      await db.OrderClaim.where({ id: claim.id }).update({
        releasedAt: nowInstant(),
      });
    }
    const rescheduled = await db.Order.where({ id: order.id }).update({
      ...timing,
      status: 'PENDING',
      requiresAdministrativeReview: false,
      routeId: null,
      stopOrder: null,
    });
    if (!rescheduled)
      throw new ConflictException('Order changed during reschedule');
    changes.push(
      {
        type: 'order.status.updated',
        orderId: rescheduled.id,
        status: rescheduled.status,
        requiresAdministrativeReview: rescheduled.requiresAdministrativeReview,
      },
      {
        type: 'dispatch.incident.updated',
        orderId: rescheduled.id,
        action: 'RESCHEDULE',
        requiresAdministrativeReview: rescheduled.requiresAdministrativeReview,
      },
    );
    assertDeliveryFuture(
      timing,
      await deliveryClock(tx, this.prisma.client.raw),
    );
    return this.response(audit);
  }

  private pickupConflict(code: string, message: string): ConflictException {
    return new ConflictException({ statusCode: 409, message, error: 'Conflict', code });
  }

  /**
   * Pedido, su ruta y su último intento fallido, con el pedido y la ruta bloqueados: base común de las acciones
   * de retiro (#50). Un pedido ya entregado o cancelado no se gestiona.
   */
  private async loadIncident(tx: Transaction, orderId: string, emergencyId?: string) {
    const db = tx.orm.public;
    const initial = await db.Order.where({ id: orderId }).first();
    if (!initial) throw new NotFoundException('Order not found');
    // Una ruta DRAFT reserva el pedido con un OrderClaim pero todavía no le pone `routeId`: la ruta se busca por la reserva.
    const reserved = initial.routeId
      ? null
      : await db.OrderClaim.where({ orderId: initial.id, releasedAt: null }).first();
    const routeId = initial.routeId ?? reserved?.routeId ?? null;
    let route = routeId ? await db.Route.where({ id: routeId }).first() : null;
    if (route) {
      if (route.driverId) await this.assignment.lockDriver(tx, route.driverId);
      route = await db.Route.where({ id: route.id }).update({ id: route.id });
    }
    const order = await db.Order.where({ id: initial.id }).update({ id: initial.id });
    if (!order || order.routeId !== initial.routeId)
      throw new ConflictException('Order route changed; refresh decision');
    if (order.status === 'DELIVERED' || order.status === 'CANCELLED')
      throw new ConflictException('Commercially resolved order cannot be managed for pickup');
    const attempts = [];
    for (const stop of await db.RouteStop.where({ orderId: order.id, outcome: 'FAILED' }).all()) {
      for (const attempt of await db.DeliveryAttempt.where({ stopId: stop.id, outcome: 'FAILED' }).all())
        attempts.push(attempt);
    }
    attempts.sort(
      (a, b) => Temporal.Instant.compare(b.recordedAt, a.recordedAt) || b.id.localeCompare(a.id),
    );
    const emergency = emergencyId
      ? await this.assertEmergencyContext(tx, order.id, emergencyId)
      : null;
    return { order, route, latest: attempts[0], emergency };
  }

  /**
   * Retiro en tienda acordado (#50). Tres eventos distintos y auditados:
   * - PICKUP_AGREE: el ADMIN registra el acuerdo EXPLÍCITO del cliente. El pedido queda pendiente de retiro: conserva su
   *   estado y su marca de gestión pendiente (los planificadores lo siguen ignorando: no se crea otra ruta) y suelta
   *   sus reservas operativas de forma segura. No es una entrega ni un reembolso, y no repone stock.
   * - PICKUP_DECLINE: el cliente no acepta. Solo se audita; el pedido sigue pendiente de gestión y admite otra alternativa.
   * - PICKUP_CONFIRM: el ADMIN confirma el retiro físico (actor y momento). Solo esto marca el pedido como entregado.
   */
  private async pickup(
    tx: Transaction,
    dto: DispatchInterventionDto,
    actorId: string,
    changes: RealtimeChange[],
  ) {
    const db = tx.orm.public;
    if (dto.attemptId && dto.emergencyId)
      throw new BadRequestException('Provide either attemptId or emergencyId, not both');
    const { order, route, latest, emergency } = await this.loadIncident(
      tx,
      dto.orderId!,
      dto.emergencyId,
    );
    const existing = await db.OrderPickup.where({ orderId: order.id }).first();

    if (dto.action === 'PICKUP_CONFIRM') {
      if (!existing)
        throw this.pickupConflict('PICKUP_NOT_AGREED', 'No hay un retiro acordado que confirmar');
      if (existing.confirmedAt)
        throw this.pickupConflict('PICKUP_ALREADY_CONFIRMED', 'El retiro ya fue confirmado');
      const confirmedAt = nowInstant();
      if (
        !(await db.OrderPickup.where({ id: existing.id, confirmedAt: null }).update({
          confirmedAt,
          confirmedById: actorId,
          confirmationRequestId: dto.requestId,
        }))
      )
        throw this.pickupConflict('PICKUP_ALREADY_CONFIRMED', 'El retiro ya fue confirmado');
      // La auditoría va ANTES de tocar el pedido: el guard de la base de datos exige la resolución auditada en la misma transacción.
      const audit = await this.createAudit(tx, dto, actorId, order.routeId, {
        orderId: order.id,
        routeId: order.routeId,
        pickupId: existing.id,
        confirmedAt: confirmedAt.toString(),
      });
      // La marca de gestión pendiente se limpia en el mismo UPDATE: un pedido entregado no puede conservarla.
      const delivered = await db.Order.where({ id: order.id }).update({
        status: 'DELIVERED',
        requiresAdministrativeReview: false,
      });
      if (!delivered) throw new ConflictException('Order changed during the pickup confirmation');
      changes.push(
        { type: 'order.status.updated', orderId: order.id, status: 'DELIVERED', requiresAdministrativeReview: false },
        { type: 'dispatch.incident.updated', orderId: order.id, action: 'PICKUP_CONFIRM', requiresAdministrativeReview: false },
      );
      return this.response(audit);
    }

    if (existing)
      throw this.pickupConflict('PICKUP_ALREADY_AGREED', 'El pedido ya tiene un retiro en tienda acordado');
    if (
      dto.action === 'PICKUP_AGREE' &&
      !(await this.emergencies.isOrderRecoveryResolved(tx, order.id))
    )
      throw this.pickupConflict(
        'RECOVERY_PENDING',
        'Order has unrecovered units from route emergency',
      );
    if (order.requiresAdministrativeReview) {
      if (!dto.emergencyId && (!latest || dto.attemptId !== latest.id))
        throw new ConflictException('Pickup must refer to the latest failed attempt');
    } else if (dto.attemptId || dto.emergencyId) {
      throw new ConflictException('No unresolved failed attempt');
    }

    if (dto.action === 'PICKUP_DECLINE') {
      const audit = await this.createAudit(tx, dto, actorId, order.routeId, {
        orderId: order.id,
        routeId: order.routeId,
        attemptId: latest?.id ?? null,
      });
      changes.push({
        type: 'dispatch.incident.updated',
        orderId: order.id,
        action: 'PICKUP_DECLINE',
        requiresAdministrativeReview: order.requiresAdministrativeReview,
      });
      return this.response(audit);
    }

    // PICKUP_AGREE: reservas operativas con las mismas protecciones que una reprogramación.
    const claim = await db.OrderClaim.where({ orderId: order.id, releasedAt: null }).first();
    if (
      route &&
      !canMutateRouteStructure(route.status as RouteStatus | null) &&
      route.status !== 'COMPLETED' &&
      route.status !== 'INTERRUPTED'
    )
      throw new ConflictException('Route structure is frozen or unverified');
    if (order.requiresAdministrativeReview) {
      if (dto.emergencyId) {
        if (claim || order.routeId !== null)
          throw new ConflictException('Emergency order must be detached from route before the pickup');
      } else if ((route?.status !== 'COMPLETED' && route?.status !== 'INTERRUPTED') || claim) {
        throw new ConflictException('Failed original route must complete and release the order before the pickup');
      }
    }
    if (claim && (!route || claim.routeId !== route.id || !claim.claimedAt))
      throw new ConflictException('Matching verified source claim required');
    const agreedAt = nowInstant();
    const pickup = await db.OrderPickup.create({
      orderId: order.id,
      agreedAt,
      agreedById: actorId,
      agreementRequestId: dto.requestId,
    });
    // La auditoría va ANTES de tocar el pedido: el guard de la base de datos exige la resolución auditada en la misma transacción.
    const auditRouteId = emergency?.routeId ?? route?.id ?? order.routeId;
    const audit = await this.createAudit(tx, dto, actorId, auditRouteId, {
      orderId: order.id,
      routeId: auditRouteId,
      attemptId: dto.emergencyId ? null : (latest?.id ?? null),
      ...(dto.emergencyId ? { emergencyId: dto.emergencyId } : {}),
      pickupId: pickup.id,
      agreedAt: agreedAt.toString(),
    });
    if (claim && route) {
      const stops = await db.RouteStop.where({ routeId: route.id }).all();
      if (stops.length <= 1)
        throw new ConflictException('A store pickup cannot empty a reserved route');
      // Una ruta aún no iniciada pierde la parada con la operación estructural central; la iniciada nunca llega aquí.
      const ids = stops
        .filter((s) => s.orderId !== order.id)
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
        .map((s) => s.orderId);
      await this.assignment.replaceStops(tx, route.id, ids, changes);
      await db.OrderClaim.where({ id: claim.id }).update({ releasedAt: nowInstant() });
    }
    const held = await db.Order.where({ id: order.id }).update({
      status: 'PENDING',
      requiresAdministrativeReview: true,
      routeId: null,
      stopOrder: null,
    });
    if (!held) throw new ConflictException('Order changed during the pickup agreement');
    changes.push(
      { type: 'order.status.updated', orderId: order.id, status: 'PENDING', requiresAdministrativeReview: true },
      { type: 'dispatch.incident.updated', orderId: order.id, action: 'PICKUP_AGREE', requiresAdministrativeReview: true },
    );
    return this.response(audit);
  }

  private async releaseDraft(
    tx: Transaction,
    dto: DispatchInterventionDto,
    actorId: string,
    changes: RealtimeChange[],
  ) {
    const db = tx.orm.public;
    const route = await db.Route.where({ id: dto.routeId! }).update({
      id: dto.routeId!,
    });
    if (!route) throw new NotFoundException('Route not found');
    if (route.status !== 'DRAFT' || route.driverId !== null)
      throw new ConflictException({
        statusCode: 409,
        message: 'Only unassigned DRAFT routes can be released',
        error: 'Conflict',
        code: 'DRAFT_NOT_RELEASABLE',
      });
    const stops = await db.RouteStop.where({ routeId: route.id }).all();
    const claims = await db.OrderClaim.where({
      routeId: route.id,
      releasedAt: null,
    }).all();
    if (stops.length === 0 && claims.length === 0)
      throw new ConflictException({
        statusCode: 409,
        message: 'DRAFT route has no active stops or claims to release',
        error: 'Conflict',
        code: 'DRAFT_ALREADY_RELEASED',
      });
    const affectedOrderIds = [
      ...new Set([
        ...stops.map((s) => s.orderId),
        ...claims.map((c) => c.orderId),
      ]),
    ].sort();
    for (const orderId of affectedOrderIds) {
      if (!(await db.Order.where({ id: orderId }).update({ id: orderId })))
        throw new NotFoundException('Order not found');
    }
    // Delete stops before releasing claims so t1e_claim_history_guard allows the DRAFT claim release.
    for (const stop of stops) {
      await db.RouteStop.where({ id: stop.id }).delete();
    }
    const releasedAt = nowInstant();
    for (const claim of claims) {
      await db.OrderClaim.where({ id: claim.id }).update({ releasedAt });
    }
    const audit = await this.createAudit(tx, dto, actorId, route.id, {
      routeId: route.id,
      releasedCount: String(claims.length),
      releasedAt: releasedAt.toString(),
    });
    changes.push({ type: 'route.updated', routeId: route.id, status: 'DRAFT' });
    for (const orderId of affectedOrderIds) {
      changes.push({
        type: 'order.status.updated',
        orderId,
        status: 'PENDING',
      });
    }
    return this.response(audit);
  }

  async intervene(
    dto: DispatchInterventionDto,
    actorId: string,
  ): Promise<DispatchAuditDto> {
    this.validate(dto);
    const changes: RealtimeChange[] = [];
    try {
      const result = await this.assignment.transaction(actorId, async (tx) => {
        const db = tx.orm.public;
        const prior = await db.DispatchIntervention.where({
          requestId: dto.requestId,
        }).first();
        if (prior) return this.replay(prior, actorId, dto);
        if (dto.action === 'RELEASE_DRAFT')
          return this.releaseDraft(tx, dto, actorId, changes);
        if (dto.action === 'CONTACT' || dto.action === 'RESCHEDULE')
          return this.schedule(tx, dto, actorId, changes);
        if (
          dto.action === 'LOSS_DECLARE' ||
          dto.action === 'REPLACEMENT_PREPARE' ||
          dto.action === 'ORIGINAL_RECOVER' ||
          dto.action === 'LOSS_CANCEL'
        )
          return this.response(
            await this.losses.handle(tx, dto, actorId, changes, (routeId, result, orderId) =>
              this.createAudit(tx, dto, actorId, routeId, result, orderId),
            ),
          );
        if (
          dto.action === 'EMERGENCY_DECLARE' ||
          dto.action === 'UNIT_RECOVERY_CONFIRM' ||
          dto.action === 'EMERGENCY_CLOSE' ||
          dto.action === 'EMERGENCY_DRIVER_RELEASE' ||
          dto.action === 'EMERGENCY_REQUEUE'
        )
          return this.response(
            await this.emergencies.handle(tx, dto, actorId, changes, (routeId, result, orderId) =>
              this.createAudit(tx, dto, actorId, routeId, result, orderId),
            ),
          );
        if (
          dto.action === 'PICKUP_AGREE' ||
          dto.action === 'PICKUP_DECLINE' ||
          dto.action === 'PICKUP_CONFIRM'
        )
          return this.pickup(tx, dto, actorId, changes);
        if (dto.action === 'CONFIRM' || dto.action === 'REJECT') {
          const initial = await this.urgency.propose(dto.orderId!, tx);
          const route = initial.routeId
            ? await db.Route.where({ id: initial.routeId }).first()
            : null;
          const driverIds = [
            ...(route?.driverId ? [route.driverId] : []),
            ...(dto.driverId ? [dto.driverId] : []),
          ];
          await this.lockResources(
            tx,
            initial.routeId ? [initial.routeId] : [],
            driverIds,
            initial.orderIds.length ? initial.orderIds : [dto.orderId!],
          );
          const proposal = await this.urgency.propose(dto.orderId!, tx);
          if (
            proposal.kind === 'BLOCKED' ||
            proposal.fingerprint !== dto.fingerprint
          )
            throw new ConflictException(
              'Proposal blocked or stale; refresh proposal',
            );
          if (proposal.kind === 'INSERT' && dto.driverId)
            throw new BadRequestException('Insertion retains the route driver');
          if (dto.action === 'REJECT') {
            const audit = await this.createAudit(
              tx,
              dto,
              actorId,
              proposal.routeId,
              { orderId: dto.orderId!, routeId: proposal.routeId },
            );
            changes.push({
              type: 'dispatch.incident.updated',
              orderId: dto.orderId!,
              action: 'REJECT',
            });
            return this.response(audit);
          }
          let routeId = proposal.routeId;
          if (routeId)
            await this.assignment.replaceStops(
              tx,
              routeId,
              proposal.orderIds,
              changes,
            );
          else {
            if (
              !dto.driverId ||
              !proposal.availableDriverIds.includes(dto.driverId)
            )
              throw new ConflictException(
                'New departure requires an effectively available driver',
              );
            const draft = await this.assignment.confirmInTransaction(
              tx,
              {
                zoneId: proposal.zoneId ?? null,
                routeDate: proposal.routeDate!,
                orderIds: proposal.orderIds,
              },
              Temporal.Instant.from(proposal.routeDate!),
            );
            routeId = draft.id;
            await this.assignment.assignInTransaction(
              tx,
              routeId,
              { driverId: dto.driverId },
              changes,
            );
          }
          const audit = await this.createAudit(tx, dto, actorId, routeId, {
            orderId: dto.orderId!,
            routeId,
          });
          changes.push({
            type: 'dispatch.incident.updated',
            orderId: dto.orderId!,
            action: 'CONFIRM',
          });
          return this.response(audit);
        }
        if (dto.action === 'PRIORITIZE') {
          await this.lockResources(tx, [], [], [dto.orderId!]);
          const order = await db.Order.where({ id: dto.orderId! }).first();
          if (
            order?.status !== 'PENDING' ||
            order.requiresAdministrativeReview ||
            (await db.OrderClaim.where({
              orderId: dto.orderId!,
              releasedAt: null,
            }).first())
          )
            throw new ConflictException(
              'Only an eligible unclaimed PENDING order may be prioritized',
            );
          const audit = await this.createAudit(tx, dto, actorId, null, {
            orderId: dto.orderId!,
            routeId: null,
          });
          changes.push({
            type: 'dispatch.incident.updated',
            orderId: dto.orderId!,
            action: 'PRIORITIZE',
          });
          return this.response(audit);
        }
        const routeIds = [
          dto.routeId!,
          ...(dto.targetRouteId ? [dto.targetRouteId] : []),
        ];
        const routes = [];
        for (const id of routeIds) {
          const route = await db.Route.where({ id }).first();
          if (!route) throw new NotFoundException('Route not found');
          routes.push(route);
        }
        const stopIds: string[] = [];
        for (const r of routes)
          for (const s of await db.RouteStop.where({ routeId: r.id }).all())
            stopIds.push(s.orderId);
        await this.lockResources(
          tx,
          routeIds,
          [
            ...routes.flatMap((r) => (r.driverId ? [r.driverId] : [])),
            ...(dto.driverId ? [dto.driverId] : []),
          ],
          stopIds,
        );
        const route = await db.Route.where({ id: dto.routeId! }).first();
        if (!route) throw new NotFoundException('Route not found');
        if (dto.action === 'REASSIGN_DRIVER') {
          if (
            route.status !== 'ASSIGNED' ||
            !route.driverId ||
            route.driverId === dto.driverId
          )
            throw new ConflictException(
              'Reassignment requires a different driver on ASSIGNED',
            );
          const next = await db.Driver.where({ id: dto.driverId! }).first();
          if (
            !next ||
            !(await db.User.where({
              id: next.userId,
              role: 'DRIVER',
            }).first()) ||
            !(await this.availability.effective(next.id, tx, businessDay(route.date))).isAvailable
          )
            throw new ConflictException(
              'Driver has an unresolved route or reservation hold, or is absent on the route date',
            );
          const reservation = await db.DriverReservation.where({
            routeId: route.id,
            driverId: route.driverId,
            releasedAt: null,
          }).first();
          if (!reservation?.reservedAt)
            throw new ConflictException(
              'Matching verified reservation required',
            );
          const audit = await this.createAudit(tx, dto, actorId, route.id, {
            routeId: route.id,
            driverId: next.id,
          });
          const reassigned = await db.Route.where({
            id: route.id,
            status: 'ASSIGNED',
            driverId: route.driverId,
          }).update({ driverId: next.id });
          if (!reassigned)
            throw new ConflictException('Route changed during reassignment');
          await db.DriverReservation.where({ id: reservation.id }).update({
            releasedAt: nowInstant(),
          });
          await db.DriverReservation.create({
            routeId: route.id,
            driverId: next.id,
            reservedAt: nowInstant(),
          });
          const previous = await db.Driver.where({
            id: route.driverId,
          }).first();
          if (!previous)
            throw new ConflictException('Previous driver not found');
          await this.availability.recomputeProjection(
            previous.id,
            previous.userId,
            tx,
          );
          await db.Driver.where({ id: next.id }).update({ isAvailable: false });
          changes.push({
            type: 'route.updated',
            routeId: reassigned.id,
            status: reassigned.status ?? undefined,
          });
          return this.response(audit);
        }
        const stops = (
          await db.RouteStop.where({ routeId: route.id }).all()
        ).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
        if (dto.action === 'REORDER') {
          if (
            dto.orderIds!.length !== stops.length ||
            stops.some((s) => !dto.orderIds!.includes(s.orderId))
          )
            throw new ConflictException(
              'Reorder must contain exactly the current stops',
            );
          await this.assignment.replaceStops(
            tx,
            route.id,
            dto.orderIds!,
            changes,
          );
          const audit = await this.createAudit(tx, dto, actorId, route.id, {
            routeId: route.id,
          });
          return this.response(audit);
        }
        if (
          dto.routeId === dto.targetRouteId ||
          !stops.some((s) => s.orderId === dto.orderId) ||
          stops.length <= 1
        )
          throw new ConflictException(
            'Move requires a distinct target and a nonempty source route',
          );
        const target = (
          await db.RouteStop.where({ routeId: dto.targetRouteId! }).all()
        ).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
        if (target.length >= 4)
          throw new ConflictException('Route maximum is four stops');
        const claim = await db.OrderClaim.where({
          routeId: route.id,
          orderId: dto.orderId!,
          releasedAt: null,
        }).first();
        if (!claim?.claimedAt)
          throw new ConflictException('Matching verified claim required');
        const audit = await this.createAudit(tx, dto, actorId, route.id, {
          orderId: dto.orderId!,
          routeId: route.id,
          targetRouteId: dto.targetRouteId!,
        });
        await this.assignment.replaceStops(
          tx,
          route.id,
          stops.filter((s) => s.orderId !== dto.orderId).map((s) => s.orderId),
          changes,
        );
        await db.OrderClaim.where({ id: claim.id }).update({
          releasedAt: nowInstant(),
        });
        await db.Order.where({ id: dto.orderId! }).update({
          status: 'PENDING',
          routeId: null,
          stopOrder: null,
        });
        await this.assignment.replaceStops(
          tx,
          dto.targetRouteId!,
          [...target.map((s) => s.orderId), dto.orderId!],
          changes,
        );
        changes.push({
          type: 'dispatch.incident.updated',
          orderId: dto.orderId!,
          action: 'MOVE',
        });
        return this.response(audit);
      });
      await this.publishCommitted(changes);
      return result;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      // Unique-key contenders reconcile once after rollback, never repeat mutation.
      const prior =
        await this.prisma.client.orm?.public.DispatchIntervention.where({
          requestId: dto.requestId,
        }).first();
      if (prior) return this.replay(prior, actorId, dto);
      throw error;
    }
  }
}
