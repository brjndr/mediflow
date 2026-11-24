import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { grantPermission, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The collected today widget's bar of each payment mode's share (#1127). The list stays the text
// alternative: each row gives the amount and the share; the bar is hidden from assistive technology.

const COLLECTED = 'Collected today';
const home = () => screen.findByRole('heading', { name: 'Hospital management system' });

function collected(totals: { method: string; paidMinor: number; refundedMinor: number }[]) {
  server.use(
    http.get('*/api/cash-registers/collected', () =>
      HttpResponse.json({
        date: '2026-11-14',
        timezone: 'Asia/Kolkata',
        totals,
        netMinor: totals.reduce((sum, each) => sum + each.paidMinor - each.refundedMinor, 0),
      }),
    ),
  );
}

async function widget() {
  const region = await screen.findByRole('region', { name: COLLECTED });
  await within(region).findByRole('list');
  return region;
}

const row = (region: HTMLElement, name: string) =>
  within(region)
    .getAllByRole('listitem')
    .find((each) => each.textContent?.includes(name));

describe('collected today: the split by payment mode', () => {
  it('gives each mode its amount and share, and a bar of the shares hidden from screen readers', async () => {
    // UPI 4,700, cash 3,800 (net of a 200 refund), card 1,500: 47%, 38% and 15%.
    collected([
      { method: 'cash', paidMinor: 400000, refundedMinor: 20000 },
      { method: 'card', paidMinor: 150000, refundedMinor: 0 },
      { method: 'upi', paidMinor: 470000, refundedMinor: 0 },
    ]);
    signIn(USER_IDS.admin);
    const { container } = renderApp();
    await home();
    const region = await widget();

    expect(row(region, 'UPI')).toHaveTextContent(/4,700\.00\s*47%/);
    expect(row(region, 'Cash')).toHaveTextContent(/3,800\.00\s*38%/);
    expect(row(region, 'Card')).toHaveTextContent(/1,500\.00\s*15%/);

    const segments = region.querySelectorAll<HTMLElement>('[data-method]');
    expect([...segments].map((each) => each.dataset.method)).toEqual(['cash', 'card', 'upi']);
    expect(segments[0]?.parentElement).toHaveAttribute('aria-hidden', 'true');
    // Told apart by lightness: the largest share is the solid one, the others lighter.
    const upi = region.querySelector<HTMLElement>('[data-method="upi"]');
    const card = region.querySelector<HTMLElement>('[data-method="card"]');
    expect(upi?.className).toMatch(/bg-primary-foreground(\s|$)/);
    expect(card?.className).toContain('bg-primary-foreground/30');
    expect(Number(upi?.style.flexGrow)).toBeCloseTo(0.47);

    await expectNoAxeViolations(container);
  });

  it('formats the share for the hospital and gives a mode that refunded more than it took no share', async () => {
    collected([
      { method: 'cash', paidMinor: 10000, refundedMinor: 30000 },
      { method: 'upi', paidMinor: 50000, refundedMinor: 0 },
    ]);
    grantPermission(TENANT_IDS.clinic, 'billing_clerk', 'cashRegister:read');
    signIn(USER_IDS.billingClerk, TENANT_IDS.clinic);
    renderApp();
    await home();
    const region = await widget();
    expect(row(region, 'UPI')).toHaveTextContent('100%');
    expect(row(region, 'Cash')).not.toHaveTextContent('%');
    expect(region.querySelectorAll('[data-method]')).toHaveLength(1);
  });

  it('keeps the empty line, with no bar, when nothing was taken today', async () => {
    collected([]);
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    const region = await screen.findByRole('region', { name: COLLECTED });
    expect(await within(region).findByText('Nothing taken yet today.')).toBeInTheDocument();
    expect(region.querySelector('[data-method]')).toBeNull();
  });
});
