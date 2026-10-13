import { createRng } from './prng.js';

describe('prng', () => {
  it('la misma semilla produce la misma secuencia y otra semilla produce otra', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const first = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(first);
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(first);
  });

  it('genera valores en [0, 1)', () => {
    const rng = createRng(1);
    for (let i = 0; i < 1000; i++) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
