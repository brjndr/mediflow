import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  revokePermission,
  setRolePermissions,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { mockOrdersOf } from '@/mocks/handlers/clinical';
import { mockPatient } from '@/mocks/handlers/patients';
import { mockReports } from '@/mocks/handlers/radiology';
import { server } from '@/mocks/node';
import { richTextToPlainText, sanitizeRichText } from '@/shared/ui/rich-text';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Imaging reports (#97). The clinical mock's hospital has one imaging order, `ord_h_img_1`, an
// urgent chest X-ray of pth_00001; each test schedules and performs it behind the screen, as the
// radiographer would, then works its report. The templates mock has one imaging report template,
// "Plain radiograph".

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const LIST = { name: 'Radiology worklist', level: 1 };
const ORDER = 'ord_h_img_1';
const SLOT = 15 * 60_000;

// The editor scrolls the cursor into view, which needs layout measurements jsdom does not have.
beforeAll(() => {
  const noRects = () => [] as unknown as DOMRectList;
  const noRect = () => new DOMRect(0, 0, 0, 0);
  for (const prototype of [Range.prototype, Element.prototype, Text.prototype] as object[]) {
    const target = prototype as { getClientRects?: unknown; getBoundingClientRect?: unknown };
    target.getClientRects ??= noRects;
    target.getBoundingClientRect ??= noRect;
  }
  document.elementFromPoint ??= () => null;
});

afterEach(() => {
  server.events.removeAllListeners();
});

const patient = () => mockPatient(HOSPITAL, 'pth_00001')?.name ?? '';
const grid = () => screen.getByRole('table', { name: LIST.name });
const report = () => mockReports().find((each) => each.orderId === ORDER);
const orderStatus = () => mockOrdersOf('enc_h_1').find((each) => each.id === ORDER)?.status;
const plain = (document: unknown) => richTextToPlainText(sanitizeRichText(document));

/** Calls the mock as another member of staff would, behind the open screen. */
async function send(method: string, path: string, body?: unknown) {
  const response = await fetch(new URL(`/api${path}`, window.location.origin), {
    method,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await response.json()) as Record<string, unknown>;
}

/** Schedules and performs the chest X-ray, as the radiographer would. */
async function performStudy() {
  const at = new Date((Math.floor(Date.now() / SLOT) + 1) * SLOT).toISOString();
  const study = await send('POST', `/radiology/orders/${ORDER}/schedule`, { scheduledAt: at });
  await send('POST', `/radiology/orders/${ORDER}/perform`, { version: study.version });
}

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

async function openStage(stage: string) {
  renderApp({ entry: '/radiology' });
  await screen.findByRole('heading', LIST);
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Stage' }), stage);
  await within(grid()).findByText(patient());
}

const rowAction = (name: string) =>
  within(grid()).getByRole('button', { name: `${name}: ${patient()}, Chest X-ray` });

async function openReport(action = 'Write report') {
  await openStage('Performed, awaiting report');
  await userEvent.click(rowAction(action));
  return screen.findByRole('heading', { name: 'Report of Chest X-ray' });
}

async function typeInto(name: string, text: string) {
  const editor = await screen.findByRole('textbox', { name });
  await userEvent.click(editor);
  await userEvent.keyboard(text);
}

describe('writing a report', () => {
  it(
    'saves a draft on the server, then signs it after a confirmation',
    { timeout: 30_000 },
    async () => {
      await performStudy();
      const heading = await openReport();
      await waitFor(() => expect(heading).toHaveFocus());
      await typeInto('Findings', 'Lungs clear.');
      await typeInto('Impression', 'Normal chest.');
      await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
      expect(await screen.findByText(/Draft saved at/)).toBeInTheDocument();
      expect(report()).toMatchObject({ status: 'draft', version: 1 });
      expect(plain(report()?.findings)).toBe('Lungs clear.');
      await expectNoAxeViolations(document.body);

      await userEvent.click(screen.getByRole('button', { name: 'Sign report' }));
      const signNow = screen.getByRole('button', { name: 'Sign now' });
      expect(signNow).toHaveFocus();
      // Back returns to Sign, nothing sent.
      await userEvent.click(screen.getByRole('button', { name: 'Back' }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Sign report' })).toHaveFocus(),
      );
      await userEvent.click(screen.getByRole('button', { name: 'Sign report' }));
      await userEvent.click(screen.getByRole('button', { name: 'Sign now' }));

      expect(
        await screen.findByRole('heading', { name: 'Signed report of Chest X-ray' }),
      ).toBeInTheDocument();
      expect(report()?.status).toBe('signed');
      expect(orderStatus()).toBe('completed');
      expect(
        await screen.findByText(`The report of Chest X-ray for ${patient()} is signed.`, {
          exact: false,
        }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Findings' })).toBeNull();
      // Nothing of the report is kept in the browser.
      expect(window.localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(0);
    },
  );

  it(
    'fills the findings from a template, and refuses to sign with a placeholder left',
    { timeout: 30_000 },
    async () => {
      await performStudy();
      await openReport();
      await userEvent.selectOptions(
        await screen.findByRole('combobox', { name: 'Report template' }),
        'Plain radiograph',
      );
      await userEvent.click(screen.getByRole('button', { name: 'Fill findings' }));
      const findings = await screen.findByRole('textbox', { name: 'Findings' });
      await waitFor(() =>
        expect(findings).toHaveTextContent(`Chest X-ray (X-ray) for ${patient()}`),
      );
      // Braces are typed doubled: userEvent reads one as the start of a key name.
      await typeInto('Impression', 'See {{{{doctor.note}}');
      await userEvent.click(screen.getByRole('button', { name: 'Sign report' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/placeholder of the template/);
      expect(screen.queryByRole('button', { name: 'Sign now' })).toBeNull();

      await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
      await waitFor(() => expect(report()?.templateId).toBe('tpl_h_xray'));
      expect(report()?.templateVersion).toBe(1);
    },
  );

  it('saves what was typed before signing it', async () => {
    await performStudy();
    await openReport();
    await typeInto('Findings', 'Lungs clear.');
    await typeInto('Impression', 'Normal chest.');
    await userEvent.click(screen.getByRole('button', { name: 'Sign report' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sign now' }));
    await screen.findByRole('heading', { name: 'Signed report of Chest X-ray' });
    expect(report()).toMatchObject({ status: 'signed' });
    expect(plain(report()?.impression)).toBe('Normal chest.');
  });

  it('keeps what is typed when someone else signs meanwhile, and sends nothing more', async () => {
    await performStudy();
    const saved = await send('PUT', `/radiology/orders/${ORDER}/report`, {
      technique: { type: 'doc', content: [] },
      findings: doc('Lungs clear.'),
      impression: doc('Normal chest.'),
      links: [],
    });
    await openReport();
    await screen.findByRole('textbox', { name: 'Findings' });
    await send('POST', `/radiology/orders/${ORDER}/report/sign`, { version: saved.version });
    await typeInto('Technique', 'PA view.');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This report was signed meanwhile.');
    // The draft stays on screen, with what was typed, and offers nothing more to send.
    expect(screen.getByRole('textbox', { name: 'Technique' })).toHaveTextContent('PA view.');
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign report' })).toBeNull();
  });

  it('refuses to sign without findings and an impression', async () => {
    await performStudy();
    await openReport();
    await screen.findByRole('textbox', { name: 'Findings' });
    await userEvent.click(screen.getByRole('button', { name: 'Sign report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Write the findings and the impression before signing.',
    );
    expect(report()).toBeUndefined();
  });

  it('adds https links and refuses one with an access token in it', async () => {
    await performStudy();
    await openReport();
    await userEvent.type(await screen.findByRole('textbox', { name: /^Label/ }), 'Outside viewer');
    await userEvent.type(
      screen.getByRole('textbox', { name: /^Address/ }),
      'https://pacs.example.org/s/1?access_token=abc',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add link' }));
    expect(
      await screen.findByText(
        'Enter an https address with no user name, password or access token in it.',
      ),
    ).toBeInTheDocument();
    const address = screen.getByRole('textbox', { name: /^Address/ });
    await userEvent.clear(address);
    await userEvent.type(address, 'https://pacs.example.org/s/1');
    await userEvent.click(screen.getByRole('button', { name: 'Add link' }));
    expect(
      await screen.findByRole('button', { name: 'Remove link Outside viewer' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(report()?.links).toEqual([
        { label: 'Outside viewer', url: 'https://pacs.example.org/s/1' },
      ]),
    );
  });

  it('asks what to keep when someone saved the draft meanwhile', { timeout: 30_000 }, async () => {
    await performStudy();
    await send('PUT', `/radiology/orders/${ORDER}/report`, {
      technique: { type: 'doc', content: [] },
      findings: doc('First look.'),
      impression: { type: 'doc', content: [] },
      links: [],
    });
    await openReport('Write report');
    expect(await screen.findByRole('textbox', { name: 'Findings' })).toHaveTextContent(
      'First look.',
    );
    await send('PUT', `/radiology/orders/${ORDER}/report`, {
      technique: { type: 'doc', content: [] },
      findings: doc('Someone else’s words.'),
      impression: { type: 'doc', content: [] },
      links: [],
      version: 1,
    });
    await typeInto('Impression', 'Mine.');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone saved this report meanwhile.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Use the saved text' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Findings' })).toHaveTextContent(
        'Someone else’s words.',
      ),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(report()?.version).toBe(2);
  });
});

describe('a signed report', () => {
  async function signBehind() {
    await performStudy();
    const draft = await send('PUT', `/radiology/orders/${ORDER}/report`, {
      technique: { type: 'doc', content: [] },
      findings: doc('Lungs clear.'),
      impression: doc('Normal chest.'),
      links: [{ label: 'Outside viewer', url: 'https://pacs.example.org/s/1' }],
    });
    await send('POST', `/radiology/orders/${ORDER}/report/sign`, { version: draft.version });
  }

  it(
    'is listed as reported, shown as signed, and takes signed addenda',
    { timeout: 30_000 },
    async () => {
      await signBehind();
      await openStage('Reported');
      await userEvent.click(rowAction('View report'));
      await screen.findByRole('heading', { name: 'Signed report of Chest X-ray' });
      expect(screen.getByText('Normal chest.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Outside viewer' })).toHaveAttribute(
        'rel',
        'noopener noreferrer',
      );
      expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
      await expectNoAxeViolations(document.body);

      await userEvent.click(screen.getByRole('button', { name: 'Add addendum' }));
      expect(await screen.findByRole('heading', { name: 'Add an addendum' })).toHaveFocus();
      // Both are said at once, and the text, which comes first, takes focus.
      await userEvent.click(screen.getByRole('button', { name: 'Sign addendum' }));
      expect(await screen.findByText('This field is required.')).toBeInTheDocument();
      expect(screen.getByText('Write the addendum before signing it.')).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Addendum' })).toHaveFocus());
      await userEvent.selectOptions(
        screen.getByRole('combobox', { name: /^Reason/ }),
        'Correction',
      );
      await typeInto('Addendum', 'Small left effusion.');
      await userEvent.click(screen.getByRole('button', { name: 'Sign addendum' }));

      expect(await screen.findByText('Addendum added and signed.')).toBeInTheDocument();
      expect(screen.getByText('Small left effusion.')).toBeInTheDocument();
      expect(screen.getByText(/^Correction, by /)).toBeInTheDocument();
      expect(report()?.addenda).toHaveLength(1);
      expect(plain(report()?.findings)).toBe('Lungs clear.');
    },
  );
});

describe('access', () => {
  it('withholds a draft from a role that only reads the worklist', async () => {
    await performStudy();
    await send('PUT', `/radiology/orders/${ORDER}/report`, {
      technique: { type: 'doc', content: [] },
      findings: doc('Draft words.'),
      impression: { type: 'doc', content: [] },
      links: [],
    });
    setRolePermissions(HOSPITAL, 'admin', [{ permission: 'imagingStudy:read' }]);
    await openReport('View report');
    expect(
      await screen.findByText('No report has been signed for this study yet.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Draft words.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign report' })).toBeNull();
  });

  it('lets a custom role that writes reports save, and not sign, with no template picker', async () => {
    await performStudy();
    setRolePermissions(HOSPITAL, 'admin', [
      { permission: 'imagingStudy:read' },
      { permission: 'imagingReport:write' },
    ]);
    await openReport();
    await screen.findByRole('textbox', { name: 'Findings' });
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign report' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Report template' })).toBeNull();
  });

  it('offers no template picker with the templates module off', async () => {
    await performStudy();
    setTenantFeature(HOSPITAL, 'templates', false);
    await openReport();
    await screen.findByRole('textbox', { name: 'Findings' });
    expect(screen.queryByRole('combobox', { name: 'Report template' })).toBeNull();
  });

  it('is unreachable with radiology off', async () => {
    setTenantFeature(HOSPITAL, 'radiology', false);
    signIn(USER_IDS.admin, HOSPITAL);
    renderApp({ entry: '/radiology' });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeInTheDocument();
  });

  it('keeps each hospital’s reports to itself', async () => {
    await performStudy();
    setTenantFeature(CLINIC, 'radiology', true);
    signIn(USER_IDS.doctor, CLINIC);
    setRolePermissions(CLINIC, 'doctor', [
      { permission: 'imagingStudy:read' },
      { permission: 'imagingReport:write' },
    ]);
    const answer = await send('GET', `/radiology/orders/${ORDER}/report`);
    expect(answer).toMatchObject({ error: { code: 'order_not_found' } });
    revokePermission(CLINIC, 'doctor', 'imagingReport:write');
  });
});
