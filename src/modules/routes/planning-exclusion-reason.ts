import { PlanningIneligibilityReason } from '../orders/order-geography.util.js';

/**
 * Motivos de exclusión que no son geográficos.
 *
 * - ACTIVE_ROUTE_CLAIM: el pedido ya está reservado por otra propuesta confirmada (ruta DRAFT).
 * - ADMINISTRATIVE_REVIEW_REQUIRED: el administrador debe revisarlo a mano; ocurre cuando
 *   una entrega falló (visita fallida) y el pedido no se replanifica hasta que un ADMIN
 *   intervenga y acuerde una nueva fecha.
 */
export const ExclusionReason = {
  ACTIVE_ROUTE_CLAIM: 'ACTIVE_ROUTE_CLAIM',
  ADMINISTRATIVE_REVIEW_REQUIRED: 'ADMINISTRATIVE_REVIEW_REQUIRED',
} as const;

/**
 * Lista completa de códigos que puede devolver `excluded[].reasons`. Es la fuente del
 * enum publicado en Swagger: si se agrega un código nuevo aparece aquí y la prueba
 * `planning-exclusion-reason.spec.ts` falla hasta actualizar la lista fijada, como
 * recordatorio de avisar a quien consume la API (interfaz web).
 */
export const PLANNING_EXCLUSION_REASONS = [
  ...Object.values(PlanningIneligibilityReason),
  ...Object.values(ExclusionReason),
] as const;

export type PlanningExclusionReason = (typeof PLANNING_EXCLUSION_REASONS)[number];
