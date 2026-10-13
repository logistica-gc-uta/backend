import { csv, stringifyReport } from './output.js';

describe('csv', () => {
  it('escribe encabezados y filas', () => {
    expect(csv([{ a: 1, b: 'x' }, { a: 2, b: 'y' }])).toBe('a,b\n1,x\n2,y\n');
  });

  it('entrecomilla comas, comillas y saltos de línea', () => {
    expect(csv([{ text: 'a,b', quote: 'di "hola"', nl: 'l1\nl2' }])).toBe('text,quote,nl\n"a,b","di ""hola""","l1\nl2"\n');
  });

  it('trata null y undefined como vacío y serializa objetos como JSON', () => {
    expect(csv([{ a: null, b: undefined, c: { x: 1 } }])).toBe('a,b,c\n,,"{""x"":1}"\n');
  });

  it('sin filas devuelve solo el salto de línea final', () => {
    expect(csv([])).toBe('\n');
  });
});

describe('stringifyReport', () => {
  const report = {
    meta: { node: 'v26', nested: { a: [1, 2] } },
    datasets: [
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
    ],
    empty: [],
    checksum: 'abc',
  };

  it('es JSON estándar y recupera exactamente el mismo objeto', () => {
    expect(JSON.parse(stringifyReport(report))).toEqual(report);
  });

  it('pone cada elemento de un arreglo en una sola línea', () => {
    const lines = stringifyReport(report).split('\n');
    expect(lines).toContain('    {"id":"a","value":1},');
    expect(lines).toContain('    {"id":"b","value":2}');
  });

  it('mantiene los objetos de primer nivel con sangría y termina en salto de línea', () => {
    const text = stringifyReport(report);
    expect(text.startsWith('{\n  "meta": {\n    "node": "v26"')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('es mucho más corto que JSON.stringify con sangría para listas largas', () => {
    const big = { rows: Array.from({ length: 200 }, (_, i) => ({ i, nested: { a: i, b: [i, i] } })) };
    expect(stringifyReport(big).split('\n').length).toBeLessThan(JSON.stringify(big, null, 2).split('\n').length / 4);
  });
});
