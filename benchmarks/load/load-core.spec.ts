import {
  DEFAULT_DATE,
  DEFAULT_SEED,
  PERF_TAG,
  ROUTE_CAPACITY,
  VOLUME_SIZES,
  buildDataset,
  datasetChecksum,
  theoreticalRoutes,
} from './dataset.js';
import { parseJtl, splitCsvLine, summarizeJtl } from './jtl.js';
import { percentileSorted, round, summarizeLatencies } from './stats.js';

describe('percentiles y resumen de latencias', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it('calcula p50, p95 y p99 por rango más cercano', () => {
    expect(percentileSorted(hundred, 50)).toBe(50);
    expect(percentileSorted(hundred, 95)).toBe(95);
    expect(percentileSorted(hundred, 99)).toBe(99);
    expect(percentileSorted(hundred, 100)).toBe(100);
    expect(percentileSorted(hundred, 0)).toBe(1);
  });

  it('devuelve NaN sin datos y el único valor con uno solo', () => {
    expect(percentileSorted([], 95)).toBeNaN();
    expect(percentileSorted([7], 99)).toBe(7);
    expect(summarizeLatencies([]).count).toBe(0);
    expect(summarizeLatencies([]).p95).toBeNaN();
  });

  it('ordena internamente y no modifica el arreglo recibido', () => {
    const input = [30, 10, 20];
    const summary = summarizeLatencies(input);
    expect(input).toEqual([30, 10, 20]);
    expect(summary).toMatchObject({ count: 3, min: 10, max: 30, mean: 20, p50: 20 });
  });

  it('redondea sin romper valores no finitos', () => {
    expect(round(1.2345, 2)).toBe(1.23);
    expect(round(Number.NaN)).toBeNaN();
  });
});

describe('lectura de resultados JMeter (JTL CSV)', () => {
  const header = 'timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads';
  const row = (ts: number, elapsed: number, label: string, code: string, ok: boolean, threads = 5) =>
    `${ts},${elapsed},${label},${code},OK,g 1-1,text,${ok},,100,50,${threads},${threads}`;

  it('separa campos respetando comillas y comillas escapadas', () => {
    expect(splitCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
    expect(splitCsvLine('"di ""hola""",x')).toEqual(['di "hola"', 'x']);
    expect(splitCsvLine('')).toEqual(['']);
  });

  it('parsea muestras y exige las columnas necesarias', () => {
    const samples = parseJtl([header, row(1000, 50, 'A', '200', true)].join('\n'));
    expect(samples).toEqual([{ timeStamp: 1000, elapsed: 50, label: 'A', responseCode: '200', success: true, bytes: 100, allThreads: 5 }]);
    expect(() => parseJtl('timeStamp,elapsed\n1,2')).toThrow('columnas');
    expect(parseJtl('')).toEqual([]);
    expect(() => parseJtl([header, row(Number.NaN, 5, 'A', '200', true)].join('\n'))).toThrow('tiempo inválido');
  });

  it('resume latencias, errores, rendimiento y códigos de respuesta por etiqueta', () => {
    const lines = [header];
    for (let i = 0; i < 90; i++) lines.push(row(1000 + i * 10, 20 + (i % 10), 'GET catalogo', '200', true, 10));
    for (let i = 0; i < 10; i++) lines.push(row(1000 + i * 10, 200, 'POST pedido', i < 8 ? '201' : '500', i < 8, 25));

    const report = summarizeJtl(parseJtl(lines.join('\n')));

    expect(report.samples).toBe(100);
    expect(report.errors).toBe(2);
    expect(report.errorRate).toBeCloseTo(0.02);
    expect(report.maxThreads).toBe(25);
    expect(report.responseCodes).toEqual({ '200': 90, '201': 8, '500': 2 });
    expect(report.byLabel.map((l) => l.label)).toEqual(['GET catalogo', 'POST pedido']);
    const post = report.byLabel.find((l) => l.label === 'POST pedido')!;
    expect(post).toMatchObject({ count: 10, errors: 2, p50: 200 });
    expect(post.errorRate).toBeCloseTo(0.2);
    // ventana: de 1000 al último fin (1890+22 o 1090+200) ≈ 0,9 s
    expect(report.durationSeconds).toBeGreaterThan(0.5);
    expect(report.throughput).toBeCloseTo(report.samples / report.durationSeconds);
  });

  it('un JTL vacío da un resumen en cero', () => {
    expect(summarizeJtl([])).toMatchObject({ samples: 0, errors: 0, throughput: 0, byLabel: [] });
  });
});

describe('conjunto de datos reproducible de volumen', () => {
  it('con la misma semilla genera exactamente lo mismo (misma huella)', () => {
    expect(datasetChecksum(buildDataset(500))).toBe(datasetChecksum(buildDataset(500)));
    expect(datasetChecksum(buildDataset(500, DEFAULT_SEED + 1))).not.toBe(datasetChecksum(buildDataset(500)));
  });

  it.each(VOLUME_SIZES)('el volumen %i trae esa cantidad de pedidos con direcciones únicas y coordenadas cercanas al depósito', (size) => {
    const dataset = buildDataset(size);
    expect(dataset.orders).toHaveLength(size);
    expect(new Set(dataset.orders.map((o) => o.deliveryAddress)).size).toBe(size);
    const depots = new Map(dataset.zones.map((z) => [z.code, z]));
    for (const order of dataset.orders) {
      const depot = depots.get(order.zoneCode)!;
      expect(Math.abs(order.lat - depot.depotLat)).toBeLessThanOrEqual(0.0101);
      expect(Math.abs(order.lng - depot.depotLng)).toBeLessThanOrEqual(0.0101);
    }
  });

  it('2000 pedidos dan 500 salidas si todos se asignan de cuatro en cuatro', () => {
    expect(theoreticalRoutes(buildDataset(2000))).toBe(500);
    expect(theoreticalRoutes(buildDataset(500))).toBe(125);
    expect(theoreticalRoutes(buildDataset(100))).toBe(25);
    expect(ROUTE_CAPACITY).toBe(4);
  });

  it('cada zona queda con un múltiplo de cuatro pedidos y por debajo del tope de planificación (2000)', () => {
    const dataset = buildDataset(2000);
    const perZone = new Map<string, number>();
    for (const order of dataset.orders) perZone.set(order.zoneCode, (perZone.get(order.zoneCode) ?? 0) + 1);
    for (const count of perZone.values()) {
      expect(count % 4).toBe(0);
      expect(count).toBeLessThanOrEqual(2000);
    }
    expect(perZone.size).toBe(5);
  });

  it('todo lo creado lleva la marca de limpieza (zonas, correos y direcciones)', () => {
    const dataset = buildDataset(100);
    expect(dataset.zones.every((z) => z.code.startsWith(PERF_TAG.zoneCodePrefix))).toBe(true);
    expect([...dataset.clients, ...dataset.drivers].every((u) => u.email.endsWith(PERF_TAG.emailDomain))).toBe(true);
    expect(dataset.orders.every((o) => o.deliveryAddress.startsWith(PERF_TAG.addressPrefix))).toBe(true);
    expect(dataset.date).toBe(DEFAULT_DATE);
  });

  it('rechaza tamaños que no son múltiplo de la capacidad', () => {
    expect(() => buildDataset(10)).toThrow('múltiplo');
    expect(() => buildDataset(0)).toThrow('múltiplo');
    expect(() => buildDataset(20000)).toThrow('Demasiados');
  });
});
