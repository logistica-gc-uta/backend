import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * OSRM simulado para pruebas: habla el mismo protocolo (`table`, `route`, `nearest`) pero con una red vial
 * inventada y determinista. NO es un servicio de producción ni sustituye la validación con calles reales
 * (esa se registra en docs/issue-47-road-engine.md con un OSRM de verdad).
 *
 * Modelo de la red de prueba:
 * - un río en la longitud `riverLng`: cruzarlo solo se puede por el puente (`bridgeLat`), así que cruzar
 *   cuesta un rodeo grande frente a la línea recta;
 * - las calles tienen un sentido preferente: ir hacia el norte cuesta 300 m más que hacia el sur (asimetría);
 * - la velocidad media es de 30 km/h (sin tráfico).
 */
export interface FakeOsrmOptions {
  mode?: 'ok' | 'server-error' | 'incomplete' | 'not-json' | 'no-route-pair' | 'far-point' | 'bad-values' | 'negative-noise' | 'bad-distance' | 'slow';
  riverLng?: number;
  bridgeLat?: number;
  /** En `no-route-pair`: el punto (índice de coordenada) que queda aislado de la red. */
  isolatedIndex?: number;
  slowMs?: number;
}

type Point = [number, number]; // [lng, lat]

const haversineM = (a: Point, b: Point) => {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
};

export function fakeRoadMeters(a: Point, b: Point, opts: FakeOsrmOptions = {}): number {
  if (a[0] === b[0] && a[1] === b[1]) return 0;
  const riverLng = opts.riverLng;
  const bridgeLat = opts.bridgeLat ?? -1.24;
  const crosses = riverLng !== undefined && (a[0] - riverLng) * (b[0] - riverLng) < 0;
  const straight = haversineM(a, b);
  let meters: number;
  if (crosses) {
    const bridge: Point = [riverLng!, bridgeLat];
    meters = (haversineM(a, bridge) + haversineM(bridge, b)) * 1.15;
  } else {
    meters = straight * 1.3;
  }
  return Math.round(meters + (b[1] > a[1] ? 300 : 0));
}

const secondsFor = (meters: number) => Math.round(meters / (30_000 / 3600));

function parseCoordinates(path: string): Point[] {
  const segment = path.split('?')[0]!.split('/')[4] ?? '';
  return segment.split(';').filter(Boolean).map((pair) => pair.split(',').map(Number) as Point);
}

/** Respuesta de la ruta HTTP simulada: `{status, body}` (body ya serializable). */
export function fakeOsrmResponse(rawUrl: string, opts: FakeOsrmOptions = {}): { status: number; body: unknown } {
  const url = new URL(rawUrl, 'http://fake-osrm');
  const service = url.pathname.split('/')[1];
  const coords = parseCoordinates(url.pathname);
  const mode = opts.mode ?? 'ok';
  if (mode === 'server-error') return { status: 500, body: { code: 'InternalError', message: 'fallo simulado' } };
  if (mode === 'not-json') return { status: 200, body: '<html>no es JSON</html>' };

  if (service === 'nearest') {
    return { status: 200, body: { code: 'Ok', waypoints: [{ location: coords[0], distance: 7, name: 'Calle simulada' }] } };
  }

  if (service === 'route') {
    if (mode === 'incomplete') return { status: 200, body: { code: 'Ok', routes: [{ distance: 1000 }] } };
    let meters = 0;
    for (let i = 1; i < coords.length; i++) meters += fakeRoadMeters(coords[i - 1]!, coords[i]!, opts);
    return {
      status: 200,
      body: { code: 'Ok', routes: [{ distance: meters, duration: secondsFor(meters), geometry: { type: 'LineString', coordinates: coords } }] },
    };
  }

  if (service === 'table') {
    const sources = (url.searchParams.get('sources') ?? coords.map((_, i) => i).join(';')).split(';').map(Number);
    const destinations = (url.searchParams.get('destinations') ?? coords.map((_, i) => i).join(';')).split(';').map(Number);
    const distances: (number | null)[][] = sources.map((s) => destinations.map((d) => fakeRoadMeters(coords[s]!, coords[d]!, opts)));
    const durations: (number | null)[][] = distances.map((row) => row.map((m) => (m === null ? null : secondsFor(m))));
    if (mode === 'no-route-pair') {
      const isolated = opts.isolatedIndex ?? 1;
      sources.forEach((s, a) => destinations.forEach((d, b) => {
        if ((s === isolated) !== (d === isolated)) {
          distances[a]![b] = null;
          durations[a]![b] = null;
        }
      }));
    }
    if (mode === 'bad-values') durations[0]![destinations.length - 1] = -5;
    // Ruido numérico de OSRM (valores levemente negativos) y un negativo grande que sí es inválido.
    if (mode === 'negative-noise') {
      distances[0]![destinations.length - 1] = -0.5;
      durations[0]![destinations.length - 1] = -0.2;
    }
    if (mode === 'bad-distance') distances[0]![destinations.length - 1] = -500;
    const waypoint = (index: number) => ({ location: coords[index], distance: mode === 'far-point' && index === (opts.isolatedIndex ?? 1) ? 2500 : 6, name: 'Calle simulada' });
    const body: Record<string, unknown> = { code: 'Ok', distances, durations, sources: sources.map(waypoint), destinations: destinations.map(waypoint) };
    if (mode === 'incomplete') delete body.durations;
    return { status: 200, body };
  }
  return { status: 400, body: { code: 'InvalidService', message: 'servicio desconocido' } };
}

/** `fetch` simulado (sin red) para pruebas unitarias. */
export function createFakeOsrmFetch(opts: FakeOsrmOptions = {}, calls: string[] = []): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if ((opts.mode ?? 'ok') === 'slow') {
      // Como el `fetch` real: si la petición se aborta mientras espera, rechaza con AbortError.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, opts.slowMs ?? 200);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
      });
    }
    const { status, body } = fakeOsrmResponse(url, opts);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (typeof body === 'string') throw new SyntaxError('Unexpected token <');
        return body;
      },
    } as Response;
  }) as typeof fetch;
}

/** Servidor HTTP real en loopback con un puerto efímero, para pruebas de integración de punta a punta. */
export async function startFakeOsrmServer(opts: FakeOsrmOptions = {}): Promise<{ url: string; calls: string[]; setOptions: (next: FakeOsrmOptions) => void; close: () => Promise<void> }> {
  let current = opts;
  const calls: string[] = [];
  const server: Server = createServer(async (request, response) => {
    calls.push(request.url ?? '');
    if ((current.mode ?? 'ok') === 'slow') await new Promise((resolve) => setTimeout(resolve, current.slowMs ?? 200));
    const { status, body } = fakeOsrmResponse(request.url ?? '/', current);
    response.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json' });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    setOptions: (next) => {
      current = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
