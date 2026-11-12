import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEME_KEY } from '@/shared/lib/color-scheme';
import { renderWithProviders } from '@/test/render';
import { expectNoAxeViolations } from '@/test/axe';
import { ThemeSwitch } from './ThemeSwitch';

describe('ThemeSwitch', () => {
  beforeEach(() => {
    window.localStorage.removeItem(SCHEME_KEY);
    document.documentElement.classList.remove('dark');
  });
  afterEach(() => {
    window.localStorage.removeItem(SCHEME_KEY);
    document.documentElement.classList.remove('dark');
  });

  it('cycles light, dark, system, keeps the name only and sets the root class', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ThemeSwitch />, { session: null });
    await user.click(await screen.findByRole('button', { name: /Theme: system. Change to light/ }));
    expect(window.localStorage.getItem(SCHEME_KEY)).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    await user.click(screen.getByRole('button', { name: /Theme: light. Change to dark/ }));
    expect(window.localStorage.getItem(SCHEME_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    await user.click(screen.getByRole('button', { name: /Theme: dark. Change to system/ }));
    expect(window.localStorage.getItem(SCHEME_KEY)).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('starts from the saved choice', async () => {
    window.localStorage.setItem(SCHEME_KEY, 'dark');
    renderWithProviders(<ThemeSwitch />, { session: null });
    expect(await screen.findByRole('button', { name: /Theme: dark/ })).toBeInTheDocument();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
