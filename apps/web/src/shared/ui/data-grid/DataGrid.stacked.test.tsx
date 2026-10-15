import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { maskMrn, maskPhone } from '@/shared/utils/mask';
import { expectNoAxeViolations } from '@/test/axe';
import { renderWithProviders } from '@/test/render';
import { DataGrid, STACKED_BELOW_PX, type GridAction, type GridColumn } from '.';

/**
 * The grid on a narrow screen: each row as a card, nothing that needs a table's width. The table
 * layout and everything the two share (masks, access, paging) is in DataGrid.test.tsx.
 */

interface Person {
  id: string;
  name: string;
  phone: string;
  mrn: string;
  balance: number;
}

const people = (count: number): Person[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Person ${index + 1}`,
    phone: `+91 98765 4${String(3000 + index).padStart(4, '0')}`,
    mrn: `MRN-TEST-${String(index + 1).padStart(5, '0')}`,
    balance: (index + 1) * 100,
  }));

const columns: GridColumn<Person>[] = [
  { id: 'name', header: 'Name', value: (row) => row.name, sortable: true, hideable: false },
  { id: 'phone', header: 'Phone', value: (row) => row.phone, mask: maskPhone },
  { id: 'mrn', header: 'MRN', value: (row) => row.mrn, mask: maskMrn, sortable: true },
  { id: 'balance', header: 'Balance', value: (row) => row.balance, requires: 'billing:read' },
];

function Grid(props: Partial<Parameters<typeof DataGrid<Person>>[0]>) {
  return (
    <DataGrid<Person>
      label="People"
      columns={columns}
      rows={people(3)}
      rowId={(row) => row.id}
      rowLabel={(row) => row.name}
      status="ready"
      emptyMessage="Nobody here yet."
      layout="stacked"
      {...props}
    />
  );
}

const list = () => screen.findByRole('list', { name: 'People' });
const cards = async () => within(await list()).getAllByRole('listitem');

describe('<DataGrid> on a narrow screen', () => {
  it('shows each row as a card: the first column as its title, the rest as labelled lines', async () => {
    renderWithProviders(
      <main>
        <Grid />
      </main>,
    );
    const [first] = await cards();

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(await cards()).toHaveLength(3);
    expect(within(first!).getByText('Person 1')).toBeInTheDocument();
    const terms = within(first!)
      .getAllByRole('term')
      .map((term) => term.textContent);
    expect(terms).toEqual(['Phone', 'MRN', 'Balance']);
    expect(within(first!).getByText('100')).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('labels every value with its column, the title too, and gives each card its place in the whole list', async () => {
    renderWithProviders(
      <main>
        <Grid total={1000} />
      </main>,
    );
    const [first, second] = await cards();
    // The title says its column to a screen reader only; the others have theirs on screen.
    expect(within(first!).getByText('Name:')).toHaveClass('sr-only');
    expect(first).toHaveAttribute('aria-setsize', '1000');
    expect(second).toHaveAttribute('aria-posinset', '2');
    await expectNoAxeViolations();
  });

  it('keeps masked values masked and leaves out a column the user may not see', async () => {
    renderWithProviders(<Grid />, { session: undefined });
    const [first] = await cards();

    expect(within(first!).getByText('•••••••••3000')).toBeInTheDocument();
    expect(first!.textContent).not.toContain('98765');
    expect(first!.textContent).not.toContain('MRN-TEST');
  });

  it('offers the row actions as buttons that name the row', async () => {
    const onSelect = vi.fn();
    const actions: GridAction<Person>[] = [{ id: 'open', label: 'Open', onSelect }];
    renderWithProviders(<Grid actions={actions} />);
    const [, second] = await cards();

    await userEvent.click(within(second!).getByRole('button', { name: 'Open: Person 2' }));

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }));
  });

  it('offers the sort as a list to choose from, since there are no column headers to press', async () => {
    const onSortChange = vi.fn();
    renderWithProviders(<Grid onSortChange={onSortChange} sort={{ id: 'name', desc: false }} />);
    const select = await screen.findByRole('combobox', { name: 'Sort by' });

    expect(select).toHaveValue('asc:name');
    expect(within(select).getAllByRole('option')).toHaveLength(5);
    await userEvent.selectOptions(select, 'MRN, descending');
    await userEvent.selectOptions(select, 'Default order');

    expect(onSortChange).toHaveBeenNthCalledWith(1, { id: 'mrn', desc: true });
    expect(onSortChange).toHaveBeenNthCalledWith(2, null);
  });

  it('shows the sort the list has even when its column is not one to choose here', async () => {
    // Sorted by a column that is not sortable from the grid, e.g. a default the screen applies.
    renderWithProviders(<Grid onSortChange={vi.fn()} sort={{ id: 'phone', desc: true }} />);
    const select = await screen.findByRole('combobox', { name: 'Sort by' });

    expect(select).toHaveValue('desc:phone');
    expect(within(select).getByRole('option', { name: 'Phone, descending' })).toBeInTheDocument();
  });

  it('keeps the first column as the title of every card and out of the Columns menu', async () => {
    const hideableFirst = columns.map((column) =>
      column.id === 'name' ? { ...column, hideable: true } : column,
    );
    renderWithProviders(<Grid columns={hideableFirst} />);
    const [first] = await cards();

    await userEvent.click(screen.getByText('Columns', { selector: 'summary' }));

    expect(screen.queryByRole('checkbox', { name: 'Name' })).not.toBeInTheDocument();
    expect(within(first!).getByText('Person 1')).toBeInTheDocument();
  });

  it('has no sort control when the screen cannot sort', async () => {
    renderWithProviders(<Grid />);
    await list();

    expect(screen.queryByRole('combobox', { name: 'Sort by' })).not.toBeInTheDocument();
  });

  it('lets a column be hidden from the cards', async () => {
    renderWithProviders(<Grid />);
    await list();

    await userEvent.click(screen.getByText('Columns', { selector: 'summary' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Phone' }));

    expect(screen.queryByText('Phone', { selector: 'dt' })).not.toBeInTheDocument();
    expect(screen.getAllByText('MRN', { selector: 'dt' })).toHaveLength(3);
  });

  it('shows the loading, empty and error states without a table', async () => {
    const onRetry = vi.fn();
    const { rerender } = renderWithProviders(<Grid status="loading" rows={[]} />);
    expect(await list()).toHaveAttribute('aria-busy', 'true');

    rerender(<Grid rows={[]} />);
    expect(await screen.findByText('Nobody here yet.')).toBeInTheDocument();

    rerender(<Grid status="error" rows={[]} errorMessage="Could not load." onRetry={onRetry} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('asks for more rows from the same button as the table does', async () => {
    const onLoadMore = vi.fn();
    renderWithProviders(<Grid hasNextPage onLoadMore={onLoadMore} />);
    await list();

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(onLoadMore).toHaveBeenCalledOnce();
  });
});

describe('<DataGrid> choosing its layout', () => {
  /** A ResizeObserver the test drives, reporting the width of the grid's container. */
  function stubWidth() {
    // The grid watches its own container, and so does the list virtualiser inside it. Every
    // observer is told; one that wants more than a width ignores what it is given.
    const observers: ((width: number) => void)[] = [];
    const report = (width: number) => {
      for (const tell of observers) tell(width);
    };
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push((width) => {
            try {
              callback(
                [{ contentRect: { width } } as ResizeObserverEntry],
                this as unknown as ResizeObserver,
              );
            } catch {
              // Not the grid's own observer.
            }
          });
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    return (width: number) => act(() => report(width));
  }

  afterEach(() => vi.unstubAllGlobals());

  it('follows the width of its container: cards when narrow, a table when wide', async () => {
    const setWidth = stubWidth();
    renderWithProviders(<Grid layout="auto" />);
    expect(await screen.findByRole('table', { name: 'People' })).toBeInTheDocument();

    setWidth(STACKED_BELOW_PX - 1);
    expect(await list()).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    setWidth(STACKED_BELOW_PX);
    expect(await screen.findByRole('table', { name: 'People' })).toBeInTheDocument();
  });

  it('stays a table when a screen asks for one, however narrow', async () => {
    const setWidth = stubWidth();
    renderWithProviders(<Grid layout="table" />);

    setWidth(320);

    expect(await screen.findByRole('table', { name: 'People' })).toBeInTheDocument();
  });

  it('keeps only the cards in view in the DOM for a long list', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(360);
    stubWidth();
    try {
      renderWithProviders(<Grid rows={people(2000)} />);
      const rendered = (await cards()).filter((card) => card.hasAttribute('data-index'));
      // A screen reader is told the size of the whole list, not of what is rendered.
      expect(rendered[0]).toHaveAttribute('aria-setsize', '2000');
      expect(rendered[0]).toHaveAttribute('aria-posinset', '1');

      expect(rendered.length).toBeGreaterThan(3);
      expect(rendered.length).toBeLessThan(60);
      expect(screen.queryByText('Person 2000')).not.toBeInTheDocument();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
