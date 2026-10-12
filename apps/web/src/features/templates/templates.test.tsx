import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revokePermission, setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { saveMockTemplateVersion } from '@/mocks/handlers/templates';
import { server } from '@/mocks/node';
import { api } from '@/shared/api';
import type { RichTextDocument } from '@/shared/ui/rich-text';
import { renderApp } from '@/test/render';
import { templateKeys } from './hooks/use-templates';
import {
  fillPlaceholders,
  placeholdersFor,
  placeholdersIn,
  unknownPlaceholders,
} from './placeholders';

const HEADING = { name: 'Document templates', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };
/** The hospital's prescription, at version 2. */
const RX = 'tpl_h_rx';
/** Its discharge summary, at version 3. */
const DISCHARGE = 'tpl_h_discharge';

const doc = (...lines: string[]): RichTextDocument => ({
  type: 'doc',
  content: lines.map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
});
const asBody = (document: RichTextDocument) => document as unknown as Record<string, unknown>;

const openList = async () => {
  const app = renderApp({ entry: '/templates' });
  await screen.findByRole('link', { name: 'Standard prescription' });
  return app;
};
const openTemplate = async (id = RX) => {
  const app = renderApp({ entry: `/templates/${id}` });
  await screen.findByRole('heading', { name: 'Versions' });
  return app;
};
const openCreate = async () => {
  const app = renderApp({ entry: '/templates/new' });
  await screen.findByRole('heading', { name: 'Add a template' });
  return app;
};
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const statuses = () => screen.getAllByRole('status').map((status) => status.textContent);
const choose = (name: RegExp | string, option: string) =>
  userEvent.selectOptions(screen.getByRole('combobox', { name }), option);
const preview = () => within(screen.getByRole('region', { name: 'Preview' }));
/** Puts a placeholder into the text where the cursor is, from the list in the toolbar. */
const insert = async (label: string) => {
  await screen.findByRole('textbox', { name: 'Text' });
  await choose('Insert a placeholder', label);
};

async function typeName(text: string) {
  const name = screen.getByRole('textbox', { name: /^Name/ });
  await userEvent.clear(name);
  await userEvent.type(name, text);
}

/** The bodies of the requests of a method, as they were sent. */
function sent(method: string): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method === method)
      void request
        .clone()
        .json()
        .then((body) => bodies.push(body as Record<string, unknown>));
  });
  return bodies;
}

afterEach(() => {
  vi.unstubAllGlobals();
  server.events.removeAllListeners();
});

describe('the templates', () => {
  it('are listed by name with their kind and newest version', async () => {
    await openList();

    expect(screen.getByRole('heading', HEADING)).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('5 templates'));
    const row = within(
      screen.getByRole('link', { name: 'Discharge summary' }).closest('tr, li') as HTMLElement,
    );
    expect(row.getByText('Version 3')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Old prescription pad' })).not.toBeInTheDocument();
  });

  it('are reached from the navigation', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('link', { name: 'Document templates' }));

    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });

  it('are narrowed to a kind, and the archived ones shown when asked', async () => {
    await openList();
    await choose('Kind', 'Consent form');
    await waitFor(() => expect(statuses()).toContain('2 templates'));
    expect(screen.queryByRole('link', { name: 'Standard prescription' })).not.toBeInTheDocument();

    await choose('Kind', 'All kinds');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show archived templates' }));
    expect(await screen.findByRole('link', { name: 'Old prescription pad' })).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('1 archived template'));
  });
});

