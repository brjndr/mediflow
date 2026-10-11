import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { revokePermission, setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { createRegistry, type FeatureManifest, type SlotProps } from '@/registry';
import { renderApp } from '@/test/render';
import { DetailTab, patientsFeature } from '.';

/** The first synthetic patient of the hospital, and of the clinic. */
const HOSPITAL_PATIENT = 'pth_00001';
const CLINIC_PATIENT = 'ptc_00001';
const NAME = { name: 'Asha Verma1' };
const NOT_FOUND = { name: 'Patient not found' };
const NO_ACCESS = { name: 'You do not have access to this page' };

const open = (id = HOSPITAL_PATIENT, query = '') => renderApp({ entry: `/patients/${id}${query}` });
const tabs = () =>
  within(screen.getByRole('tablist', { name: 'Patient record' })).getAllByRole('tab');
const panel = () => screen.getByRole('tabpanel');

/** Counts the reads of a record, which are what the server audits. */
function watchReads() {
  const ids: string[] = [];
  server.use(
    http.get('*/api/patients/:id', ({ params }) => {
      ids.push(String(params.id));
      return undefined;
    }),
  );
  return ids;
}

describe('the patient screen', () => {
  it('shows who the patient is, and the registration details in the first tab', async () => {
    open();

    expect(await screen.findByRole('heading', NAME)).toBeInTheDocument();
    // The record itself shows the MRN in full: it is masked in lists only.
    expect(screen.getByText('MRN-PTH-00001')).toBeInTheDocument();
    expect(screen.getByText(/1 Jan 1950 \(\d+ years\)/)).toBeInTheDocument();
    expect(screen.getByText('Female')).toBeInTheDocument();

    expect(tabs().map((tab) => tab.textContent)).toEqual(['Details']);
    expect(tabs()[0]).toHaveAttribute('aria-selected', 'true');
    expect(within(panel()).getByText('+91 98000 10000')).toBeInTheDocument();
    expect(within(panel()).getByText('patient1@example.test')).toBeInTheDocument();
    expect(within(panel()).getByText('1 Sample Street')).toBeInTheDocument();
    expect(within(panel()).getByText(/^Agreed, recorded /)).toBeInTheDocument();
  });

  it('is opened from the name in the list', async () => {
    renderApp({ entry: '/patients' });

    await userEvent.click(await screen.findByRole('link', NAME));

    expect(await screen.findByRole('heading', NAME)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the patient list' })).toHaveAttribute(
      'href',
      '/patients',
    );
  });

  it('reads the record from the server once on opening, which is what gets audited', async () => {
    const reads = watchReads();
    open();
    await screen.findByRole('heading', NAME);

    expect(reads).toEqual([HOSPITAL_PATIENT]);
  });

  it('says so when contact details are not part of the role, instead of showing them as missing', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'patient.contact:read');
    open();
    await screen.findByRole('heading', NAME);

    expect(within(panel()).getByText('•••••••••0000')).toBeInTheDocument();
    expect(within(panel()).getAllByText('Your role does not include contact details')).toHaveLength(
      2,
    );
    expect(document.body.textContent).not.toContain('example.test');
    expect(document.body.textContent).not.toContain('98000 10000');
  });

  it('gives one answer for a patient that does not exist and one in another hospital', async () => {
    const first = open('pth_99999');
    expect(await screen.findByRole('heading', NOT_FOUND)).toBeInTheDocument();
    first.unmount();

    // The admin works at the hospital. This id is a clinic patient's.
    open(CLINIC_PATIENT);
    expect(await screen.findByRole('heading', NOT_FOUND)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('MRN-PTC');
  });

  it('offers to try again when the record cannot be loaded', async () => {
    let failing = true;
    server.use(
      http.get('*/api/patients/:id', () => {
        if (!failing) return undefined;
        return HttpResponse.json(
          { error: { code: 'internal_error', message: 'boom', requestId: 'req_mock' } },
          { status: 500 },
        );
      }),
    );
    open();

    // After its own second try, the screen says so and waits to be asked.
    const retry = await screen.findByRole('button', { name: 'Try again' }, { timeout: 4000 });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the patient');
    failing = false;
    await userEvent.click(retry);

    expect(await screen.findByRole('heading', NAME)).toBeInTheDocument();
  });

  it('keeps the record on screen when a refresh in the background fails', async () => {
    const { queryClient } = open();
    await screen.findByRole('heading', NAME);
    server.use(
      http.get('*/api/patients/:id', () =>
        HttpResponse.json(
          { error: { code: 'internal_error', message: 'boom', requestId: 'req_mock' } },
          { status: 500 },
        ),
      ),
    );

    await act(() => queryClient.refetchQueries({ queryKey: ['tenant'] }));

    expect(screen.getByRole('heading', NAME)).toBeInTheDocument();
    expect(within(panel()).getByText('patient1@example.test')).toBeInTheDocument();
    expect(screen.queryByText('Could not load the patient')).not.toBeInTheDocument();
  });

  it('is closed to a role without patient:read, and in a hospital with the module off', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'patient:read');
    const reads = watchReads();
    const first = open();
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    first.unmount();

    signIn(USER_IDS.admin, TENANT_IDS.hospital);
    setTenantFeature(TENANT_IDS.hospital, 'patients', false);
    open();
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    // A closed screen asks the server for nothing.
    expect(reads).toEqual([]);
  });

  it('keeps a record to its own hospital: the same address at the clinic shows nothing of it', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const atHospital = open();
    expect(await screen.findByRole('heading', NAME)).toBeInTheDocument();
    atHospital.unmount();

    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    open();

    expect(await screen.findByRole('heading', NOT_FOUND)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Asha Verma1');
  });
});

