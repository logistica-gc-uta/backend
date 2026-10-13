/** Version 1: invalidation hints; authorized REST GET remains authoritative. */
export type RealtimeChange =
  | { type: 'order.status.updated'; orderId: string; status?: string; requiresAdministrativeReview?: boolean }
  | { type: 'route.updated'; routeId: string; status?: string }
  | { type: 'dispatch.incident.updated'; orderId: string; action?: string; requiresAdministrativeReview?: boolean }
  | { type: 'driver.availability.updated'; driverId: string; available: boolean };

export interface RealtimeEnvelope {
  version: 1;
  eventId: string;
  occurredAt: string;
  data: Record<string, string | boolean>;
}

export const REALTIME_PUBLISHER = 'REALTIME_PUBLISHER';

/** Do not enqueue or invoke publication inside a transaction callback. */
export interface RealtimePublisher {
  publish(changes: readonly RealtimeChange[]): Promise<void>;
}
