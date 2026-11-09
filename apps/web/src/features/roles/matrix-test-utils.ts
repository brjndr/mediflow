import { screen } from '@testing-library/react';

/**
 * The checkbox of one permission in the matrix, found by the permission shown beside it.
 * `getByRole('checkbox', { name })` works out the accessible name of every checkbox in the
 * catalog on each call, which takes seconds in jsdom and made these tests time out in CI.
 */
export function box(permission: string): HTMLInputElement {
  const label = screen.getByText(permission, { selector: 'code' }).closest('label');
  const input = label && document.getElementById(label.htmlFor);
  if (!(input instanceof HTMLInputElement)) throw new Error('no checkbox for a permission');
  return input;
}