/**
 * Another feature, as it would be written in its own folder: a tab and a button on the patient
 * screen, contributed through its manifest. Nothing in the patients feature names it.
 */
function VisitsTab({ context }: SlotProps) {
  return (
    <DetailTab id="visits" title="Visits">
      <p>Visits of {String(context?.patientId)}</p>
    </DetailTab>
  );
}
function BookVisit({ context }: SlotProps) {
  return <button type="button">Book a visit for {String(context?.patientId)}</button>;
}
const visitsFeature: FeatureManifest = {
  id: 'visits',
  titleKey: 'title',
  i18n: { titles: { en: { title: 'Visits' } }, load: () => Promise.resolve({ default: {} }) },
  featureFlag: 'laboratory',
  routes: [],
  permissions: ['clinical:read'],
  extensions: [
    {
      slot: 'patient.detail.tabs',
      component: () => Promise.resolve({ default: VisitsTab }),
      requires: ['clinical:read'],
    },
    {
      slot: 'patient.detail.actions',
      component: () => Promise.resolve({ default: BookVisit }),
      requires: ['clinical:read'],
    },
  ],
};
const registry = createRegistry([patientsFeature, visitsFeature]);
const openWithVisits = (query = '') =>
  renderApp({ entry: `/patients/${HOSPITAL_PATIENT}${query}`, registry });

