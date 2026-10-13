import { runEdgeCases } from './edge-cases.js';

describe('casos de borde', () => {
  it('todos los casos de borde cumplen lo esperado', () => {
    const edge = runEdgeCases();
    expect(edge.length).toBeGreaterThanOrEqual(12);
    expect(edge.filter((e) => !e.pass)).toEqual([]);
  });
});
