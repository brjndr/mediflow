import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
import {
  addMockQueueToken,
  dropMockQueueStreams,
  mockQueueStreams,
  mockQueueToken,
} from '@/mocks/handlers/queue';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { queueKeys } from './hooks/use-queue';

const HEADING = { name: 'OPD queue', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };
const LIVE = 'Live: changes show within seconds.';

const grid = (name: 'Now serving' | 'Waiting' | 'Skipped') => screen.getByRole('table', { name });
/** The token numbers of a group, in the order shown. */
const tokensIn = (name: 'Now serving' | 'Waiting' | 'Skipped') =>
  within(grid(name))
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0]?.textContent ?? '')
    .filter((text) => text.startsWith('Token'));
const status = () =>
  screen.getByText(
    (_, element) =>
      element?.getAttribute('role') === 'status' &&
      element.tagName === 'P' &&
      element.hasAttribute('tabindex'),
  );

/** Every read of the queue's tokens, as the server saw them. */
function watchReads(): string[] {
  const seen: string[] = [];
  server.events.on('request:start', ({ request }) => {
    if (new URL(request.url).pathname.endsWith('/api/queue/tokens') && request.method === 'GET') {
      seen.push(request.url);
    }
  });
  return seen;
}

let late = 0;
/** A token issued at another desk meanwhile, to a patient with no token today. */
function lateToken(tenantId: string, departmentId: string) {
  late += 1;
  const patient =
    tenantId === TENANT_IDS.clinic ? 'ptc_00030' : `pth_009${String(late).padStart(2, '0')}`;
  return {
    id: `qt_late_${late}`,
    tenantId,
    departmentId,
    patientId: patient,
    status: 'waiting' as const,
    issuedAt: new Date().toISOString(),
    callCount: 0,
    version: 1,
  };
}

const openBoard = async (entry = '/queue') => {
  const app = renderApp({ entry });
  await screen.findByRole('heading', HEADING);
  await screen.findByText(LIVE);
  return app;
};

