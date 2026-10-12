import { BadRequestException } from '@nestjs/common';
import { consolidateOrderItems, MAX_INVENTORY_QUANTITY } from './order-inventory.util.js';

describe('consolidateOrderItems', () => {
  it('consolidates quantities and orders locks by codepoint, independently of input order', () => {
    expect(consolidateOrderItems([{ productId: 'z', quantity: 2 }, { productId: 'a', quantity: 1 }, { productId: 'z', quantity: 3 }]))
      .toEqual([{ productId: 'a', quantity: 1 }, { productId: 'z', quantity: 5 }]);
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, MAX_INVENTORY_QUANTITY + 1])('rejects invalid quantity %s', (quantity) => {
    expect(() => consolidateOrderItems([{ productId: 'a', quantity }])).toThrow(BadRequestException);
  });
  it('rejects aggregate overflow even when each quantity is bounded', () => {
    expect(() => consolidateOrderItems([{ productId: 'a', quantity: MAX_INVENTORY_QUANTITY }, { productId: 'a', quantity: 1 }])).toThrow(BadRequestException);
  });
  it('accepts the PostgreSQL int4 upper boundary', () => {
    expect(consolidateOrderItems([{ productId: 'a', quantity: MAX_INVENTORY_QUANTITY }])[0].quantity).toBe(MAX_INVENTORY_QUANTITY);
  });
  it('rejects empty items and blank product IDs', () => {
    expect(() => consolidateOrderItems([])).toThrow(BadRequestException);
    expect(() => consolidateOrderItems([{ productId: '', quantity: 1 }])).toThrow(BadRequestException);
  });
});