describe('a template', () => {
  it('shows its text as saved, and a preview with made-up values in place of the placeholders', async () => {
    await openTemplate();

    expect(screen.getByRole('heading', { name: 'Standard prescription' })).toBeInTheDocument();
    expect(screen.getByText('Prescription · Version 2')).toBeInTheDocument();
    // As saved: the placeholders are there to be read.
    expect(screen.getByText('Prescribed by {{doctor.name}}')).toBeInTheDocument();
    // As a document made from it would read. The hospital's name is the real one.
    expect(preview().getByText('Prescribed by Dr Sample Doctor')).toBeInTheDocument();
    expect(
      preview().getByText('Patient: Sample Patient (MRN-000123), 42 years, Female'),
    ).toBeInTheDocument();
    expect(preview().getByText('Sample Hospital')).toBeInTheDocument();
    expect(preview().queryByText(/\{\{/)).not.toBeInTheDocument();
  });

  it('keeps every version, and shows an older one as it was saved', async () => {
    await openTemplate(DISCHARGE);
    const versions = within(screen.getByRole('region', { name: 'Versions' }));
    expect(versions.getAllByText(/^Version \d$/).map((cell) => cell.textContent)).toEqual([
      'Version 3',
      'Version 2',
      'Version 1',
    ]);

    await userEvent.click(button('View: Version 1'));
    const shown = within(await screen.findByRole('region', { name: 'Version 1, as it was saved' }));
    // The first version had no record number, and still has none.
    expect(await shown.findByText('Patient: {{patient.name}}')).toBeInTheDocument();
    expect(shown.queryByText(/patient\.mrn/)).not.toBeInTheDocument();

    await userEvent.click(button('Close'));
    expect(screen.queryByRole('region', { name: /as it was saved/ })).not.toBeInTheDocument();
  });

  it('saves a change as a new version, and the one before it stays as it was', async () => {
    const bodies = sent('PUT');
    await openTemplate();
    await userEvent.click(button('Edit as a new version'));
    await insert("Today's date");
    await userEvent.click(button('Save as a new version'));

    await waitFor(() => expect(statuses()).toContain('Saved as version 3.'));
    expect(screen.getByText('Prescription · Version 3')).toBeInTheDocument();
    // Only the text was sent, from the version the edit was made from.
    expect(Object.keys(bodies[0] ?? {}).sort()).toEqual(['body', 'expectedVersion']);
    expect(bodies[0]?.expectedVersion).toBe(2);
    expect(JSON.stringify(bodies[0]?.body)).toContain('{{date.today}}');

    const before = await api.GET('/templates/{templateId}/versions/{version}', {
      params: { path: { templateId: RX, version: 2 } },
    });
    expect(JSON.stringify(before.data?.body)).toContain('Prescribed by {{doctor.name}}');
    const first = await api.GET('/templates/{templateId}/versions/{version}', {
      params: { path: { templateId: RX, version: 1 } },
    });
    expect(JSON.stringify(first.data?.body)).not.toContain('doctor.name');
  });

  it('renames with a new version, and makes none when nothing was changed', async () => {
    const bodies = sent('PUT');
    await openTemplate();
    await userEvent.click(button('Edit as a new version'));
    await screen.findByRole('textbox', { name: 'Text' });
    await userEvent.click(button('Save as a new version'));
    await waitFor(() =>
      expect(statuses()).toContain('Nothing was changed, so no new version was made.'),
    );
    expect(bodies).toEqual([]);

    await userEvent.click(button('Edit as a new version'));
    await screen.findByRole('textbox', { name: 'Text' });
    await typeName('Outpatient prescription');
    await userEvent.click(button('Save as a new version'));
    await waitFor(() => expect(statuses()).toContain('Saved as version 3.'));
    expect(bodies).toEqual([{ name: 'Outpatient prescription', expectedVersion: 2 }]);
    expect(screen.getByRole('heading', { name: 'Outpatient prescription' })).toBeInTheDocument();
  });

  it('shows the preview of the text as it is being written', async () => {
    await openTemplate();
    await userEvent.click(button('Edit as a new version'));
    await insert("Patient's age");

    // The placeholder went into the text, and the preview fills it at once.
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Text' })).toHaveTextContent('{{patient.age}}'),
    );
    expect(preview().getAllByText(/42 years/).length).toBeGreaterThan(0);
  });

  it('offers only the placeholders its kind knows', async () => {
    await openTemplate();
    await userEvent.click(button('Edit as a new version'));
    await screen.findByRole('textbox', { name: 'Text' });
    const offered = within(screen.getByRole('combobox', { name: 'Insert a placeholder' }))
      .getAllByRole('option')
      .map((option) => option.textContent);

    expect(offered).toContain("Patient's name");
    // A prescription has no procedure and no admission.
    expect(offered).not.toContain('Name of the procedure');
    expect(offered).not.toContain('Date of admission');
  });

  it('keeps the text after someone else saved a version meanwhile, and saves it as the newest when asked again', async () => {
    const bodies = sent('PUT');
    await openTemplate();
    await userEvent.click(button('Edit as a new version'));
    await insert("Today's date");
    saveMockTemplateVersion(RX, ['Theirs, for {{patient.name}}']);
    await userEvent.click(button('Save as a new version'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Someone else saved version 3 while you were editing\. Your text is still here/,
    );
    expect(screen.getByRole('textbox', { name: 'Text' })).toHaveTextContent('{{date.today}}');

    await userEvent.click(button('Save as a new version'));
    await waitFor(() => expect(statuses()).toContain('Saved as version 4.'));
    expect(bodies.map((body) => body.expectedVersion)).toEqual([2, 3]);
    // Theirs is not lost: it is version 3 in the history.
    const theirs = await api.GET('/templates/{templateId}/versions/{version}', {
      params: { path: { templateId: RX, version: 3 } },
    });
    expect(JSON.stringify(theirs.data?.body)).toContain('Theirs, for {{patient.name}}');
    expect(theirs.data?.savedByName).toBe('Someone Else');
  });

  it('is archived, with no new version and nothing to edit, and restored', async () => {
    await openTemplate();
    await userEvent.click(button('Archive'));
    await waitFor(() => expect(statuses()).toContain('Standard prescription was archived.'));
    expect(screen.getByText(/This template is archived/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit as a new version' })).toBeNull();
    expect(screen.getByText('Prescription · Version 2')).toBeInTheDocument();

    await userEvent.click(button('Restore'));
    await waitFor(() => expect(statuses()).toContain('Standard prescription was restored.'));
    expect(await screen.findByRole('button', { name: 'Edit as a new version' })).toBeEnabled();
  });

  it('has one answer for a template that does not exist and one of another hospital', async () => {
    renderApp({ entry: '/templates/tpl_c_rx' });

    expect(await screen.findByRole('heading', { name: 'Template not found' })).toBeInTheDocument();
  });
});

describe('adding a template', () => {
  it('adds a consent form with the placeholders of its kind, as version 1, and opens it', async () => {
    const bodies = sent('POST');
    const { router } = await openCreate();
    expect(screen.getByText('Choose a kind to write the text.')).toBeInTheDocument();
    await choose(/^Kind/, 'Consent form');
    await typeName('Consent for anaesthesia');
    await insert("Patient's name");
    await insert('Name of the procedure');
    await userEvent.click(button('Add template'));

    expect(
      await screen.findByRole('heading', { name: 'Consent for anaesthesia' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/templates/tpl_new_1');
    expect(screen.getByText('Consent form · Version 1')).toBeInTheDocument();
    expect(preview().getByText(/Sample Patient/)).toBeInTheDocument();
    expect(preview().getByText(/Sample procedure/)).toBeInTheDocument();
    expect(bodies[0]).toMatchObject({ kind: 'consent', name: 'Consent for anaesthesia' });
    expect(JSON.stringify(bodies[0]?.body)).toContain('{{patient.name}}{{procedure.name}}');
  });

  it('needs a kind, a name and some text', async () => {
    const bodies = sent('POST');
    await openCreate();
    await userEvent.click(button('Add template'));
    expect(await screen.findAllByText('This field is required.')).toHaveLength(2);

    await choose(/^Kind/, 'Prescription');
    await typeName('Empty one');
    await screen.findByRole('textbox', { name: 'Text' });
    await userEvent.click(button('Add template'));
    expect(await screen.findByText('A template needs some text.')).toBeInTheDocument();
    expect(bodies).toEqual([]);
  });

  it('says so when a template of that kind already has the name', async () => {
    await openCreate();
    await choose(/^Kind/, 'Prescription');
    await typeName('standard prescription');
    await insert("Patient's name");
    await userEvent.click(button('Add template'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Another template of this kind already has that name at this hospital. It may be archived.',
    );
    // The same name is free for another kind.
    const other = await api.POST('/templates', {
      body: { kind: 'consent', name: 'Standard prescription', body: asBody(doc('Text')) },
      params: { header: { 'Idempotency-Key': 'test-key-0001' } },
    });
    expect(other.data?.template.version).toBe(1);
  });

  it('is refused by the server with a placeholder its kind does not know, with no text, or with markup', async () => {
    const add = (body: unknown, key: string, kind = 'prescription') =>
      api.POST('/templates', {
        body: { kind, name: `Template ${key}`, body } as never,
        params: { header: { 'Idempotency-Key': key } },
      });
    const refused = { serverCode: 'validation_failed' };

    await expect(add(asBody(doc('For {{procedure.name}}')), 'test-key-0001')).rejects.toMatchObject(
      refused,
    );
    await expect(
      add(asBody(doc('For {{patient.address}}')), 'test-key-0002'),
    ).rejects.toMatchObject(refused);
    await expect(add(asBody(doc('   ')), 'test-key-0003')).rejects.toMatchObject(refused);
    // What is not rich text is dropped, which leaves nothing.
    await expect(
      add({ type: 'doc', content: [{ type: 'script', text: 'x' }] }, 'test-key-0004'),
    ).rejects.toMatchObject(refused);
    // The same placeholder is known to a consent form.
    const consent = await add(asBody(doc('For {{procedure.name}}')), 'test-key-0005', 'consent');
    expect(consent.data?.template.kind).toBe('consent');
  });
});

describe('placeholders', () => {
  it('are found in the text, known by kind, and filled in as text', () => {
    const body = doc(
      'Dear {{ patient.name }}, see {{doctor.name}}.',
      '{{patient.name}} {{made.up}}',
    );

    expect(placeholdersIn(body)).toEqual(['patient.name', 'doctor.name', 'made.up']);
    expect(unknownPlaceholders('prescription', body)).toEqual(['made.up']);
    expect(placeholdersFor('discharge_summary')).toContain('discharge.date');
    expect(placeholdersFor('prescription')).not.toContain('discharge.date');

    const filled = fillPlaceholders(body, { 'patient.name': 'A <b>B</b>', 'doctor.name': 'Dr C' });
    // A value is text, whatever it holds; a placeholder with no value stays to be seen.
    expect(filled).toEqual(doc('Dear A <b>B</b>, see Dr C.', 'A <b>B</b> {{made.up}}'));
    // The template itself is not changed.
    expect(placeholdersIn(body)).toHaveLength(3);
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
      http.get('*/api/templates', () => {
        asked++;
        return undefined;
      }),
    );
    renderApp({ entry: '/templates' });

    expect(
      await screen.findByRole('heading', { name: 'This screen needs a wider display' }),
    ).toBeInTheDocument();
    expect(asked).toBe(0);
  });
});

describe('access', () => {
  it('lets someone who may only read see the templates and their versions, with nothing to change them', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    await openList();
    expect(screen.queryByRole('link', { name: 'Add a template' })).not.toBeInTheDocument();

    renderApp({ entry: `/templates/${RX}` });
    await screen.findByText('Prescribed by {{doctor.name}}');
    expect(screen.queryByRole('button', { name: /Edit as a new version|Archive/ })).toBeNull();
    expect(button('View: Version 1')).toBeInTheDocument();
  });

  it('keeps the add screen from someone who may only read', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/templates/new' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is refused by the server too, whatever the screen offers', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const params = { path: { templateId: RX } };
    const forbidden = { code: 'forbidden' };

    await expect(
      api.POST('/templates', {
        body: { kind: 'prescription', name: 'X', body: asBody(doc('x')) },
        params: { header: { 'Idempotency-Key': 'test-key-0001' } },
      }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      api.PUT('/templates/{templateId}', { params, body: { name: 'x', expectedVersion: 2 } }),
    ).rejects.toMatchObject(forbidden);
    await expect(api.POST('/templates/{templateId}/archive', { params })).rejects.toMatchObject(
      forbidden,
    );
  });

  it('has no screen and no navigation entry without the permission', async () => {
    revokePermission(TENANT_IDS.hospital, 'doctor', 'template:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/templates' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Document templates' })).not.toBeInTheDocument();
  });

  it('does not exist for a hospital that has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'templates', false);
    renderApp({ entry: '/templates' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    await expect(api.GET('/templates', { params: { query: {} } })).rejects.toMatchObject({
      code: 'forbidden',
      serverCode: 'feature_disabled',
    });
  });
});

describe('two hospitals', () => {
  it('each have their own templates, even of the same name', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const { queryClient, router } = await openList();
    expect(
      queryClient.getQueryCache().findAll({ queryKey: templateKeys.all(TENANT_IDS.hospital) }),
    ).not.toEqual([]);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await screen.findByRole('heading', { name: 'Hospital management system' });
    // Nothing cached for the previous hospital survives the switch.
    expect(
      queryClient.getQueryCache().findAll({ queryKey: templateKeys.all(TENANT_IDS.hospital) }),
    ).toEqual([]);

    await router.navigate('/templates');
    await userEvent.click(await screen.findByRole('link', { name: 'Standard prescription' }));
    // The clinic's own text under the same name, and only its one template.
    expect(
      await screen.findByText('Riverside prescription for {{patient.name}}'),
    ).toBeInTheDocument();
    expect(preview().getByText('Riverside prescription for Sample Patient')).toBeInTheDocument();
    expect(screen.getByText('Prescription · Version 1')).toBeInTheDocument();
  });

  it('cannot read or change another hospital’s template or its versions', async () => {
    // The admin belongs to the hospital only. A clinic template does not exist for them.
    const params = { path: { templateId: 'tpl_c_rx' } };
    const gone = { code: 'not_found' };
    await expect(api.GET('/templates/{templateId}', { params })).rejects.toMatchObject(gone);
    await expect(
      api.GET('/templates/{templateId}/versions/{version}', {
        params: { path: { ...params.path, version: 1 } },
      }),
    ).rejects.toMatchObject(gone);
    await expect(
      api.PUT('/templates/{templateId}', { params, body: { name: 'x', expectedVersion: 1 } }),
    ).rejects.toMatchObject(gone);
    await expect(api.POST('/templates/{templateId}/archive', { params })).rejects.toMatchObject(
      gone,
    );
    // A version this hospital's template never had is not there either.
    await expect(
      api.GET('/templates/{templateId}/versions/{version}', {
        params: { path: { templateId: RX, version: 9 } },
      }),
    ).rejects.toMatchObject(gone);
    const list = await api.GET('/templates', { params: { query: {} } });
    expect(new Set(list.data?.items.map((item) => item.tenantId))).toEqual(
      new Set([TENANT_IDS.hospital]),
    );
  });
});
