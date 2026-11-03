import { describe, expect, it } from 'vitest';
import type { Payment } from '../types';
import { refundable } from './refundable';

const at = '2026-11-03T10:00:00.000Z';
const payment = (id: string, amountMinor: number): Payment => ({
  id,
  invoiceId: 'inv_1',
  kind: 'payment',
  amountMinor,
  method: 'cash',
  recordedByName: 'Asha',
  at,
});
const refundOf = (id: string, of: string, amountMinor: number): Payment => ({
  ...payment(id, amountMinor),
  kind: 'refund',
  refundOf: of,
});

describe('refundable', () => {
  it('lists the payments most recent first, each holding its whole amount', () => {
    const result = refundable([payment('a', 1000), payment('b', 500)]);
    expect(result.map((each) => [each.payment.id, each.heldMinor])).toEqual([
      ['b', 500],
      ['a', 1000],
    ]);
  });

  it('takes every refund of a payment off what it holds', () => {
    const result = refundable([
      payment('a', 1000),
      refundOf('r1', 'a', 300),
      refundOf('r2', 'a', 200),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.heldMinor).toBe(500);
  });

  it('drops a payment that is refunded in full, and keeps the others', () => {
    const result = refundable([payment('a', 1000), payment('b', 500), refundOf('r1', 'a', 1000)]);
    expect(result.map((each) => each.payment.id)).toEqual(['b']);
  });

  it('is empty when there is nothing to refund', () => {
    expect(refundable([])).toEqual([]);
    expect(refundable([refundOf('r1', 'a', 100)])).toEqual([]);
  });
});
