import { parentPort } from 'node:worker_threads';
import { planRoutes, type ClarkeWrightOptions, type RoutingOrder } from './clarke-wright.js';
import { matrixDistance, type DistanceMatrix } from './matrix-distance.js';

/**
 * Hilo de trabajo de la planificación: ejecuta Clarke & Wright fuera del hilo principal
 * para que una propuesta grande no detenga al resto de peticiones (hallazgo P-1 de #15).
 * Solo recibe datos planos; la función de distancia es siempre Haversine.
 */
export interface PlanRequest {
  id: number;
  orders: RoutingOrder[];
  options: Pick<ClarkeWrightOptions, 'depots' | 'capacity'> & { matrix?: DistanceMatrix };
}

parentPort?.on('message', (request: PlanRequest) => {
  try {
    const { matrix, ...options } = request.options;
    const routes = matrix
      ? planRoutes(request.orders, { ...options, distance: matrixDistance(matrix), directional: true })
      : planRoutes(request.orders, options);
    parentPort!.postMessage({ id: request.id, routes });
  } catch (error) {
    parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});
