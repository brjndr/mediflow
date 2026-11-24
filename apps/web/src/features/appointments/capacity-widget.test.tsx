import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import {
  currentPolicy,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The OPD capacity ring on the landing page (#1126), contributed by the appointments feature.
const TITLE = 'OPD capacity today';
const home = () => screen.findByRole('heading', { name: 'Hospital management system' });
const tile = () => screen.queryByRole('region', { name: TITLE });

interface Answer {
  day: string;
  slots: number;
  booked: number;
  free: number;
  waiting?: number;
  inConsult?: number;
}

/** A fixed answer for each hospital, chosen by the session the request is made in. */
function capacity(byTenant: Record<string, Answer>) {
  server.use(
    http.get('*/api/appointments/capacity', () => {
      const answer = byTenant[currentPolicy()?.tenantId ?? ''];
      return answer
        ? HttpResponse.json(answer)
        : HttpResponse.json({ code: 'not_found' }, { status: 404 });
    }),
  );
}

const HOSPITAL: Answer = {
  day: '2026-11-24',
  slots: 50,
  booked: 36,
  free: 9,
  waiting: 7,
  inConsult: 3,
};

describe('OPD capacity widget', () => {
  it(
    'shows the booked share as a ring with waiting, in consult and free, and passes axe',
    { timeout: 15_000 },
    async () => {
      capacity({ [TENANT_IDS.hospital]: HOSPITAL });
      signIn(USER_IDS.admin);
      renderApp();
      await home();
      const region = await screen.findByRole('region', { name: TITLE });
      expect(
        await within(region).findByRole('img', { name: 'Slots booked: 72%' }),
      ).toBeInTheDocument();
      expect(within(region).getByText('36 of 50 slots booked.')).toBeInTheDocument();
      const figure = (label: string) =>
        within(region).getByText(label).closest('p')?.querySelector('strong')?.textContent;
      expect(figure('Waiting')).toBe('7');
      expect(figure('In consult')).toBe('3');
      expect(figure('Free slots')).toBe('9');
      expect(within(region).getByRole('link', { name: 'Open appointments' })).toHaveAttribute(
        'href',
        '/appointments',
      );
      await expectNoAxeViolations(region);
    },
  );

  it('says nobody works today instead of showing 0%', async () => {
    capacity({ [TENANT_IDS.hospital]: { day: '2026-11-24', slots: 0, booked: 0, free: 0 } });
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    const region = await screen.findByRole('region', { name: TITLE });
    expect(
      await within(region).findByText('No doctor has working hours today.'),
    ).toBeInTheDocument();
    expect(within(region).queryByRole('img')).not.toBeInTheDocument();
  });

  it('leaves out the queue figures when the server gives none (queue off)', async () => {
    capacity({ [TENANT_IDS.hospital]: { day: '2026-11-24', slots: 20, booked: 5, free: 10 } });
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    const region = await screen.findByRole('region', { name: TITLE });
    expect(await within(region).findByText('Free slots')).toBeInTheDocument();
    expect(within(region).queryByText('Waiting')).not.toBeInTheDocument();
    expect(within(region).queryByText('In consult')).not.toBeInTheDocument();
  });

  it('says so in place when the request fails', async () => {
    server.use(
      http.get('*/api/appointments/capacity', () =>
        HttpResponse.json({ code: 'server_error' }, { status: 500 }),
      ),
    );
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    const region = await screen.findByRole('region', { name: TITLE });
    expect(await within(region).findByRole('alert')).toBeInTheDocument();
  });

  it('answers from the mock API with counts only', async () => {
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    const region = await screen.findByRole('region', { name: TITLE });
    // Weekday or weekend, the mock gives either a ring or the empty line.
    expect(
      await within(region).findByText(/slots booked\.|No doctor has working hours today\./),
    ).toBeInTheDocument();
  });

  it('gives another hospital its own figures', async () => {
    capacity({
      [TENANT_IDS.hospital]: HOSPITAL,
      [TENANT_IDS.clinic]: {
        day: '2026-11-24',
        slots: 12,
        booked: 3,
        free: 6,
        waiting: 1,
        inConsult: 0,
      },
    });
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    renderApp();
    await home();
    const region = await screen.findByRole('region', { name: TITLE });
    expect(
      await within(region).findByRole('img', { name: 'Slots booked: 25%' }),
    ).toBeInTheDocument();
  });

  it('is left out without appointment:read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'appointment:read');
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    // Another widget has come, so this one would have too.
    expect(await screen.findByRole('region', { name: 'Bed capacity' })).toBeInTheDocument();
    expect(tile()).not.toBeInTheDocument();
  });

  it('is left out when the appointments module is off for the hospital', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'appointments', false);
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    // Another widget has come, so this one would have too.
    expect(await screen.findByRole('region', { name: 'Bed capacity' })).toBeInTheDocument();
    expect(tile()).not.toBeInTheDocument();
  });
});
