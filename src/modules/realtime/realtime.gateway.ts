import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import {
  RealtimeService,
  type RealtimePrincipal,
  type RealtimeSubscription,
} from './realtime.service.js';

const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:3000', 'http://localhost:5173'];
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

type SubscriptionAck =
  | { ok: true }
  | { ok: false; error: 'INVALID_REQUEST' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'UNAVAILABLE' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAllowedRealtimeOrigin(origin: string): boolean {
  const configured = process.env.REALTIME_ALLOWED_ORIGINS;
  const origins = configured === undefined
    ? DEFAULT_ALLOWED_ORIGINS
    : configured.split(',').map((entry) => entry.trim());
  if (origins.length === 0 || origins.some((candidate) => !isCanonicalOrigin(candidate))) {
    return false;
  }
  return origins.includes(origin);
}

function isCanonicalOrigin(candidate: string): boolean {
  if (candidate.length === 0 || candidate.includes('*')) return false;
  try {
    const parsed = new URL(candidate);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.origin === candidate &&
      parsed.username === '' &&
      parsed.password === '';
  } catch {
    return false;
  }
}

function parseSubscription(input: unknown): RealtimeSubscription | null {
  if (!isRecord(input)) return null;
  const keys = Object.keys(input);
  if (input.resource === 'incidents') {
    return keys.length === 1 && keys[0] === 'resource'
      ? { resource: 'incidents' }
      : null;
  }

  if (
    (input.resource !== 'order' && input.resource !== 'route' && input.resource !== 'driver') ||
    keys.length !== 2 ||
    !keys.includes('resource') ||
    !keys.includes('id') ||
    typeof input.id !== 'string' ||
    !UUID_PATTERN.test(input.id)
  ) {
    return null;
  }

  return { resource: input.resource, id: input.id.toLowerCase() };
}

function roomFor(subscription: RealtimeSubscription): string {
  return subscription.resource === 'incidents'
    ? 'incidents:admin'
    : `${subscription.resource}:${subscription.id}`;
}

@WebSocketGateway({
  namespace: '/realtime',
  path: '/socket.io',
  cors: {
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      callback(null, origin !== undefined && isAllowedRealtimeOrigin(origin));
    },
    credentials: false,
    methods: ['GET', 'POST'],
  },
})
export class RealtimeGateway implements OnGatewayInit {
  constructor(private readonly realtime: RealtimeService) {}

  afterInit(namespace: Namespace): void {
    this.realtime.attach(namespace);
    namespace.use(async (socket, next) => {
      const origin = socket.handshake.headers.origin;
      if (origin !== undefined && !isAllowedRealtimeOrigin(origin)) {
        next(new Error('origin_not_allowed'));
        return;
      }

      const auth = socket.handshake.auth;
      const token = isRecord(auth) ? auth.token : undefined;
      try {
        const principal = await this.realtime.authenticate(token);
        if (!principal || typeof token !== 'string') {
          next(new Error('unauthorized'));
          return;
        }
        socket.data.realtimeToken = token;
        socket.data.realtimeUserId = principal.userId;
        socket.data.realtimeRole = principal.role;
        next();
      } catch {
        next(new Error('unauthorized'));
      }
    });
  }

  @SubscribeMessage('resource.subscribe')
  async subscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() input: unknown,
  ): Promise<SubscriptionAck> {
    const subscription = parseSubscription(input);
    if (!subscription) return { ok: false, error: 'INVALID_REQUEST' };

    let principal: RealtimePrincipal | null;
    try {
      principal = await this.realtime.authenticate(client.data.realtimeToken);
    } catch {
      return { ok: false, error: 'UNAVAILABLE' };
    }
    if (!principal) {
      client.disconnect(true);
      return { ok: false, error: 'UNAUTHENTICATED' };
    }
    if (
      client.data.realtimeRole !== undefined &&
      client.data.realtimeRole !== principal.role
    ) {
      client.disconnect(true);
      return { ok: false, error: 'FORBIDDEN' };
    }

    try {
      if (!(await this.realtime.canSubscribe(principal, subscription))) {
        return { ok: false, error: 'FORBIDDEN' };
      }
      await client.join(roomFor(subscription));
      client.data.realtimeUserId = principal.userId;
      client.data.realtimeRole = principal.role;
      return { ok: true };
    } catch {
      return { ok: false, error: 'UNAVAILABLE' };
    }
  }
}
