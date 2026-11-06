import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { editMockAdultPulse, mockRangeTable } from '@/mocks/handlers/triage';
import { api } from '@/shared/api';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const HEADING = { name: 'Normal ranges for vital signs', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };

const open = async () => {
  const app = renderApp({ entry: '/triage/ranges' });
  await screen.findByRole('heading', HEADING);
  await screen.findByRole('group', { name: 'Adult (18 years and over)' });
  return app;
};

/** The low or high field of a measure in a band, found by the groups it sits in. */
const limit = (band: RegExp, measure: RegExp, which: 'Low: below' | 'High: above') => {
  const bandGroup = screen.getByRole('group', { name: band });
  return within(within(bandGroup).getByRole('group', { name: measure })).getByRole('textbox', {
    name: which,
  });
};

const ADULT = /^Adult/;
const PULSE = /^Pulse/;

describe('editing the ranges', () => {
  it('shows every age band with the ranges that apply, and saves a change', async () => {
    await open();
    expect(screen.getByRole('group', { name: 'Infant (under 1 year)' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Child (1 to 11 years)' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Adolescent (12 to 17 years)' })).toBeInTheDocument();
    expect(limit(ADULT, PULSE, 'Low: below')).toHaveValue('60');
    expect(limit(ADULT, PULSE, 'High: above')).toHaveValue('100');
    expect(limit(/^Infant/, PULSE, 'High: above')).toHaveValue('160');

    await userEvent.clear(limit(ADULT, PULSE, 'High: above'));
    await userEvent.type(limit(ADULT, PULSE, 'High: above'), '110');
    await userEvent.click(screen.getByRole('button', { name: 'Save ranges' }));

    const saved = 'Ranges saved. They apply to readings recorded from now on.';
    expect(await screen.findByText(saved)).toHaveAttribute('role', 'status');
    const table = mockRangeTable(HOSPITAL);
    expect(table.version).toBe(1);
    expect(table.bands.adult.pulse).toEqual({ low: 60, high: 110 });
    // The other bands are saved as they were shown.
    expect(table.bands.infant.pulse).toEqual({ low: 100, high: 160 });
    await expectNoAxeViolations();
  });

  it('leaves a measure unchecked when both its limits are emptied', async () => {
    await open();
    await userEvent.clear(limit(ADULT, /^Oxygen/, 'Low: below'));
    await userEvent.click(screen.getByRole('button', { name: 'Save ranges' }));
    await screen.findByText(/^Ranges saved/);
    expect(mockRangeTable(HOSPITAL).bands.adult.spo2).toBeUndefined();
  });

  it('refuses a high limit that is not above the low one, and sends nothing', async () => {
    await open();
    await userEvent.clear(limit(ADULT, PULSE, 'High: above'));
    await userEvent.type(limit(ADULT, PULSE, 'High: above'), '50');
    await userEvent.click(screen.getByRole('button', { name: 'Save ranges' }));
    expect(await screen.findByText('The high limit must be above the low limit.')).toBeVisible();
    expect(limit(ADULT, PULSE, 'High: above')).toHaveFocus();
    expect(mockRangeTable(HOSPITAL).version).toBe(0);
  });

  it('refuses a limit that is not a number with a point', async () => {
    await open();
    await userEvent.clear(limit(ADULT, PULSE, 'Low: below'));
    await userEvent.type(limit(ADULT, PULSE, 'Low: below'), '37,5');
    await userEvent.click(screen.getByRole('button', { name: 'Save ranges' }));
    expect(
      await screen.findByText(
        'Enter a number from 0 to 999.9, with at most one decimal, or leave it empty.',
      ),
    ).toBeVisible();
    expect(mockRangeTable(HOSPITAL).version).toBe(0);
  });

  it('keeps what was typed when someone saved first, and replaces theirs on the next save', async () => {
    await open();
    await userEvent.clear(limit(ADULT, PULSE, 'High: above'));
    await userEvent.type(limit(ADULT, PULSE, 'High: above'), '115');
    editMockAdultPulse(HOSPITAL, { low: 55, high: 105 });

    await userEvent.click(screen.getByRole('button', { name: 'Save ranges' }));
    expect(
      await screen.findByText(/^Someone else changed the ranges first\. What you typed is kept/),
    ).toBeInTheDocument();
    expect(limit(ADULT, PULSE, 'High: above')).toHaveValue('115');
    // Nothing of the form was saved, and theirs is still what applies.
    expect(mockRangeTable(HOSPITAL).bands.adult.pulse).toEqual({ low: 55, high: 105 });

    await userEvent.click(screen.getByRole('button', { name: 'Save ranges' }));
    await screen.findByText(/^Ranges saved/);
    expect(mockRangeTable(HOSPITAL).bands.adult.pulse).toEqual({ low: 60, high: 115 });
    expect(mockRangeTable(HOSPITAL).version).toBe(2);
  });

  it('keeps each hospital’s ranges apart', async () => {
    // The doctor works at both hospitals; at the clinic they are given the permission.
    grantPermission(CLINIC, 'doctor', 'vitals:configure');
    signIn(USER_IDS.doctor, CLINIC);
    await open();
    // The clinic marks a temperature high a little sooner.
    expect(limit(ADULT, /^Temperature/, 'High: above')).toHaveValue('37.5');
    await userEvent.clear(limit(ADULT, PULSE, 'High: above'));
    await userEvent.type(limit(ADULT, PULSE, 'High: above'), '90');
    await userEvent.click(screen.getByRole('button', { name: 'Save ranges' }));
    await screen.findByText(/^Ranges saved/);
    expect(mockRangeTable(CLINIC).bands.adult.pulse).toEqual({ low: 60, high: 90 });
    expect(mockRangeTable(HOSPITAL).bands.adult.pulse).toEqual({ low: 60, high: 100 });
  });

  it('leaves the marks of readings already recorded as they were', async () => {
    // pth_00001's newer reading has a pulse of 108: high against a limit of 100.
    const loosened = mockRangeTable(HOSPITAL);
    await api.PUT('/vitals/ranges', {
      body: {
        version: loosened.version,
        bands: { ...loosened.bands, adult: { ...loosened.bands.adult, pulse: { high: 200 } } },
      },
    });
    renderApp({ entry: '/patients/pth_00001?tab=vitals' });
    expect(await screen.findByText('2 readings')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Vitals readings' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getAllByText('High')).toHaveLength(2);
  });
});

describe('who may edit the ranges', () => {
  it('refuses the screen without vitals:configure, and leaves the navigation without it', async () => {
    revokePermission(HOSPITAL, 'admin', 'vitals:configure');
    renderApp({ entry: '/triage/ranges' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('refuses the screen with the module off', async () => {
    setTenantFeature(HOSPITAL, 'triage', false);
    renderApp({ entry: '/triage/ranges' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is reached from the navigation by whoever may configure it', async () => {
    renderApp({ entry: '/' });
    const link = await screen.findByRole('link', { name: 'Triage' });
    expect(link).toHaveAttribute('href', '/triage/ranges');
    await userEvent.click(link);
    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });

  it('says when the ranges cannot be loaded, and loads them again on request', async () => {
    const { server } = await import('@/mocks/node');
    const { http, HttpResponse } = await import('msw');
    server.use(
      http.get('*/api/vitals/ranges', () => HttpResponse.json({}, { status: 500 }), {
        once: true,
      }),
    );
    renderApp({ entry: '/triage/ranges' });
    expect(await screen.findByText('The ranges could not be loaded.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Adult (18 years and over)' })).toBeInTheDocument(),
    );
  });
});
