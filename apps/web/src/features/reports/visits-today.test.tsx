import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import widgetStrings from './widget-strings.json';
import hindiStrings from './widget-strings.hi.json';

// The visits widget (#1124): today's opened visits against yesterday by this time of day, and the
// consultations done against today's booked appointments, from the `opd_progress` report. The
// mock's hospital has 42 opened against 30 yesterday by now, and 18 done of 24 booked; the clinic
// 5 against 8, and 2 of 6.

const VISITS = 'OPD visits today';
const home = () => screen.findByRole('heading', { name: 'Hospital management system' });

async function widget() {
  const region = await screen.findByRole('region', { name: VISITS });
  await within(region).findByText('Opened');
  return region;
}

describe('the visits widget', () => {
  it('compares today with this time yesterday and shows consultations against bookings', async () => {
    signIn(USER_IDS.admin);
    const { container } = renderApp();
    await home();
    const region = await widget();

    expect(within(region).getByText('42')).toBeInTheDocument();
    expect(within(region).getByText('12 more than this time yesterday')).toBeInTheDocument();
    const bar = within(region).getByRole('progressbar', { name: 'Consultations done' });
    expect(bar).toHaveAttribute('aria-valuenow', '18');
    expect(bar).toHaveAttribute('aria-valuemax', '24');
    expect(bar).toHaveAttribute('aria-valuetext', '18 of 24 booked');
    expect(within(region).getByText('18 of 24 booked')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('gives another hospital its own figures, and a drop in words', async () => {
    setTenantFeature(TENANT_IDS.clinic, 'reports', true);
    grantPermission(TENANT_IDS.clinic, 'doctor', 'report:read');
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    renderApp();
    await home();
    const region = await widget();

    expect(within(region).getByText('3 fewer than this time yesterday')).toBeInTheDocument();
    expect(within(region).getByRole('progressbar')).toHaveAttribute(
      'aria-valuetext',
      '2 of 6 booked',
    );
  });

  it('says an empty day in words, with no bar', async () => {
    server.use(
      http.post('*/api/reports/opd_progress', async ({ request }) => {
        const body = (await request.json()) as { from: string; to: string };
        return HttpResponse.json({
          kind: 'opd_progress',
          from: body.from,
          to: body.to,
          currency: 'INR',
          generatedAt: new Date().toISOString(),
          columns: [
            { key: 'day', type: 'date' },
            { key: 'opened', type: 'integer' },
            { key: 'openedByNow', type: 'integer' },
            { key: 'consultationsDone', type: 'integer' },
            { key: 'booked', type: 'integer' },
          ],
          rows: [
            [body.from, 0, 0, 0, 0],
            [body.to, 0, 0, 0, 0],
          ],
          totals: [null, 0, 0, 0, 0],
        });
      }),
    );
    signIn(USER_IDS.admin);
    const { container } = renderApp();
    await home();
    const region = await widget();

    expect(within(region).getByText('Same as this time yesterday')).toBeInTheDocument();
    expect(within(region).getByText('No appointments booked today.')).toBeInTheDocument();
    expect(within(region).queryByRole('progressbar')).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('says so in place when the report fails', async () => {
    server.use(
      http.post('*/api/reports/opd_progress', () =>
        HttpResponse.json({ code: 'server_error' }, { status: 500 }),
      ),
    );
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    const region = await screen.findByRole('region', { name: VISITS });
    expect(await within(region).findByRole('alert')).toBeInTheDocument();
  });

  it('is left out without report:read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'report:read');
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    expect(screen.queryByRole('region', { name: VISITS })).not.toBeInTheDocument();
  });

  it('has every widget string in Hindi, with the same placeholders', () => {
    const flat = (tree: object, prefix = ''): Record<string, string> =>
      Object.entries(tree).reduce<Record<string, string>>(
        (all, [key, value]) =>
          typeof value === 'string'
            ? { ...all, [prefix + key]: value }
            : { ...all, ...flat(value as object, `${prefix}${key}.`) },
        {},
      );
    const marks = (text = '') => [...text.matchAll(/{{w+}}/g)].map((m) => m[0]).sort();
    const english = flat(widgetStrings);
    const hindi = flat(hindiStrings);
    expect(Object.keys(hindi).sort()).toEqual(Object.keys(english).sort());
    for (const [key, text] of Object.entries(english)) {
      expect(marks(hindi[key]), key).toEqual(marks(text));
    }
  });
});