describe('the queue board', () => {
  it('shows today’s queue in three groups, in call order: a priority first, then by time issued', async () => {
    await openBoard();
    // The admin has no doctor profile: every doctor's queue.
    await waitFor(() =>
      expect(tokensIn('Waiting')).toEqual([
        'Token 4',
        'Token 1',
        'Token 2',
        'Token 3',
        'Token 1',
        'Token 2',
      ]),
    );
    expect(tokensIn('Now serving')).toEqual(['Token 1']);
    expect(tokensIn('Skipped')).toEqual(['Token 5']);
    // The priority is said in words, and the MRN is masked.
    const first = within(grid('Waiting')).getAllByRole('row')[1] as HTMLElement;
    expect(within(first).getByText('Senior citizen')).toBeInTheDocument();
    expect(first.textContent).not.toMatch(/MRN-PTH-\d{5}/);
    await expectNoAxeViolations();
  });

  it('is reached from the navigation', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('link', { name: 'OPD queue' }));
    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });

  it('narrows to a doctor’s queue: theirs and their department’s tokens for any doctor', async () => {
    await openBoard();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Doctor' }), 'doc_h_01');
    await waitFor(() => expect(tokensIn('Waiting')).toEqual(['Token 4', 'Token 2', 'Token 3']));
  });

  it('calls the next patient of a doctor, and the one being served is done', async () => {
    await openBoard();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Doctor' }), 'doc_h_01');
    await waitFor(() => expect(tokensIn('Waiting')).toHaveLength(3));
    await userEvent.click(screen.getByRole('button', { name: /^Call next for / }));

    await waitFor(() => expect(status().textContent).toMatch(/^Token 4, .+, called\.$/));
    await waitFor(() => expect(tokensIn('Now serving')).toEqual(['Token 4']));
    expect(tokensIn('Waiting')).toEqual(['Token 2', 'Token 3']);
    expect(mockQueueToken(`qt_${TENANT_IDS.hospital}_dep_h_01_1`)?.status).toBe('served');
    // The token for any doctor is now the doctor's.
    expect(mockQueueToken(`qt_${TENANT_IDS.hospital}_dep_h_01_4`)?.doctorId).toBe('doc_h_01');
  });

  it('says so when nobody is waiting', async () => {
    await openBoard();
    // The doctor of the fourth department has nobody today.
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Doctor' }), 'doc_h_04');
    await userEvent.click(screen.getByRole('button', { name: /^Call next for / }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Nobody is waiting for this doctor.',
    );
  });

  it('skips a patient who did not come, and puts them back in the queue when they do', async () => {
    await openBoard();
    await waitFor(() => expect(tokensIn('Now serving')).toEqual(['Token 1']));
    const serving = within(grid('Now serving')).getAllByRole('row')[1] as HTMLElement;
    await userEvent.click(within(serving).getByRole('button', { name: /^Skip/ }));
    await waitFor(() => expect(status().textContent).toMatch(/^Token 1, .+, skipped\.$/));
    await waitFor(() => expect(tokensIn('Skipped')).toEqual(['Token 1', 'Token 5']));
    // The row it was on has gone: focus is on the line that says what was done.
    expect(document.activeElement).toBe(status());

    const skipped = within(grid('Skipped')).getAllByRole('row')[2] as HTMLElement;
    await userEvent.click(within(skipped).getByRole('button', { name: /^Back in the queue/ }));
    await waitFor(() =>
      expect(status().textContent).toMatch(/^Token 5, .+, is back in the queue\.$/),
    );
    await waitFor(() => expect(tokensIn('Skipped')).toEqual(['Token 1']));
    expect(tokensIn('Waiting')).toContain('Token 5');
  });

  it('calls a patient again', async () => {
    await openBoard();
    await waitFor(() => expect(tokensIn('Now serving')).toHaveLength(1));
    const serving = within(grid('Now serving')).getAllByRole('row')[1] as HTMLElement;
    await userEvent.click(within(serving).getByRole('button', { name: /^Call again/ }));
    await waitFor(() => expect(status().textContent).toMatch(/called again\.$/));
    expect(mockQueueToken(`qt_${TENANT_IDS.hospital}_dep_h_01_1`)?.callCount).toBe(2);
  });

  it('changes a token’s priority in a panel, and focus comes back to where it was', async () => {
    await openBoard();
    await waitFor(() => expect(tokensIn('Waiting')).toHaveLength(6));
    const row = within(grid('Waiting')).getAllByRole('row')[3] as HTMLElement;
    const open = within(row).getByRole('button', { name: /^Change priority/ });
    await userEvent.click(open);
    const heading = await screen.findByRole('heading', { name: /^Priority of token 2,/ });
    expect(document.activeElement).toBe(heading);
    await expectNoAxeViolations();

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Priority' }), 'Child');
    await userEvent.click(screen.getByRole('button', { name: 'Save priority' }));
    await waitFor(() =>
      expect(status().textContent).toMatch(/^Priority of token 2, .+, changed\.$/),
    );
    expect(screen.queryByRole('heading', { name: /^Priority of token/ })).not.toBeInTheDocument();
    // Ahead of every token with no priority, and of the later ones with one: it was issued first.
    await waitFor(() =>
      expect(tokensIn('Waiting')).toEqual([
        'Token 2',
        'Token 4',
        'Token 1',
        'Token 3',
        'Token 1',
        'Token 2',
      ]),
    );
    expect(mockQueueToken(`qt_${TENANT_IDS.hospital}_dep_h_01_2`)?.priority).toBe('child');
  });

  it('says so when someone else changed the token first, and shows it as it is now', async () => {
    await openBoard();
    await waitFor(() => expect(tokensIn('Now serving')).toHaveLength(1));
    // Another desk skipped the patient meanwhile, unheard by this board.
    server.use(http.get('*/api/queue/events', () => new HttpResponse(null, { status: 403 })));
    const token = mockQueueToken(`qt_${TENANT_IDS.hospital}_dep_h_01_1`);
    if (!token) throw new Error('No token');
    token.status = 'skipped';
    token.version += 1;
    const serving = within(grid('Now serving')).getAllByRole('row')[1] as HTMLElement;
    await userEvent.click(within(serving).getByRole('button', { name: /^Skip/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone else changed this token first.',
    );
    await waitFor(() => expect(tokensIn('Skipped')).toEqual(['Token 1', 'Token 5']));
  });
});

describe('live updates', () => {
  it('shows a token issued at another desk within seconds, without being asked', async () => {
    await openBoard();
    await waitFor(() => expect(tokensIn('Waiting')).toHaveLength(6));
    expect(mockQueueStreams(TENANT_IDS.hospital)).toBe(1);

    addMockQueueToken(lateToken(TENANT_IDS.hospital, 'dep_h_02'));
    await waitFor(() => expect(tokensIn('Waiting')).toHaveLength(7));
  });

  it('opens the stream again when the server closes it, and reads what changed meanwhile', async () => {
    await openBoard();
    await waitFor(() => expect(tokensIn('Waiting')).toHaveLength(6));
    dropMockQueueStreams(TENANT_IDS.hospital);
    expect(
      await screen.findByText('Reconnecting. Meanwhile the queue refreshes every 15 seconds.'),
    ).toBeInTheDocument();
    // Changed while the stream was down: no event reaches anyone.
    const token = mockQueueToken(`qt_${TENANT_IDS.hospital}_dep_h_02_2`);
    if (!token) throw new Error('No token');
    token.status = 'skipped';
    token.version += 1;

    await screen.findByText(LIVE, undefined, { timeout: 4_000 });
    await waitFor(() => expect(tokensIn('Waiting')).toHaveLength(5));
  });

  it('reads the queue once the stream is open, for what changed before it opened', async () => {
    let changed = false;
    server.use(
      http.get('*/api/queue/events', () => {
        // Skipped at another desk after the lists were read, before the stream opened: no event
        // ever tells of it. Nothing returned: the mock's own stream answers.
        const token = mockQueueToken(`qt_${TENANT_IDS.hospital}_dep_h_02_2`);
        if (token && !changed) {
          changed = true;
          token.status = 'skipped';
          token.version += 1;
        }
      }),
    );
    await openBoard();
    await waitFor(() => expect(tokensIn('Skipped')).toEqual(['Token 5', 'Token 2']));
    expect(tokensIn('Waiting')).toHaveLength(5);
  });

  it('follows only its own department’s events when it shows one department', async () => {
    const reads = watchReads();
    await openBoard();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Department' }), 'dep_h_02');
    await waitFor(() => expect(tokensIn('Waiting')).toEqual(['Token 1', 'Token 2']));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const before = reads.length;
    addMockQueueToken(lateToken(TENANT_IDS.hospital, 'dep_h_01'));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(reads.length).toBe(before);

    addMockQueueToken(lateToken(TENANT_IDS.hospital, 'dep_h_02'));
    await waitFor(() => expect(tokensIn('Waiting')).toEqual(['Token 1', 'Token 2', 'Token 3']));
  });

  it('says when live updates are not available, and still shows the queue', async () => {
    server.use(http.get('*/api/queue/events', () => new HttpResponse(null, { status: 403 })));
    renderApp({ entry: '/queue' });
    expect(
      await screen.findByText(
        'Live updates are not available. The queue refreshes every 15 seconds.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(tokensIn('Waiting')).toHaveLength(6));
  });

  it('stops following the events on leaving the screen', async () => {
    const reads = watchReads();
    const { router } = await openBoard();
    await waitFor(() => expect(tokensIn('Waiting')).toHaveLength(6));
    await router.navigate('/');
    await screen.findByRole('heading', { name: 'Hospital management system' });
    const before = reads.length;
    addMockQueueToken(lateToken(TENANT_IDS.hospital, 'dep_h_01'));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(reads.length).toBe(before);
  });
});

describe('access', () => {
  it('opens to a custom role given queue:read, with nothing to do there', async () => {
    signIn(USER_IDS.billingClerk);
    grantPermission(TENANT_IDS.clinic, 'billing_clerk', 'queue:read');
    await openBoard();
    await waitFor(() => expect(tokensIn('Waiting')).toEqual(['Token 1', 'Token 2']));
    expect(screen.queryByRole('button', { name: /^Call next/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Change priority/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Issue a token' })).not.toBeInTheDocument();
  });

  it('is not open to that custom role without it', async () => {
    signIn(USER_IDS.billingClerk);
    renderApp({ entry: '/queue' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('offers no calling without queue:call', async () => {
    signIn(USER_IDS.receptionist);
    await openBoard();
    await waitFor(() => expect(tokensIn('Waiting')).toEqual(['Token 1', 'Token 2']));
    expect(screen.queryByRole('button', { name: /^Call next/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Skip/ })).not.toBeInTheDocument();
    // The desk issues tokens.
    expect(screen.getByRole('link', { name: 'Issue a token' })).toBeInTheDocument();
  });

  it('is not open without queue:read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'queue:read');
    renderApp({ entry: '/queue' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is unreachable with the queue switched off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'queue', false);
    renderApp({ entry: '/queue' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'OPD queue' })).not.toBeInTheDocument();
  });
});

describe('two hospitals', () => {
  it('never shows one hospital’s queue in the other, and follows only its own events', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const { queryClient } = await openBoard();
    const opened = mockQueueStreams(TENANT_IDS.hospital);
    expect(opened).toBe(1);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await screen.findByRole('heading', { name: 'Hospital management system' });
    expect(
      queryClient.getQueryCache().findAll({ queryKey: queueKeys.all(TENANT_IDS.hospital) }),
    ).toEqual([]);

    await userEvent.click(await screen.findByRole('link', { name: 'OPD queue' }));
    await screen.findByText(LIVE);
    expect(mockQueueStreams(TENANT_IDS.clinic)).toBe(1);
    // The sample doctor's own queue at the clinic is empty; the clinic has two waiting.
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Doctor' }), 'All doctors');
    await waitFor(() => expect(tokensIn('Waiting')).toEqual(['Token 1', 'Token 2']));

    // No new stream for the hospital, and a change there is not heard at the clinic.
    expect(mockQueueStreams(TENANT_IDS.hospital)).toBe(opened);
    // Past the one read the clinic's stream asks for when it opens.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const reads = watchReads();
    addMockQueueToken(lateToken(TENANT_IDS.hospital, 'dep_h_01'));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(reads).toEqual([]);
    // A change at the clinic is.
    addMockQueueToken(lateToken(TENANT_IDS.clinic, 'dep_c_01'));
    await waitFor(() => expect(tokensIn('Waiting')).toEqual(['Token 1', 'Token 2', 'Token 3']));
  });
});