describe('a link to a patient', () => {
  it('opens the record at its own hospital for someone who works there', async () => {
    // The doctor works at both hospitals and has neither open.
    signIn(USER_IDS.doctor);
    const { router } = renderApp({ entry: `/open/patient/${CLINIC_PATIENT}` });

    expect(await screen.findByText('MRN-PTC-00001')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/patients/${CLINIC_PATIENT}`);
  });

  it('shows nothing of a patient at a hospital the user does not work at', async () => {
    renderApp({ entry: `/open/patient/${CLINIC_PATIENT}` });

    expect(
      await screen.findByRole('heading', { name: 'This link is not available' }),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('MRN-PTC');
  });
});

describe('what other features add to the patient screen', () => {
  it('lets a feature add a tab and an action without this module knowing about it', async () => {
    const { router } = openWithVisits();
    await screen.findByRole('heading', NAME);

    // Given the patient's id, and nothing else of the record.
    expect(
      await screen.findByRole('button', { name: `Book a visit for ${HOSPITAL_PATIENT}` }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(tabs().map((tab) => tab.textContent)).toEqual(['Details', 'Visits']),
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Visits' }));

    expect(within(panel()).getByText(`Visits of ${HOSPITAL_PATIENT}`)).toBeInTheDocument();
    expect(screen.queryByText('patient1@example.test')).not.toBeInTheDocument();
    // The open tab is in the address: its id only.
    expect(router.state.location.search).toBe('?tab=visits');
  });

  it('opens the tab named in the address, and the first tab for a name it does not know', async () => {
    const linked = openWithVisits('?tab=visits');
    expect(await screen.findByText(`Visits of ${HOSPITAL_PATIENT}`)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Visits' })).toHaveAttribute('aria-selected', 'true');
    linked.unmount();

    openWithVisits('?tab=no-such-tab');
    await screen.findByRole('heading', NAME);
    // Waited for a moment, in case it is a tab still loading, then the first tab opens.
    await waitFor(
      () =>
        expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute(
          'aria-selected',
          'true',
        ),
      { timeout: 4000 },
    );
    expect(within(panel()).getByText('patient1@example.test')).toBeInTheDocument();
  });

  it('moves between tabs with the arrow keys', async () => {
    openWithVisits();
    await screen.findByRole('tab', { name: 'Visits' });

    screen.getByRole('tab', { name: 'Details' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Visits' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Visits' })).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Visits' })).toHaveFocus();
  });

  it('lists tabs in registry order whichever feature loads first, and keeps the order when a title changes', async () => {
    // Two contributed tabs. The one that comes first in the registry is the slower to load.
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    let setTitle: (title: string) => void = () => {};
    function SlowTab() {
      const [title, set] = useState('Slow');
      // Handed to the test once mounted, so it can change the title from outside.
      useEffect(() => {
        setTitle = set;
      }, []);
      return (
        <DetailTab id="slow" title={title}>
          <p>Slow content</p>
        </DetailTab>
      );
    }
    function FastTab() {
      return (
        <DetailTab id="fast" title="Fast">
          <p>Fast content</p>
        </DetailTab>
      );
    }
    const two: FeatureManifest = {
      ...visitsFeature,
      id: 'two_tabs',
      extensions: [
        {
          slot: 'patient.detail.tabs',
          component: () => slow.then(() => ({ default: SlowTab })),
          order: 1,
        },
        {
          slot: 'patient.detail.tabs',
          component: () => Promise.resolve({ default: FastTab }),
          order: 2,
        },
      ],
    };
    renderApp({
      entry: `/patients/${HOSPITAL_PATIENT}`,
      registry: createRegistry([patientsFeature, two]),
    });
    await screen.findByRole('tab', { name: 'Fast' });
    expect(tabs().map((tab) => tab.textContent)).toEqual(['Details', 'Fast']);

    await act(async () => {
      release();
      await slow;
    });

    await waitFor(() =>
      expect(tabs().map((tab) => tab.textContent)).toEqual(['Details', 'Slow', 'Fast']),
    );
    // A title that arrives later (translations loading, a change of language) moves nothing.
    act(() => setTitle('Slow, renamed'));
    expect(tabs().map((tab) => tab.textContent)).toEqual(['Details', 'Slow, renamed', 'Fast']);
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps the screen and its own tab when a contribution breaks', async () => {
    function Broken(): never {
      throw new Error('contribution failed');
    }
    const broken: FeatureManifest = {
      ...visitsFeature,
      id: 'broken_tab',
      extensions: [
        { slot: 'patient.detail.tabs', component: () => Promise.resolve({ default: Broken }) },
        {
          slot: 'patient.detail.tabs',
          component: () => Promise.reject(new Error('chunk failed to load')),
        },
      ],
    };
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderApp({
        entry: `/patients/${HOSPITAL_PATIENT}`,
        registry: createRegistry([patientsFeature, broken]),
      });

      expect(await screen.findByRole('heading', NAME)).toBeInTheDocument();
      expect(within(panel()).getByText('patient1@example.test')).toBeInTheDocument();
      expect(tabs().map((tab) => tab.textContent)).toEqual(['Details']);
    } finally {
      quiet.mockRestore();
    }
  });

  it('leaves out a contribution the user may not see, or whose module is off', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'clinical:read');
    const first = openWithVisits('?tab=visits');
    await screen.findByRole('heading', NAME);
    expect(tabs().map((tab) => tab.textContent)).toEqual(['Details']);
    expect(screen.queryByRole('button', { name: /^Book a visit/ })).not.toBeInTheDocument();
    first.unmount();

    signIn(USER_IDS.admin, TENANT_IDS.hospital);
    setTenantFeature(TENANT_IDS.hospital, 'laboratory', false);
    openWithVisits();
    await screen.findByRole('heading', NAME);
    expect(tabs().map((tab) => tab.textContent)).toEqual(['Details']);
  });
});
