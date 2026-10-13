import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Namespace } from 'socket.io';
import { Role } from '../auth/dto/register.dto.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { RealtimeChange, RealtimeEnvelope, RealtimePublisher } from './realtime.contract.js';

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ORDER_STATUSES = new Set(['PENDING', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED']);
const ROUTE_STATUSES = new Set(['DRAFT', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED']);
const INCIDENT_ACTIONS = new Set([
  'CONFIRM',
  'REJECT',
  'REORDER',
  'MOVE',
  'REASSIGN_DRIVER',
  'PRIORITIZE',
  'CONTACT',
  'RESCHEDULE',
]);

type RealtimeRole = Role.ADMIN | Role.CLIENT | Role.DRIVER;

export interface RealtimePrincipal {
  userId: string;
  role: RealtimeRole;
}

export type RealtimeSubscription =
  | { resource: 'order' | 'route' | 'driver'; id: string }
  | { resource: 'incidents' };

interface CurrentAudience {
  resource: 'order' | 'route' | 'driver';
  id: string;
  ownerUserId?: string | null;
  assignedDriverUserId?: string | null;
  driverUserId?: string | null;
}

interface VerifiedClaims {
  sub: string;
  exp: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isRole(value: unknown): value is RealtimeRole {
  return value === Role.ADMIN || value === Role.CLIENT || value === Role.DRIVER;
}

function normalizedUuid(value: string): string {
  return value.toLowerCase();
}

@Injectable()
export class RealtimeService implements RealtimePublisher {
  private readonly logger = new Logger(RealtimeService.name);
  private namespace: Namespace | undefined;

  constructor(private readonly prisma: PrismaService) {}

  attach(namespace: Namespace): void {
    this.namespace = namespace;
  }

  async authenticate(token: unknown): Promise<RealtimePrincipal | null> {
    const secret = process.env.JWT_SECRET;
    if (typeof secret !== 'string' || secret.length === 0 || typeof token !== 'string') {
      return null;
    }

    const claims = this.verifyToken(token, secret);
    if (!claims) return null;

    try {
      const user = await this.prisma.user
        .where({ id: claims.sub })
        .select('id', 'role')
        .first();
      if (!user || !isRole(user.role)) return null;
      return { userId: user.id, role: user.role };
    } catch {
      return null;
    }
  }

  async canSubscribe(
    principal: RealtimePrincipal,
    subscription: RealtimeSubscription,
  ): Promise<boolean> {
    if (!principal || !isUuid(principal.userId) || !isRole(principal.role)) return false;
    if (subscription.resource === 'incidents') return principal.role === Role.ADMIN;
    if (!isUuid(subscription.id)) return false;

    const audience = await this.loadAudience({
      resource: subscription.resource,
      id: normalizedUuid(subscription.id),
    });
    return audience !== null && this.isAuthorizedForAudience(principal, audience);
  }

  async publish(changes: readonly RealtimeChange[]): Promise<void> {
    if (!this.namespace || !Array.isArray(changes)) return;

    for (const change of changes) {
      try {
        await this.publishOne(change);
      } catch {
        // Persistence already committed; transport failures must not alter the REST result.
        this.logger.warn('Realtime publication failed');
      }
    }
  }

  private verifyToken(token: string, secret: string): VerifiedClaims | null {
    const segments = token.split('.');
    if (segments.length !== 3 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) {
      return null;
    }

    try {
      const [encodedHeader, encodedPayload, encodedSignature] = segments;
      const header: unknown = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
      const payload: unknown = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
      if (!isRecord(header) || header.alg !== 'HS256' || !isRecord(payload)) return null;
      if (!isUuid(payload.sub) || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
        return null;
      }

      const now = Date.now() / 1000;
      if (payload.exp <= now || (typeof payload.nbf === 'number' && payload.nbf > now)) return null;

      const expected = createHmac('sha256', secret)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest();
      const supplied = Buffer.from(encodedSignature, 'base64url');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

      return { sub: payload.sub, exp: payload.exp };
    } catch {
      return null;
    }
  }

  private async loadAudience(
    subscription: Exclude<RealtimeSubscription, { resource: 'incidents' }>,
  ): Promise<CurrentAudience | null> {
    if (subscription.resource === 'order') {
      const order = await this.prisma.order
        .where({ id: subscription.id })
        .select('id', 'userId', 'routeId')
        .first();
      if (!order) return null;
      const assignedDriverUserId = order.routeId
        ? await this.currentRouteDriverUserId(order.routeId)
        : null;
      return {
        resource: 'order',
        id: order.id,
        ownerUserId: order.userId,
        assignedDriverUserId,
      };
    }

    if (subscription.resource === 'route') {
      const route = await this.prisma.route
        .where({ id: subscription.id })
        .select('id', 'driverId')
        .first();
      if (!route) return null;
      return {
        resource: 'route',
        id: route.id,
        assignedDriverUserId: route.driverId
          ? await this.currentDriverUserId(route.driverId)
          : null,
      };
    }

    const driver = await this.prisma.driver
      .where({ id: subscription.id })
      .select('id', 'userId')
      .first();
    if (!driver) return null;
    return { resource: 'driver', id: driver.id, driverUserId: driver.userId };
  }

  private async currentRouteDriverUserId(routeId: string): Promise<string | null> {
    const route = await this.prisma.route
      .where({ id: routeId })
      .select('id', 'driverId')
      .first();
    if (!route?.driverId) return null;
    return this.currentDriverUserId(route.driverId);
  }

  private async currentDriverUserId(driverId: string): Promise<string | null> {
    const driver = await this.prisma.driver
      .where({ id: driverId })
      .select('id', 'userId')
      .first();
    return driver?.userId ?? null;
  }

  private isAuthorizedForAudience(
    principal: RealtimePrincipal,
    audience: CurrentAudience,
  ): boolean {
    if (principal.role === Role.ADMIN) return true;
    if (audience.resource === 'order') {
      return (principal.role === Role.CLIENT && audience.ownerUserId === principal.userId) ||
        (principal.role === Role.DRIVER && audience.assignedDriverUserId === principal.userId);
    }
    if (audience.resource === 'route') {
      return principal.role === Role.DRIVER && audience.assignedDriverUserId === principal.userId;
    }
    return principal.role === Role.DRIVER && audience.driverUserId === principal.userId;
  }

  private async publishOne(change: RealtimeChange): Promise<void> {
    const prepared = this.projectChange(change);
    const namespace = this.namespace;
    if (!prepared || !namespace) return;

    const resource = change.type === 'dispatch.incident.updated' ? 'order' : prepared.resource;
    const id = change.type === 'dispatch.incident.updated'
      ? normalizedUuid(change.orderId)
      : prepared.id;
    const room = change.type === 'dispatch.incident.updated'
      ? 'incidents:admin'
      : `${prepared.resource}:${prepared.id}`;
    const envelope: RealtimeEnvelope = {
      version: 1,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      data: prepared.data,
    };

    for (const socket of namespace.sockets.values()) {
      if (!socket.rooms.has(room)) continue;
      const principal = await this.authenticate(socket.data.realtimeToken);
      if (!principal) {
        socket.disconnect(true);
        continue;
      }
      const currentAudience = await this.loadAudience({ resource, id });
      if (!currentAudience || !this.isCurrentRecipient(principal, currentAudience, change.type)) {
        socket.disconnect(true);
        continue;
      }
      socket.emit(change.type, envelope);
    }
  }

  private isCurrentRecipient(
    principal: RealtimePrincipal,
    audience: CurrentAudience,
    eventType: RealtimeChange['type'],
  ): boolean {
    if (eventType === 'dispatch.incident.updated') return principal.role === Role.ADMIN;
    return this.isAuthorizedForAudience(principal, audience);
  }

  private projectChange(
    change: RealtimeChange,
  ): { resource: 'order' | 'route' | 'driver'; id: string; data: Record<string, string | boolean> } | null {
    if (!isRecord(change)) return null;

    if (change.type === 'order.status.updated' && isUuid(change.orderId)) {
      const data: Record<string, string | boolean> = { orderId: normalizedUuid(change.orderId) };
      if (typeof change.status === 'string' && ORDER_STATUSES.has(change.status)) {
        data.status = change.status;
      }
      if (typeof change.requiresAdministrativeReview === 'boolean') {
        data.requiresAdministrativeReview = change.requiresAdministrativeReview;
      }
      return { resource: 'order', id: normalizedUuid(change.orderId), data };
    }

    if (change.type === 'route.updated' && isUuid(change.routeId)) {
      const data: Record<string, string | boolean> = { routeId: normalizedUuid(change.routeId) };
      if (typeof change.status === 'string' && ROUTE_STATUSES.has(change.status)) {
        data.status = change.status;
      }
      return { resource: 'route', id: normalizedUuid(change.routeId), data };
    }

    if (change.type === 'dispatch.incident.updated' && isUuid(change.orderId)) {
      const data: Record<string, string | boolean> = { orderId: normalizedUuid(change.orderId) };
      if (typeof change.action === 'string' && INCIDENT_ACTIONS.has(change.action)) {
        data.action = change.action;
      }
      if (typeof change.requiresAdministrativeReview === 'boolean') {
        data.requiresAdministrativeReview = change.requiresAdministrativeReview;
      }
      return { resource: 'order', id: normalizedUuid(change.orderId), data };
    }

    if (
      change.type === 'driver.availability.updated' &&
      isUuid(change.driverId) &&
      typeof change.available === 'boolean'
    ) {
      return {
        resource: 'driver',
        id: normalizedUuid(change.driverId),
        data: { driverId: normalizedUuid(change.driverId), available: change.available },
      };
    }

    return null;
  }
}
