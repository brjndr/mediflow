import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

/**
 * The example pages double as integration tests of the building blocks: here each block runs
 * inside the real app, against the mock backend, behind the feature registry.
 */

const bodyRows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1);
const firstNames = (count: number) =>
  bodyRows()
    .slice(0, count)
    .map((row) => within(row).getAllByRole('cell')[0]?.textContent);

/** Records the query string of each request for example people. */
function watchPeopleRequests() {
  const requests: string[] = [];
  server.use(
    http.get('*/api/examples/people', ({ request }) => {
      requests.push(new URL(request.url).search);
      return undefined;
    }),
  );
  return requests;
}

beforeEach(() => {
  // The chart library needs this observer to exist. jsdom does not have it.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('example pages', () => {
  it('lists the four building blocks and links to each', async () => {
    const { router } = renderApp({ entry: '/examples' });
    expect(
      await screen.findByRole('heading', { name: 'Shared building blocks' }),
    ).toBeInTheDocument();
    const links = within(screen.getByRole('main')).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Data grid',
      'Charts',
      'Form kit',
      'Rich text',
    ]);
    await expectNoAxeViolations();

    await userEvent.click(screen.getByRole('link', { name: 'Form kit' }));
    expect(await screen.findByRole('heading', { name: 'Form kit', level: 1 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/examples/form');
  });

  it('is unreachable where the module is off', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    renderApp({ entry: '/examples/grid' });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeInTheDocument();
  });
});

describe('grid example', () => {
  it('loads a page, asks the server to sort, and pages by cursor', async () => {
    const requests = watchPeopleRequests();
    renderApp({ entry: '/examples/grid' });
    await waitFor(() => expect(bodyRows()).toHaveLength(50));
    expect(screen.getByRole('status')).toHaveTextContent('50 rows loaded');
    expect(firstNames(2)).toEqual(['Asha Verma 1', 'Bilal Silva 2']);

    // Sorting is a new server query from the first page, never a client-side reorder.
    const mrn = screen.getByRole('columnheader', { name: 'MRN' });
    await userEvent.click(within(mrn).getByRole('button'));
    await waitFor(() => expect(mrn).toHaveAttribute('aria-sort', 'ascending'));
    // MRNs were issued in reverse, so ascending MRN starts from the last person.
    await waitFor(() => expect(firstNames(1)).toEqual(['Jaya Nair 520']));

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('100 rows loaded'));

    expect(requests).toEqual([
      '?limit=50',
      '?limit=50&sort=mrn',
      '?limit=50&cursor=exh_0470&sort=mrn',
    ]);
  });

  it('masks phone numbers and MRNs', async () => {
    renderApp({ entry: '/examples/grid' });
    await waitFor(() => expect(bodyRows()).toHaveLength(50));
    const cells = within(bodyRows()[0] as HTMLElement).getAllByRole('cell');
    expect(cells[2]).toHaveTextContent(/^•+0000$/);
    expect(cells[3]).toHaveTextContent(/^•+520$/);
    expect(screen.getByRole('table')).not.toHaveTextContent('MRN-EX');
    expect(screen.getByRole('table')).not.toHaveTextContent('90000');
  });

  it('shows the billing column and the refund action only to roles that hold them', async () => {
    // The hospital admin may see billing and refund.
    const admin = renderApp({ entry: '/examples/grid' });
    await waitFor(() => expect(bodyRows()).toHaveLength(50));
    expect(screen.getByRole('columnheader', { name: 'Balance' })).toBeInTheDocument();
    // Amounts are formatted for the hospital: rupees, with Indian digit grouping.
    expect(within(bodyRows()[1] as HTMLElement).getByText('₹246.90')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refund: Bilal Silva 2' })).toBeEnabled();
    // Nothing to refund on a zero balance.
    expect(screen.getByRole('button', { name: 'Refund: Asha Verma 1' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Open: Bilal Silva 2' }));
    expect(screen.getByRole('status')).toHaveTextContent('Last action: Open on Bilal Silva 2');
    admin.unmount();

    // A doctor may see billing but not refund.
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/examples/grid' });
    await waitFor(() => expect(bodyRows()).toHaveLength(50));
    expect(screen.getByRole('columnheader', { name: 'Balance' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Refund/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open: Bilal Silva 2' })).toBeInTheDocument();
  });
});

describe('charts example', () => {
  it('renders both charts with values formatted for the hospital', async () => {
    renderApp({ entry: '/examples/charts' });
    const visits = await screen.findByRole('table', { name: 'Visits per day' });
    expect(within(visits).getAllByRole('rowheader')[0]).toHaveTextContent('1 Oct 2026');
    const departments = await screen.findByRole('table', { name: 'Visits by department' });
    expect(
      within(departments)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Cardiology', 'Neurology', 'Orthopaedics', 'Paediatrics']);
  });
});

describe('form example', () => {
  it('validates with translated messages, then shows the parsed values', async () => {
    renderApp({ entry: '/examples/form' });
    await screen.findByRole('heading', { name: 'Form kit', level: 1 });

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((alert) => alert.textContent)).toEqual([
      'This field is required.',
      'This value is not in the expected format.',
      'This field is required.',
      'This field is required.',
    ]);
    expect(screen.queryByRole('heading', { name: 'Submitted values' })).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/^Full name/), '  Test Person  ');
    await userEvent.type(screen.getByLabelText(/^Email/), 'person@example.test');
    await userEvent.selectOptions(screen.getByLabelText(/^Department/), 'neurology');
    await userEvent.click(screen.getByLabelText('Consent recorded'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const submitted = await screen.findByRole('region', { name: 'Submitted values' });
    // The schema trimmed the name and turned the age into a number.
    expect(JSON.parse(submitted.querySelector('pre')?.textContent ?? '{}')).toEqual({
      name: 'Test Person',
      email: 'person@example.test',
      age: 30,
      department: 'neurology',
      notes: '',
      consent: true,
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('editor example', () => {
  it('shows the editor and a live preview of the same document', async () => {
    renderApp({ entry: '/examples/editor' });
    const editor = await screen.findByRole('textbox', { name: 'Example note' });
    expect(editor).toHaveTextContent('Formatting is stored as a document, never as HTML.');
    const preview = screen.getByRole('region', { name: 'Preview' });
    expect(
      within(preview).getByRole('heading', { name: 'Example note', level: 2 }),
    ).toBeInTheDocument();
    expect(within(preview).getByText('document').closest('strong')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('63 characters of text');
  });
});
