import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { useModuleName } from './modules';

const IDS = [
  'admissions',
  'ambulance',
  'bloodbank',
  'documents',
  'emergency',
  'housekeeping',
  'insurance',
  'nursing',
  'roster',
  'theatre',
  'unknown_x',
];

function Names() {
  const name = useModuleName();
  return (
    <ul>
      {IDS.map((id) => (
        <li key={id} data-testid={id}>
          {name(id)}
        </li>
      ))}
    </ul>
  );
}

describe('useModuleName', () => {
  it('names the modules a hospital can switch on and keeps an unknown id as it is', async () => {
    renderWithProviders(<Names />);
    for (const id of IDS.slice(0, -1))
      expect((await screen.findByTestId(id)).textContent).not.toBe(id);
    expect((await screen.findByTestId('unknown_x')).textContent).toBe('unknown_x');
  });
});
