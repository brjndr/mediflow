import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revokePermission, setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { editMockLabRanges, editMockLabTest } from '@/mocks/handlers/lab-tests';
import { server } from '@/mocks/node';
import { api } from '@/shared/api';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { labTestKeys } from './hooks/use-lab-tests';
import { blankRangeRow, rangesOverlap, toRange, toRangeRow } from './schemas';

const HEADING = { name: 'Lab tests', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };
/** Haemoglobin: read by age and sex, and one of the tests of the complete blood count. */
const HB = 'lab_h_hb';
/** A numeric test with no reference ranges yet, in no panel. */
const ESR = 'lab_h_esr';
const CBC = 'lab_h_cbc';

const openList = async () => {
  const app = renderApp({ entry: '/lab-tests' });
  await screen.findByRole('link', { name: 'Albumin' });
  return app;
};
const openTest = async (id = HB) => {
  const app = renderApp({ entry: `/lab-tests/${id}` });
  await screen.findByRole('heading', { name: 'Details' });
  return app;
};
const openRanges = async (id = HB) => {
  const app = await openTest(id);
  await screen.findByRole('button', { name: 'Edit ranges' });
  return app;
};
const openCreate = async () => {
  const app = renderApp({ entry: '/lab-tests/new' });
  await screen.findByRole('heading', { name: 'Add a test' });
  return app;
};
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const statuses = () => screen.getAllByRole('status').map((status) => status.textContent);
const textbox = (name: RegExp) => screen.getByRole('textbox', { name });
const choose = (name: RegExp, option: string) =>
  userEvent.selectOptions(screen.getByRole('combobox', { name }), option);
const search = (text: string) =>
  userEvent.type(screen.getByRole('searchbox', { name: 'Search lab tests' }), text);
const range = (number: number) => within(screen.getByRole('group', { name: `Range ${number}` }));

async function type(name: RegExp, text: string) {
  await userEvent.clear(textbox(name));
  if (text) await userEvent.type(textbox(name), text);
}

/** Types into a field of one row of the ranges form. */
async function typeIn(row: number, name: RegExp, text: string) {
  const field = range(row).getByRole('textbox', { name });
  await userEvent.clear(field);
  if (text) await userEvent.type(field, text);
}

/** Fills the add form with a numeric test. */
async function fill(code: string, name: string) {
  await type(/^Code/, code);
  await type(/^Name/, name);
  await choose(/^Section/, 'Biochemistry');
  await choose(/^Result is/, 'A number');
  await choose(/^Sample/, 'Serum');
  await type(/^Turnaround/, '6');
}

/** Adds a test to the panel being filled in, found by a word of its name. */
async function addToPanel(word: string, option: string) {
  const find = screen.getByRole('searchbox', { name: 'Find a test to add' });
  await userEvent.clear(find);
  await userEvent.type(find, word);
  await screen.findByRole('option', { name: option });
  await choose(/^Test to add/, option);
  await userEvent.click(button('Add to the panel'));
}

/** Asks which range a patient would be read against, and gives the answer. */
async function check(age: string, unit: string, sex: string) {
  await type(/^Age/, age);
  await choose(/^Age in/, unit);
  await choose(/^Sex/, sex);
  await userEvent.click(button('Find the range'));
}

/** The bodies of the requests of a method, as they were sent. */
function sent(method: string): unknown[] {
  const bodies: unknown[] = [];
  server.events.on('request:start', ({ request }) => {
    // A search is a POST too, and is not what these tests look at.
    if (request.method === method && !request.url.endsWith('/search'))
      void request
        .clone()
        .json()
        .then((body) => bodies.push(body));
  });
  return bodies;
}

afterEach(() => {
  vi.unstubAllGlobals();
  server.events.removeAllListeners();
});

