import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { planRoutes, type ClarkeWrightOptions, type PlannedRoute, type RoutingOrder } from './algorithms/clarke-wright.js';
import { matrixDistance, type DistanceMatrix } from './algorithms/matrix-distance.js';
import type { PlanRequest } from './algorithms/plan-routes.worker.js';

type PlanOptions = Pick<ClarkeWrightOptions, 'depots' | 'capacity'> & {
  /** Matriz vial (km, direccional). Sin ella se usa la línea recta de siempre. */
  matrix?: DistanceMatrix;
};

const WORKER_RELATIVE = 'modules/routes/algorithms/plan-routes.worker.js';
const CACHE_LIMIT = 32;

/** Ruta del worker compilado (`dist/…`) o `undefined` si se corre desde TypeScript (tests, tsx). */
export function resolveWorkerFile(entry = process.argv[1]): string | undefined {
  if (!entry) return undefined;
  const file = path.join(path.dirname(entry), WORKER_RELATIVE);
  return existsSync(file) ? file : undefined;
}

/** Clave de contenido: la misma entrada produce siempre la misma clave, así que nunca sirve datos viejos. */
export function planKey(orders: readonly RoutingOrder[], options: PlanOptions): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([options.capacity ?? null, Object.entries(options.depots).sort(([a], [b]) => a.localeCompare(b))]));
  for (const order of [...orders].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(`|${order.id},${order.zoneId},${order.deliveryDate},${order.location.lat},${order.location.lng}`);
  }
  // La red vial cambia el resultado: dos matrices distintas nunca comparten caché.
  if (options.matrix) {
    hash.update('|matrix');
    for (const row of options.matrix.distanceKm) hash.update(row.join(','));
  }
  return hash.digest('hex');
}

/**
 * Ejecuta Clarke & Wright sin bloquear el hilo principal:
 * 1. memoiza por contenido (la función es pura y determinista), con un LRU pequeño;
 * 2. une las peticiones idénticas concurrentes en un solo cálculo;
 * 3. calcula en un worker thread cuando hay build compilado; si no, o si el worker falla, en línea.
 */
export class RoutePlanner {
  private readonly cache = new Map<string, PlannedRoute[]>();
  private readonly inflight = new Map<string, Promise<PlannedRoute[]>>();
  private readonly pending = new Map<number, { resolve: (routes: PlannedRoute[]) => void; reject: (error: Error) => void }>();
  private worker?: Worker;
  private nextId = 1;
  readonly stats = { computed: 0, cacheHits: 0, joined: 0, workerRuns: 0, inlineRuns: 0 };

  constructor(private readonly workerFile: string | undefined = resolveWorkerFile()) {}

  async plan(orders: RoutingOrder[], options: PlanOptions): Promise<PlannedRoute[]> {
    const key = planKey(orders, options);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached); // el más reciente al final
      this.stats.cacheHits++;
      return structuredClone(cached);
    }
    const running = this.inflight.get(key);
    if (running) {
      this.stats.joined++;
      return structuredClone(await running);
    }
    const job = this.compute(orders, options).then((routes) => {
      this.cache.set(key, routes);
      if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
      return routes;
    });
    this.inflight.set(key, job);
    try {
      return structuredClone(await job);
    } finally {
      this.inflight.delete(key);
    }
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    await worker?.terminate();
  }

  private async compute(orders: RoutingOrder[], options: PlanOptions): Promise<PlannedRoute[]> {
    this.stats.computed++;
    if (this.workerFile) {
      try {
        const routes = await this.runInWorker(orders, options);
        this.stats.workerRuns++;
        return routes;
      } catch (error) {
        // Errores de datos (p. ej. depósito faltante) se repiten en línea y se propagan igual que antes.
        if (!(error instanceof WorkerFailure)) throw error;
      }
    }
    this.stats.inlineRuns++;
    const { matrix, ...base } = options;
    return matrix ? planRoutes(orders, { ...base, distance: matrixDistance(matrix), directional: true }) : planRoutes(orders, base);
  }

  private runInWorker(orders: RoutingOrder[], options: PlanOptions): Promise<PlannedRoute[]> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<PlannedRoute[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: PlanRequest = { id, orders, options };
      worker.postMessage(request);
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerFile!);
    worker.unref(); // no impide que el proceso termine
    worker.on('message', (message: { id: number; routes?: PlannedRoute[]; error?: string }) => {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) entry.reject(new Error(message.error));
      else entry.resolve(message.routes!);
    });
    const fail = (error: Error) => {
      if (this.worker === worker) this.worker = undefined;
      for (const entry of this.pending.values()) entry.reject(new WorkerFailure(error.message));
      this.pending.clear();
    };
    worker.on('error', fail);
    worker.on('exit', (code) => fail(new Error(`worker terminó con código ${code}`)));
    this.worker = worker;
    return worker;
  }
}

class WorkerFailure extends Error {}