describe('the catalog', () => {
  it('lists the tests and panels a page at a time, by name', async () => {
    await openList();

    expect(screen.getByRole('heading', HEADING)).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('47 tests'));
    expect(screen.getByRole('link', { name: 'Lipid profile' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Liver function test' })).not.toBeInTheDocument();
    // How it is collected, how long it takes, and what it is charged as.
    expect(screen.getAllByText('Whole blood · EDTA tube').length).toBeGreaterThan(0);
    expect(screen.getAllByText('4 hours').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Complete blood count')).toHaveLength(2);

    await userEvent.click(button('Load more'));
    expect(await screen.findByRole('link', { name: 'Liver function test' })).toBeInTheDocument();
  });

  it('is reached from the navigation', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('link', { name: 'Lab tests' }));

    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });

  it('searches the code and the name on the server', async () => {
    await openList();
    await search('gluc');
    await waitFor(() => expect(statuses()).toContain('2 tests'));
    expect(screen.getByRole('link', { name: 'Glucose, fasting' })).toBeInTheDocument();

    await userEvent.clear(screen.getByRole('searchbox'));
    await search('tsh');
    await waitFor(() => expect(statuses()).toContain('1 test'));
    expect(screen.getByRole('link', { name: 'Thyroid stimulating hormone' })).toBeInTheDocument();

    await userEvent.clear(screen.getByRole('searchbox'));
    await search('nothing like this');
    expect(await screen.findByText('No test matches these filters.')).toBeInTheDocument();
  });

  it('narrows by section and to panels', async () => {
    await openList();
    await choose(/^Section/, 'Haematology');
    await waitFor(() => expect(statuses()).toContain('9 tests'));

    await choose(/^Kind/, 'Panel');
    await waitFor(() => expect(statuses()).toContain('1 test'));
    expect(screen.getByRole('link', { name: 'Complete blood count' })).toBeInTheDocument();

    await choose(/^Section/, 'All sections');
    await waitFor(() => expect(statuses()).toContain('5 tests'));
  });

  it('shows the archived tests only when asked', async () => {
    await openList();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show archived tests' }));

    expect(
      await screen.findByRole('link', { name: 'Bleeding time, old method' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('1 archived test'));
  });
});

describe('adding a test', () => {
  it('adds a numeric test linked to a service of the price catalog, and opens it', async () => {
    const bodies = sent('POST');
    const { router } = await openCreate();
    await fill('MG', 'Magnesium');
    await type(/^Unit/, 'mg/dL');
    await type(/^Container/, 'Plain tube');
    await screen.findByRole('option', { name: 'Urine routine (LAB-007)' });
    await choose(/^Charged as/, 'Urine routine (LAB-007)');
    await userEvent.click(button('Add test'));

    expect(await screen.findByRole('heading', { name: 'Magnesium' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/lab-tests/lab_new_1');
    expect(screen.getByText('MG · Biochemistry')).toBeInTheDocument();
    expect(screen.getByText('Urine routine')).toBeInTheDocument();
    expect(screen.getByText('6 hours')).toBeInTheDocument();
    // A new test has no ranges until they are set.
    expect(
      await screen.findByText('No reference ranges yet. Results are reported without one.'),
    ).toBeInTheDocument();
    expect(bodies).toEqual([
      {
        code: 'MG',
        name: 'Magnesium',
        department: 'biochemistry',
        kind: 'test',
        resultType: 'numeric',
        unit: 'mg/dL',
        sampleType: 'serum',
        container: 'Plain tube',
        turnaroundHours: 6,
        serviceId: 'svc_h_23',
      },
    ]);
  });

  it('finds a service that is not among the first offered by a word of its name', async () => {
    await openCreate();
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Find a laboratory service' }),
      'thyroid',
    );

    expect(await screen.findByRole('option', { name: 'Thyroid profile (LAB-006)' })).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: /Urine routine/ })).not.toBeInTheDocument(),
    );
    // Only laboratory services are offered.
    expect(screen.queryByRole('option', { name: /ECG/ })).not.toBeInTheDocument();
  });

  it('keeps the service picker when a search for services fails, with a way to ask again', async () => {
    await openCreate();
    await screen.findByRole('option', { name: 'Urine routine (LAB-007)' });
    server.use(
      http.post('*/api/services/search', () => new HttpResponse(null, { status: 500 }), {
        once: true,
      }),
    );
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Find a laboratory service' }),
      'thyroid',
    );

    expect(await screen.findByText('The services could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /^Charged as/ })).toBeInTheDocument();
    await userEvent.click(button('Try again'));
    expect(
      await screen.findByRole('option', { name: 'Thyroid profile (LAB-006)' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('The services could not be loaded.')).not.toBeInTheDocument(),
    );
  });

  it('adds a test whose result is text, which has no unit and no ranges', async () => {
    await openCreate();
    await fill('VDRL', 'VDRL test');
    await choose(/^Result is/, 'Text');
    expect(screen.queryByRole('textbox', { name: /^Unit/ })).not.toBeInTheDocument();
    await userEvent.click(button('Add test'));

    expect(await screen.findByRole('heading', { name: 'VDRL test' })).toBeInTheDocument();
    expect(screen.getByText('Text')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Reference ranges' })).not.toBeInTheDocument();
  });

  it('needs a code, a name, a section, a result type, a sample and a turnaround time', async () => {
    const bodies = sent('POST');
    await openCreate();
    await userEvent.click(button('Add test'));
    expect(await screen.findAllByText('This field is required.')).toHaveLength(6);

    await fill('not a code', 'Magnesium');
    await type(/^Turnaround/, '0');
    await userEvent.click(button('Add test'));
    await waitFor(() => expect(textbox(/^Code/)).toHaveAttribute('aria-invalid', 'true'));
    expect(textbox(/^Turnaround/)).toHaveAttribute('aria-invalid', 'true');
    expect(bodies).toEqual([]);
  });

  it('says so when the hospital already has a test with that code, and keeps what was typed', async () => {
    await openCreate();
    await fill('hb', 'Haemoglobin again');
    await userEvent.click(button('Add test'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This hospital already has a test with that code. It may be archived.',
    );
    expect(textbox(/^Name/)).toHaveValue('Haemoglobin again');
  });

  it('adds a panel made of tests, in the order they are reported', async () => {
    await openCreate();
    await type(/^Code/, 'LYTES');
    await type(/^Name/, 'Electrolytes');
    await choose(/^Kind/, 'Panel');
    // A panel has no result of its own.
    expect(screen.queryByRole('combobox', { name: /^Result is/ })).not.toBeInTheDocument();
    await choose(/^Section/, 'Biochemistry');
    await choose(/^Sample/, 'Serum');
    await type(/^Turnaround/, '6');

    // Without a test it is not a panel, and the picker says it is required.
    const picker = screen.getByRole('group', { name: 'Tests in this panel (required)' });
    await userEvent.click(button('Add test'));
    expect(await within(picker).findByRole('alert')).toHaveTextContent('This field is required.');
    // A failed save focuses the first thing to fix: with no test listed, the search.
    await waitFor(() =>
      expect(screen.getByRole('searchbox', { name: 'Find a test to add' })).toHaveFocus(),
    );

    await addToPanel('sod', 'Sodium (NA)');
    await addToPanel('pot', 'Potassium (K)');
    await addToPanel('chlor', 'Chloride (CL)');
    // A test already in the panel is not offered again.
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Find a test to add' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a test to add' }), 'sod');
    expect(await screen.findByRole('option', { name: 'No test matches' })).toBeInTheDocument();
    await userEvent.click(button('Move Potassium up'));
    await userEvent.click(button('Remove Chloride'));
    // Its button went with it: the keyboard is on the next remove button there is.
    expect(button('Remove Sodium')).toHaveFocus();
    await userEvent.click(button('Add test'));

    expect(await screen.findByRole('heading', { name: 'Electrolytes' })).toBeInTheDocument();
    const parts = within(screen.getByRole('list', { name: 'Tests in this panel' })).getAllByRole(
      'listitem',
    );
    expect(parts.map((part) => part.textContent)).toEqual(['Potassium · K', 'Sodium · NA']);
    // A panel is read through its tests: it has no ranges of its own.
    expect(screen.queryByRole('heading', { name: 'Reference ranges' })).not.toBeInTheDocument();
  });

  it('adds one test when the same request is sent twice', async () => {
    const body = {
      code: 'MG',
      name: 'Magnesium',
      department: 'biochemistry',
      kind: 'test',
      resultType: 'numeric',
      sampleType: 'serum',
      turnaroundHours: 6,
    } as const;
    const params = { header: { 'idempotency-key': 'test-key-0001' } };
    const first = await api.POST('/lab-tests', { body, params });
    const again = await api.POST('/lab-tests', { body, params });

    expect(again.data?.id).toBe(first.data?.id);
    expect(again.response.headers.get('idempotent-replayed')).toBe('true');
  });

  it('refuses a service that is not a laboratory service, and a panel of something that is not a test', async () => {
    const base = {
      code: 'X1',
      name: 'X',
      department: 'other',
      sampleType: 'blood',
      turnaroundHours: 1,
    } as const;
    const add = (body: object, key: string) =>
      api.POST('/lab-tests', {
        body: { ...base, ...body } as never,
        params: { header: { 'idempotency-key': key } },
      });

    // A consultation is in the price catalog, and is not what a test is charged as.
    await expect(
      add({ kind: 'test', resultType: 'text', serviceId: 'svc_h_01' }, 'test-key-0002'),
    ).rejects.toMatchObject({ serverCode: 'validation_failed' });
    // A panel is not made of panels, nor of archived tests, nor of nothing.
    for (const [index, componentIds] of [[CBC], ['lab_h_bt-old'], []].entries()) {
      await expect(
        add({ kind: 'panel', componentIds }, `test-key-001${index}`),
      ).rejects.toMatchObject({ serverCode: 'validation_failed' });
    }
  });
});

describe('a test', () => {
  it('shows how it is collected and read', async () => {
    await openTest();

    expect(screen.getByRole('heading', { name: 'Haemoglobin' })).toBeInTheDocument();
    expect(screen.getByText('HB · Haematology')).toBeInTheDocument();
    expect(screen.getByText('Single test')).toBeInTheDocument();
    expect(screen.getByText('A number')).toBeInTheDocument();
    expect(screen.getByText('g/dL')).toBeInTheDocument();
    expect(screen.getByText('Whole blood')).toBeInTheDocument();
    expect(screen.getByText('EDTA tube')).toBeInTheDocument();
    expect(screen.getByText('4 hours')).toBeInTheDocument();
  });

  it('shows a panel with its tests and the service it is charged as', async () => {
    await openTest(CBC);

    expect(screen.getByText('Panel', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Complete blood count', { selector: 'dd' })).toBeInTheDocument();
    const parts = within(screen.getByRole('list', { name: 'Tests in this panel' })).getAllByRole(
      'link',
    );
    expect(parts.map((part) => part.textContent)).toEqual([
      'Haemoglobin',
      'Total white cell count',
      'Platelet count',
      'Red cell count',
      'Haematocrit',
      'Mean cell volume',
    ]);
    expect(screen.queryByRole('heading', { name: 'Reference ranges' })).not.toBeInTheDocument();
  });

  it('sends only what was changed', async () => {
    const bodies = sent('PATCH');
    await openTest();
    await userEvent.click(button('Edit details'));
    await type(/^Container/, 'Lavender tube');
    await type(/^Turnaround/, '6');
    await userEvent.click(button('Save test'));

    await waitFor(() => expect(statuses()).toContain('The test was saved.'));
    expect(bodies).toEqual([
      { container: 'Lavender tube', turnaroundHours: 6, expectedVersion: 1 },
    ]);
    expect(await screen.findByText('Lavender tube')).toBeInTheDocument();
  });

  it('links a test to a service and takes the link away again', async () => {
    const bodies = sent('PATCH');
    await openTest();
    await userEvent.click(button('Edit details'));
    await screen.findByRole('option', { name: 'Complete blood count (LAB-001)' });
    await choose(/^Charged as/, 'Complete blood count (LAB-001)');
    await userEvent.click(button('Save test'));
    await waitFor(() => expect(statuses()).toContain('The test was saved.'));
    expect(screen.getByText('Complete blood count', { selector: 'dd' })).toBeInTheDocument();

    await userEvent.click(button('Edit details'));
    await choose(/^Charged as/, 'Not linked to a service');
    await userEvent.click(button('Save test'));
    await waitFor(() =>
      expect(screen.queryByText('Complete blood count', { selector: 'dd' })).toBeNull(),
    );
    expect(bodies).toEqual([
      { serviceId: 'svc_h_17', expectedVersion: 1 },
      { serviceId: '', expectedVersion: 2 },
    ]);
  });

  it('changes the tests of a panel', async () => {
    const bodies = sent('PATCH');
    await openTest(CBC);
    await userEvent.click(button('Edit details'));
    await userEvent.click(button('Remove Mean cell volume'));
    await addToPanel('sedim', 'Erythrocyte sedimentation rate (ESR)');
    await userEvent.click(button('Save test'));

    await waitFor(() => expect(statuses()).toContain('The test was saved.'));
    expect(bodies).toEqual([
      {
        componentIds: ['lab_h_hb', 'lab_h_wbc', 'lab_h_plt', 'lab_h_rbc', 'lab_h_hct', ESR],
        expectedVersion: 1,
      },
    ]);
    expect(
      await screen.findByRole('link', { name: 'Erythrocyte sedimentation rate' }),
    ).toBeInTheDocument();
  });

  it('keeps what was typed after a conflict, and shows what the other person saved in the same field', async () => {
    await openTest();
    await userEvent.click(button('Edit details'));
    // Someone else changes the container, and the section, meanwhile.
    editMockLabTest(HB, { container: 'Purple tube', department: 'biochemistry' });
    await type(/^Container/, 'Lavender tube');
    await userEvent.click(button('Save test'));

    expect(await screen.findByText(/Someone else changed this test/)).toBeInTheDocument();
    expect(textbox(/^Container/)).toHaveValue('Lavender tube');
    expect(await screen.findByText('Container: Purple tube')).toBeInTheDocument();
    // Their section is in the field this person did not touch.
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /^Section/ })).toHaveValue('biochemistry'),
    );

    await waitFor(() => expect(button('Save test')).toBeEnabled());
    await userEvent.click(button('Save test'));
    await waitFor(() => expect(statuses()).toContain('The test was saved.'));
    expect(await screen.findByText('Lavender tube')).toBeInTheDocument();
    expect(screen.getByText('HB · Biochemistry')).toBeInTheDocument();
  });

  it('does not make a test with reference ranges a text test', async () => {
    await openTest();
    await userEvent.click(button('Edit details'));
    await choose(/^Result is/, 'Text');
    await userEvent.click(button('Save test'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This test has reference ranges, which a text result cannot have. Remove the ranges first.',
    );
  });

  it('archives and restores a test that is in no panel', async () => {
    await openTest(ESR);
    await userEvent.click(button('Archive'));
    await waitFor(() =>
      expect(statuses()).toContain('Erythrocyte sedimentation rate was archived.'),
    );
    expect(await screen.findByText('Archived')).toBeInTheDocument();
    // The ranges of an archived test are not changed.
    expect(screen.queryByRole('button', { name: 'Edit ranges' })).not.toBeInTheDocument();

    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(statuses()).toContain('Erythrocyte sedimentation rate was restored.'),
    );
  });

  it('does not archive a test that a panel in use is made of', async () => {
    await openTest();
    await userEvent.click(button('Archive'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This test is part of a panel that is in use. Take it out of the panel first.',
    );
    expect(screen.queryByText('Archived')).not.toBeInTheDocument();
  });

  it('has one answer for a test that does not exist and one of another hospital', async () => {
    renderApp({ entry: '/lab-tests/lab_c_hb' });

    expect(await screen.findByRole('heading', { name: 'Test not found' })).toBeInTheDocument();
  });
});

describe('reference ranges', () => {
  it('shows what is normal by sex and age', async () => {
    await openRanges();

    expect(screen.getByText('Under 1 month')).toBeInTheDocument();
    expect(screen.getByText('14 to 22 g/dL')).toBeInTheDocument();
    expect(screen.getByText('9 or below')).toBeInTheDocument();
    expect(screen.getByText('1 month to under 12 years')).toBeInTheDocument();
    expect(screen.getAllByText('From 12 years')).toHaveLength(2);
    expect(screen.getByText('13 to 17 g/dL')).toBeInTheDocument();
    expect(screen.getByText('12 to 15 g/dL')).toBeInTheDocument();
    expect(screen.getAllByText('7 or below · 20 or above')).toHaveLength(2);
  });

  it('finds the range for a patient of an age and a sex', async () => {
    await openRanges();
    const answer = () => statuses().find((text) => /^(Range used|No range)/.test(text ?? ''));

    await check('30', 'years', 'Male');
    await waitFor(() =>
      expect(answer()).toBe(
        'Range used: Male, From 12 years. Normal: 13 to 17 g/dL. Critical: 7 or below · 20 or above.',
      ),
    );
    await check('30', 'years', 'Female');
    await waitFor(() => expect(answer()).toContain('Female, From 12 years. Normal: 12 to 15 g/dL'));
    // A child is read against the range for anyone of that age, whatever the sex.
    await check('8', 'years', 'Female');
    await waitFor(() =>
      expect(answer()).toContain('Anyone, 1 month to under 12 years. Normal: 11 to 14 g/dL'),
    );
    // The day a range ends belongs to the next one: 30 days is a month.
    await check('29', 'days', 'Male');
    await waitFor(() => expect(answer()).toContain('Anyone, Under 1 month'));
    await check('1', 'months', 'Male');
    await waitFor(() => expect(answer()).toContain('Anyone, 1 month to under 12 years'));
    // The adult ranges are for men and for women: there is none for anyone else.
    await check('30', 'years', 'Other');
    await waitFor(() =>
      expect(answer()).toBe(
        'No range covers a patient of this age and sex. The result would be reported without one.',
      ),
    );
  });

  it('does not ask for an age beyond the oldest a range can name, in any unit', async () => {
    let asked = 0;
    server.use(
      http.get('*/api/lab-tests/:id/ranges/resolve', () => {
        asked++;
        return undefined;
      }),
    );
    await openRanges();
    await check('200', 'years', 'Male');

    await waitFor(() => expect(textbox(/^Age/)).toHaveAttribute('aria-invalid', 'true'));
    expect(asked).toBe(0);
    // The same number of days is an age.
    await check('200', 'days', 'Male');
    await waitFor(() => expect(asked).toBe(1));
  });

  it('drops an answer once the age or sex it was for is changed', async () => {
    await openRanges();
    const answer = () => statuses().find((text) => /^(Range used|No range)/.test(text ?? ''));
    await check('30', 'years', 'Male');
    await waitFor(() => expect(answer()).toContain('Male, From 12 years'));

    await choose(/^Sex/, 'Female');
    await waitFor(() => expect(answer()).toBeUndefined());
  });

  it('takes a message away when what it was about is put right in another field or row', async () => {
    await openRanges(ESR);
    await userEvent.click(button('Edit ranges'));
    await userEvent.click(button('Add a range'));
    await userEvent.click(button('Add a range'));
    await typeIn(1, /^Highest normal/, '20');
    await typeIn(2, /^Highest normal/, '30');
    await userEvent.click(button('Save ranges'));
    // Both are for anyone from birth.
    expect(await range(2).findByRole('alert')).toHaveTextContent(
      /Another range for the same people already covers some of these ages/,
    );

    // Put right in the first row: the message on the second goes.
    await typeIn(1, /^Until age/, '12');
    await typeIn(2, /^From age/, '12');
    await waitFor(() => expect(range(2).queryByRole('alert')).not.toBeInTheDocument());

    // And a row that is removed takes its part in a clash with it.
    await typeIn(2, /^From age/, '5');
    expect(await range(2).findByRole('alert')).toBeInTheDocument();
    await userEvent.click(button('Remove range 1'));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('sets the first range of a test', async () => {
    const bodies = sent('PUT');
    await openRanges(ESR);
    expect(
      screen.getByText('No reference ranges yet. Results are reported without one.'),
    ).toBeInTheDocument();
    // Nothing to look up yet.
    expect(screen.queryByRole('button', { name: 'Find the range' })).not.toBeInTheDocument();

    await userEvent.click(button('Edit ranges'));
    await userEvent.click(button('Add a range'));
    await typeIn(1, /^Highest normal/, '20');
    await typeIn(1, /^Critical at or above/, '100');
    await typeIn(1, /^Note/, 'Westergren');
    await userEvent.click(button('Save ranges'));

    await waitFor(() => expect(statuses()).toContain('The reference ranges were saved.'));
    expect(bodies).toEqual([
      {
        ranges: [
          {
            sex: 'any',
            ageFrom: { value: 0, unit: 'years' },
            high: 20,
            criticalHigh: 100,
            note: 'Westergren',
          },
        ],
        expectedVersion: 1,
      },
    ]);
    expect(await screen.findByText('All ages')).toBeInTheDocument();
    expect(screen.getByText('20 mm/h or less')).toBeInTheDocument();
    expect(screen.getByText('100 or above')).toBeInTheDocument();
  });

  it('refuses a range that covers ages another range for the same people covers', async () => {
    const bodies = sent('PUT');
    await openRanges();
    await userEvent.click(button('Edit ranges'));
    await userEvent.click(button('Add a range'));
    // A boys' range from 5 years with no upper age runs into the men's range.
    await userEvent.selectOptions(range(5).getByRole('combobox', { name: /^For/ }), 'Male');
    await typeIn(5, /^From age/, '5');
    await typeIn(5, /^Lowest normal/, '11.5');
    await typeIn(5, /^Highest normal/, '15.5');
    await userEvent.click(button('Save ranges'));

    expect(await range(5).findByRole('alert')).toHaveTextContent(
      /Another range for the same people already covers some of these ages/,
    );
    expect(bodies).toEqual([]);

    // Up to 12 years it stops where the men's range starts.
    await typeIn(5, /^Until age/, '12');
    await userEvent.click(button('Save ranges'));
    await waitFor(() => expect(statuses()).toContain('The reference ranges were saved.'));
    expect(await screen.findByText('5 years to under 12 years')).toBeInTheDocument();

    // The boy is read against his own range, the girl of the same age against the one for anyone.
    await check('8', 'years', 'Male');
    await waitFor(() =>
      expect(statuses().join()).toContain(
        'Male, 5 years to under 12 years. Normal: 11.5 to 15.5 g/dL',
      ),
    );
    await check('8', 'years', 'Female');
    await waitFor(() => expect(statuses().join()).toContain('Anyone, 1 month to under 12 years'));
  });

  it('needs a limit, limits in order, critical values outside what is normal, and ages in order', async () => {
    const bodies = sent('PUT');
    await openRanges(ESR);
    await userEvent.click(button('Edit ranges'));
    await userEvent.click(button('Add a range'));
    await userEvent.click(button('Save ranges'));
    expect(await range(1).findByRole('alert')).toHaveTextContent(
      'Give a lowest or a highest normal value.',
    );

    await typeIn(1, /^Lowest normal/, '10');
    await typeIn(1, /^Highest normal/, '5');
    await userEvent.click(button('Save ranges'));
    expect(await range(1).findByText('This must be above the lowest normal value.')).toBeVisible();

    await typeIn(1, /^Highest normal/, '20');
    await typeIn(1, /^Critical at or below/, '12');
    await typeIn(1, /^Critical at or above/, '15');
    await typeIn(1, /^From age/, '5');
    await typeIn(1, /^Until age/, '5');
    await userEvent.click(button('Save ranges'));
    expect(
      await range(1).findByText('Give the lowest normal value, and make this below it.'),
    ).toBeVisible();
    expect(
      range(1).getByText('Give the highest normal value, and make this above it.'),
    ).toBeVisible();
    expect(
      range(1).getByText('This age must be later than the age the range starts from.'),
    ).toBeVisible();
    await expectNoAxeViolations();

    await typeIn(1, /^Lowest normal/, 'ten');
    await userEvent.click(button('Save ranges'));
    await waitFor(() =>
      expect(range(1).getByRole('textbox', { name: /^Lowest normal/ })).toHaveAttribute(
        'aria-invalid',
        'true',
      ),
    );
    expect(bodies).toEqual([]);
  });

  it('removes a range', async () => {
    const bodies = sent('PUT');
    await openRanges();
    await userEvent.click(button('Edit ranges'));
    // The rows are in the order of the ages: the newborn's range is the first.
    expect(range(1).getByRole('textbox', { name: /^Until age/ })).toHaveValue('1');
    await userEvent.click(button('Remove range 1'));
    expect(screen.queryByRole('group', { name: 'Range 4' })).not.toBeInTheDocument();
    // The row that moved up kept its own values.
    expect(range(1).getByRole('textbox', { name: /^Until age/ })).toHaveValue('12');
    await userEvent.click(button('Save ranges'));

    await waitFor(() => expect(statuses()).toContain('The reference ranges were saved.'));
    expect(screen.queryByText('Under 1 month')).not.toBeInTheDocument();
    expect((bodies[0] as { ranges: unknown[] }).ranges).toHaveLength(3);
  });

  it('keeps what was typed when someone else changed the ranges meanwhile, and saves it when asked again', async () => {
    await openRanges();
    await userEvent.click(button('Edit ranges'));
    editMockLabRanges(HB, [{ sex: 'any', ageFrom: { value: 0, unit: 'days' }, low: 1, high: 2 }]);
    await typeIn(3, /^Highest normal/, '18');
    await userEvent.click(button('Save ranges'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Someone else changed these ranges while you were editing/,
    );
    expect(range(3).getByRole('textbox', { name: /^Highest normal/ })).toHaveValue('18');

    await waitFor(() => expect(button('Save ranges')).toBeEnabled());
    await userEvent.click(button('Save ranges'));
    await waitFor(() => expect(statuses()).toContain('The reference ranges were saved.'));
    expect(await screen.findByText('13 to 18 g/dL')).toBeInTheDocument();
  });

  it('is refused by the server for a panel and for a text test', async () => {
    for (const labTestId of [CBC, 'lab_h_hiv']) {
      await expect(
        api.PUT('/lab-tests/{labTestId}/ranges', {
          params: { path: { labTestId } },
          body: {
            ranges: [{ sex: 'any', ageFrom: { value: 0, unit: 'days' }, low: 1 }],
            expectedVersion: 1,
          },
        }),
      ).rejects.toMatchObject({ serverCode: 'lab_test_has_no_ranges' });
    }
    // And the server checks what the form checks.
    const put = (ranges: object[]) =>
      api.PUT('/lab-tests/{labTestId}/ranges', {
        params: { path: { labTestId: ESR } },
        body: { ranges: ranges as never, expectedVersion: 1 },
      });
    const birth = { value: 0, unit: 'days' };
    const age = (value: number, unit: string) => ({ value, unit });
    for (const ranges of [
      [{ sex: 'any', ageFrom: birth }],
      [{ sex: 'any', ageFrom: birth, low: 5, high: 5 }],
      [{ sex: 'any', ageFrom: birth, low: 5, criticalLow: 6 }],
      // A critical limit needs the normal limit on its side, and lies strictly beyond it (#310).
      [{ sex: 'any', ageFrom: birth, high: 5, criticalLow: 4 }],
      [{ sex: 'any', ageFrom: birth, low: 5, high: 9, criticalLow: 5 }],
      [{ sex: 'any', ageFrom: birth, low: 5, high: 9, criticalHigh: 9 }],
      // An age is a whole value with a known unit, of at most 150 years.
      [{ sex: 'any', ageFrom: 0, low: 1 }],
      [{ sex: 'any', ageFrom: age(1, 'decades'), low: 1 }],
      [{ sex: 'any', ageFrom: age(1.5, 'years'), low: 1 }],
      [{ sex: 'any', ageFrom: age(151, 'years'), low: 1 }],
      // It ends later than it starts, for every date of birth.
      [{ sex: 'any', ageFrom: age(10, 'days'), ageUntil: age(10, 'days'), low: 1 }],
      [{ sex: 'any', ageFrom: age(1, 'months'), ageUntil: age(30, 'days'), low: 1 }],
      // Two ranges for men that share an age, or could for some dates of birth.
      [
        { sex: 'male', ageFrom: birth, ageUntil: age(2, 'years'), low: 1 },
        { sex: 'male', ageFrom: age(23, 'months'), low: 1 },
      ],
      [
        { sex: 'male', ageFrom: birth, ageUntil: age(1, 'months'), low: 1 },
        { sex: 'male', ageFrom: age(30, 'days'), low: 1 },
      ],
    ]) {
      await expect(put(ranges)).rejects.toMatchObject({ serverCode: 'validation_failed' });
    }
    // Ranges that meet at the same age are taken, in months against years too.
    const saved = await put([
      { sex: 'male', ageFrom: birth, ageUntil: age(24, 'months'), low: 1 },
      { sex: 'male', ageFrom: age(2, 'years'), low: 1 },
      { sex: 'any', ageFrom: birth, low: 1 },
    ]);
    expect(saved.data?.ranges).toHaveLength(3);
  });

  it('keeps the ages of a range as they were typed, a value with its unit', () => {
    const row = {
      ...blankRangeRow,
      sex: 'male' as const,
      fromValue: '6',
      fromUnit: 'weeks' as const,
      untilValue: '12',
      low: '11',
      criticalLow: '-0.5',
    };
    const saved = toRange(row);
    expect(saved).toEqual({
      sex: 'male',
      ageFrom: { value: 6, unit: 'weeks' },
      ageUntil: { value: 12, unit: 'years' },
      low: 11,
      criticalLow: -0.5,
    });
    expect(toRangeRow(saved)).toEqual(row);

    const next = toRange({ ...row, fromValue: '12', fromUnit: 'years', untilValue: '' });
    expect(next.ageUntil).toBeUndefined();
    expect(rangesOverlap(saved, next)).toBe(false);
    expect(rangesOverlap(saved, { ...next, ageFrom: { value: 143, unit: 'months' } })).toBe(true);
    expect(rangesOverlap(saved, { ...saved, sex: 'female' })).toBe(false);
  });

  it('reads a child against the range in weeks, and refuses limits that only some birthdays keep apart', async () => {
    const bodies = sent('PUT');
    await openRanges(ESR);
    await userEvent.click(button('Edit ranges'));
    await userEvent.click(button('Add a range'));
    await userEvent.click(button('Add a range'));
    await typeIn(1, /^Until age/, '4');
    await userEvent.selectOptions(
      range(1).getByRole('combobox', { name: /^Until age in/ }),
      'weeks',
    );
    await typeIn(1, /^Highest normal/, '2');
    // From one month: but a month is 28 to 31 days, and four weeks are 28.
    await typeIn(2, /^From age/, '1');
    await userEvent.selectOptions(
      range(2).getByRole('combobox', { name: /^From age in/ }),
      'months',
    );
    await typeIn(2, /^Highest normal/, '10');
    await userEvent.click(button('Save ranges'));
    await waitFor(() => expect(statuses()).toContain('The reference ranges were saved.'));
    expect(await screen.findByText('Under 4 weeks')).toBeInTheDocument();
    expect(screen.getByText('From 1 month')).toBeInTheDocument();

    // Five weeks could be past one month, or not, by the month of birth.
    await userEvent.click(button('Edit ranges'));
    await typeIn(1, /^Until age/, '5');
    await userEvent.click(button('Save ranges'));
    expect(await range(2).findByRole('alert')).toHaveTextContent(
      /or could for some dates of birth/,
    );
    expect(bodies).toHaveLength(1);
  });
});

describe('a screen that is too narrow', () => {
  it('says the screen needs a wider display, and asks the server for nothing', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    let asked = 0;
    server.use(
      http.post('*/api/lab-tests/search', () => {
        asked++;
        return undefined;
      }),
    );
    renderApp({ entry: '/lab-tests' });

    expect(
      await screen.findByRole('heading', { name: 'This screen needs a wider display' }),
    ).toBeInTheDocument();
    expect(asked).toBe(0);
  });
});

describe('access', () => {
  it('lets someone who may only read see the catalog and the ranges, with nothing to change them', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    await openList();
    expect(screen.queryByRole('link', { name: 'Add a test' })).not.toBeInTheDocument();

    renderApp({ entry: `/lab-tests/${HB}` });
    await screen.findByText('13 to 17 g/dL');
    expect(screen.queryByRole('button', { name: /Edit details|Archive|Edit ranges/ })).toBeNull();
    // Looking up a range changes nothing, so it is theirs to use.
    expect(button('Find the range')).toBeInTheDocument();
  });

  it('keeps the add screen from someone who may only read', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/lab-tests/new' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is refused by the server too, whatever the screen offers', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const params = { path: { labTestId: HB } };

    await expect(
      api.POST('/lab-tests', {
        body: {
          code: 'X1',
          name: 'X',
          department: 'other',
          kind: 'test',
          sampleType: 'blood',
          turnaroundHours: 1,
        },
        params: { header: { 'idempotency-key': 'test-key-0001' } },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      api.PATCH('/lab-tests/{labTestId}', { params, body: { name: 'x', expectedVersion: 1 } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(api.POST('/lab-tests/{labTestId}/archive', { params })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      api.PUT('/lab-tests/{labTestId}/ranges', {
        params,
        body: { ranges: [], expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('shows the linked service and does not offer the price catalog to someone who may not see it', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'service:read');
    let asked = 0;
    server.use(
      http.post('*/api/services/search', () => {
        asked++;
        return undefined;
      }),
    );
    await openTest(CBC);
    await userEvent.click(button('Edit details'));

    expect(
      screen.getByText(
        'The price catalog is not open to you, so the service cannot be changed here.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /^Charged as/ })).not.toBeInTheDocument();
    expect(asked).toBe(0);
    // The rest of the test can still be changed, and the link is left as it is.
    await type(/^Container/, 'Lavender tube');
    await userEvent.click(button('Save test'));
    await waitFor(() => expect(statuses()).toContain('The test was saved.'));
    expect(screen.getByText('Complete blood count', { selector: 'dd' })).toBeInTheDocument();
  });

  it('does not ask for the price catalog at a hospital that has it switched off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'services', false);
    let asked = 0;
    server.use(
      http.post('*/api/services/search', () => {
        asked++;
        return undefined;
      }),
    );
    await openCreate();

    expect(
      screen.getByText(
        'The price catalog is not open to you, so the service cannot be changed here.',
      ),
    ).toBeInTheDocument();
    expect(asked).toBe(0);
  });

  it('has no screen and no navigation entry without the permission', async () => {
    revokePermission(TENANT_IDS.hospital, 'doctor', 'labTest:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/lab-tests' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Lab tests' })).not.toBeInTheDocument();
  });

  it('does not exist for a hospital that has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'lab_tests', false);
    renderApp({ entry: '/lab-tests' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Lab tests' })).not.toBeInTheDocument();
    await expect(api.POST('/lab-tests/search', { body: {} })).rejects.toMatchObject({
      code: 'forbidden',
      serverCode: 'feature_disabled',
    });
  });
});

describe('two hospitals', () => {
  it('never shows one hospital’s catalog in the other', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const { queryClient, router } = await openList();
    expect(
      queryClient.getQueryCache().findAll({ queryKey: labTestKeys.all(TENANT_IDS.hospital) }),
    ).not.toEqual([]);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await screen.findByRole('heading', { name: 'Hospital management system' });
    // Nothing cached for the previous hospital survives the switch.
    expect(
      queryClient.getQueryCache().findAll({ queryKey: labTestKeys.all(TENANT_IDS.hospital) }),
    ).toEqual([]);

    await router.navigate('/lab-tests');
    expect(await screen.findByRole('link', { name: 'Haemoglobin (clinic)' })).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('2 tests'));
    expect(screen.queryByRole('link', { name: 'Albumin' })).not.toBeInTheDocument();
  });

  it('cannot read, change or build on another hospital’s test or service', async () => {
    // The admin belongs to the hospital only. A clinic test does not exist for them.
    const params = { path: { labTestId: 'lab_c_hb' } };
    const gone = { code: 'not_found' };
    await expect(api.GET('/lab-tests/{labTestId}', { params })).rejects.toMatchObject(gone);
    await expect(
      api.PATCH('/lab-tests/{labTestId}', { params, body: { name: 'x', expectedVersion: 1 } }),
    ).rejects.toMatchObject(gone);
    await expect(api.POST('/lab-tests/{labTestId}/archive', { params })).rejects.toMatchObject(
      gone,
    );
    await expect(api.GET('/lab-tests/{labTestId}/ranges', { params })).rejects.toMatchObject(gone);
    await expect(
      api.PUT('/lab-tests/{labTestId}/ranges', {
        params,
        body: { ranges: [], expectedVersion: 1 },
      }),
    ).rejects.toMatchObject(gone);
    await expect(
      api.GET('/lab-tests/{labTestId}/ranges/resolve', {
        params: { ...params, query: { ageValue: 1, ageUnit: 'days', sex: 'male' } },
      }),
    ).rejects.toMatchObject(gone);

    // An age in the lookup is whole digits with a known unit.
    for (const query of [
      { ageValue: '' as never, ageUnit: 'days', sex: 'male' },
      { ageValue: '1e2' as never, ageUnit: 'days', sex: 'male' },
      { ageValue: 151, ageUnit: 'years', sex: 'male' },
      { ageValue: 1, ageUnit: 'decades' as never, sex: 'male' },
    ] as const) {
      await expect(
        api.GET('/lab-tests/{labTestId}/ranges/resolve', {
          params: { path: { labTestId: CBC }, query },
        }),
      ).rejects.toMatchObject({ serverCode: 'validation_failed' });
    }

    // Nor can a test of this hospital be made of the clinic's test or charged as its service.
    const own = { path: { labTestId: CBC } };
    await expect(
      api.PATCH('/lab-tests/{labTestId}', {
        params: own,
        body: { componentIds: ['lab_c_hb'], expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ serverCode: 'validation_failed' });
    await expect(
      api.PATCH('/lab-tests/{labTestId}', {
        params: own,
        body: { serviceId: 'svc_c_01', expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ serverCode: 'validation_failed' });
    // The same code is free at each hospital: the clinic has its own HB.
    const list = await api.POST('/lab-tests/search', { body: { q: 'hb' } });
    expect(new Set(list.data?.items.map((item) => item.tenantId))).toEqual(
      new Set([TENANT_IDS.hospital]),
    );
  });
});
