import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { signIn, USER_IDS } from '@/mocks/db';
import { maskMrn, maskPhone } from '@/shared/utils/mask';
import { expectNoAxeViolations } from '@/test/axe';
import { renderWithProviders } from '@/test/render';
import { DataGrid, type GridAction, type GridColumn, type GridSort } from '.';

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
  // Field-level access: only roles that may see billing get this column at all.
  {
    id: 'balance',
    header: 'Balance',
    value: (row) => row.balance,
    align: 'end',
    requires: 'billing:read',
  },
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
      {...props}
    />
  );
}

const grid = () => screen.findByRole('table', { name: 'People' });
const headers = () => screen.getAllByRole('columnheader').map((cell) => cell.textContent);
const bodyRows = () => screen.getAllByRole('row').slice(1);

describe('<DataGrid>', () => {
  it('renders the rows it was given, as an accessible table', async () => {
    // In a landmark, as it is on a real screen.
    renderWithProviders(
      <main>
        <Grid />
      </main>,
    );
    await grid();
    expect(headers()).toEqual(['Name', 'Phone', 'MRN', 'Balance']);
    expect(bodyRows()).toHaveLength(3);
    expect(within(bodyRows()[0] as HTMLElement).getByText('Person 1')).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  describe('masked columns', () => {
    it('shows sensitive values masked, never in full', async () => {
      renderWithProviders(<Grid />);
      await grid();
      const row = bodyRows()[0] as HTMLElement;
      expect(within(row).getByText('•••••••••3000')).toBeInTheDocument();
      expect(within(row).getByText('•••••••••••001')).toBeInTheDocument();
      expect(document.body).not.toHaveTextContent('98765');
      expect(document.body).not.toHaveTextContent('MRN-TEST');
    });

    it('passes the masked text, not the original, to a custom cell', async () => {
      const withRender: GridColumn<Person>[] = [
        {
          id: 'phone',
          header: 'Phone',
          value: (row) => row.phone,
          mask: maskPhone,
          render: (_row, text) => <code>{text}</code>,
        },
      ];
      renderWithProviders(<Grid columns={withRender} />);
      await grid();
      expect(document.body).not.toHaveTextContent('98765');
    });
  });

  describe('field-level access', () => {
    it('leaves out a column the role may not see', async () => {
      // The billing clerk holds billing:read; a role without it gets no Balance column at all.
      signIn(USER_IDS.billingClerk);
      const first = renderWithProviders(<Grid />);
      await grid();
      expect(headers()).toContain('Balance');
      first.unmount();

      renderWithProviders(<Grid />, { session: null });
      await grid();
      expect(headers()).toEqual(['Name', 'Phone', 'MRN']);
      expect(screen.queryByText('100')).not.toBeInTheDocument();
    });
  });

  describe('row actions', () => {
    const onArchive = vi.fn();
    const onRefund = vi.fn();
    const actions: GridAction<Person>[] = [
      { id: 'open', label: 'Open', onSelect: vi.fn() },
      { id: 'archive', label: 'Archive', onSelect: onArchive, requires: 'notice:manage' },
      {
        id: 'refund',
        label: 'Refund',
        onSelect: onRefund,
        requires: 'billing:refund',
        disabled: (row) => row.balance < 200,
      },
      {
        id: 'lab',
        label: 'Lab',
        onSelect: vi.fn(),
        requires: 'patient:read',
        featureFlag: 'laboratory',
      },
    ];

    it('offers each action only to roles that hold its permission', async () => {
      renderWithProviders(<Grid actions={actions} />);
      await grid();
      const row = bodyRows()[1] as HTMLElement;
      // The hospital admin holds every permission used here, and the lab module is on.
      expect(
        within(row)
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual(['Open', 'Archive', 'Refund', 'Lab']);

      await userEvent.click(within(row).getByRole('button', { name: 'Archive: Person 2' }));
      expect(onArchive).toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }));
    });

    it('hides actions whose permission or module the user lacks', async () => {
      // The billing clerk works at the clinic: no notice:manage, no refunds, and the lab is off.
      signIn(USER_IDS.billingClerk);
      renderWithProviders(<Grid actions={actions} />);
      await grid();
      const row = bodyRows()[0] as HTMLElement;
      expect(
        within(row)
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual(['Open']);
    });

    it('has no actions column when the user may use none of them', async () => {
      signIn(USER_IDS.billingClerk);
      renderWithProviders(<Grid actions={actions.filter((action) => action.requires)} />);
      await grid();
      expect(headers()).not.toContain('Actions');
      expect(within(bodyRows()[0] as HTMLElement).queryByRole('button')).not.toBeInTheDocument();
    });

    it('disables an action for the rows it does not apply to', async () => {
      renderWithProviders(<Grid actions={actions} />);
      await grid();
      expect(screen.getByRole('button', { name: 'Refund: Person 1' })).toBeUnavailable();
      expect(screen.getByRole('button', { name: 'Refund: Person 2' })).not.toBeUnavailable();
    });
  });

  describe('server-side sorting', () => {
    function Sortable({ onSort }: { onSort: (sort: GridSort | null) => void }) {
      const [sort, setSort] = useState<GridSort | null>(null);
      return (
        <Grid
          sort={sort}
          onSortChange={(next) => {
            setSort(next);
            onSort(next);
          }}
        />
      );
    }

    it('asks for ascending, then descending, then no sort, and never reorders rows itself', async () => {
      const onSort = vi.fn();
      renderWithProviders(<Sortable onSort={onSort} />);
      await grid();
      const header = screen.getByRole('columnheader', { name: 'Name' });
      const names = () => bodyRows().map((row) => within(row).getAllByRole('cell')[0]?.textContent);
      expect(header).toHaveAttribute('aria-sort', 'none');

      await userEvent.click(within(header).getByRole('button'));
      expect(onSort).toHaveBeenLastCalledWith({ id: 'name', desc: false });
      expect(header).toHaveAttribute('aria-sort', 'ascending');

      await userEvent.click(within(header).getByRole('button'));
      expect(onSort).toHaveBeenLastCalledWith({ id: 'name', desc: true });
      expect(header).toHaveAttribute('aria-sort', 'descending');
      // Still in the order the server gave them: sorting is the server's job.
      expect(names()).toEqual(['Person 1', 'Person 2', 'Person 3']);

      await userEvent.click(within(header).getByRole('button'));
      expect(onSort).toHaveBeenLastCalledWith(null);
    });

    it('sorts from the keyboard', async () => {
      const onSort = vi.fn();
      renderWithProviders(<Sortable onSort={onSort} />);
      await grid();
      within(screen.getByRole('columnheader', { name: 'MRN' }))
        .getByRole('button')
        .focus();
      await userEvent.keyboard('{Enter}');
      expect(onSort).toHaveBeenLastCalledWith({ id: 'mrn', desc: false });
    });

    it('offers no sort control on a column the server cannot sort by', async () => {
      renderWithProviders(<Sortable onSort={vi.fn()} />);
      await grid();
      const phone = screen.getByRole('columnheader', { name: 'Phone' });
      expect(within(phone).queryByRole('button')).not.toBeInTheDocument();
      expect(phone).not.toHaveAttribute('aria-sort');
    });
  });

  describe('column visibility', () => {
    it('lets the user hide and show hideable columns', async () => {
      renderWithProviders(<Grid />);
      await grid();
      await userEvent.click(screen.getByText('Columns', { selector: 'summary' }));
      const menu = screen.getByRole('group', { name: 'Columns' });
      // Name is not hideable, so it is not offered.
      expect(
        within(menu)
          .getAllByRole('checkbox')
          .map((box) => box.closest('label')?.textContent),
      ).toEqual(['Phone', 'MRN', 'Balance']);

      await userEvent.click(within(menu).getByRole('checkbox', { name: 'Phone' }));
      expect(headers()).toEqual(['Name', 'MRN', 'Balance']);
      expect(screen.queryByText('•••••••••3000')).not.toBeInTheDocument();

      await userEvent.click(within(menu).getByRole('checkbox', { name: 'Phone' }));
      expect(headers()).toEqual(['Name', 'Phone', 'MRN', 'Balance']);
    });
  });

  describe('states', () => {
    it('shows placeholders while loading', async () => {
      renderWithProviders(<Grid status="loading" rows={[]} />);
      expect(await grid()).toHaveAttribute('aria-busy', 'true');
      expect(screen.queryByText('Nobody here yet.')).not.toBeInTheDocument();
    });

    it('shows the empty message', async () => {
      renderWithProviders(<Grid rows={[]} />);
      await grid();
      expect(screen.getByText('Nobody here yet.')).toBeInTheDocument();
    });

    it('shows an error with a retry', async () => {
      const onRetry = vi.fn();
      renderWithProviders(
        <Grid status="error" rows={[]} errorMessage="The system is busy." onRetry={onRetry} />,
      );
      await grid();
      expect(screen.getByRole('alert')).toHaveTextContent('The system is busy.');
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });
  });

  describe('paging', () => {
    it('asks for the next page and cannot be asked twice while it loads', async () => {
      const onLoadMore = vi.fn();
      const view = renderWithProviders(<Grid hasNextPage onLoadMore={onLoadMore} />);
      await grid();
      await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
      expect(onLoadMore).toHaveBeenCalledTimes(1);

      view.rerender(<Grid hasNextPage onLoadMore={onLoadMore} loadingMore />);
      expect(screen.getByRole('button', { name: 'Loading more…' })).toBeUnavailable();
    });

    it('offers no more pages on the last one', async () => {
      renderWithProviders(<Grid hasNextPage={false} onLoadMore={vi.fn()} />);
      await grid();
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    });
  });

  describe('virtualisation', () => {
    it('keeps only the rows in view in the DOM for a long list', async () => {
      // jsdom has no layout. Give the scroll area a height so the virtualiser has a viewport.
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(440);
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
      try {
        renderWithProviders(<Grid rows={people(2000)} />);
        const table = await grid();
        // The whole list is announced, though only a screenful is rendered.
        expect(table).toHaveAttribute('aria-rowcount', '2001');
        const rendered = screen
          .getAllByRole('row')
          .filter((row) => row.getAttribute('aria-rowindex'));
        expect(rendered.length).toBeGreaterThan(5);
        expect(rendered.length).toBeLessThan(60);
        expect(screen.getByText('Person 1')).toBeInTheDocument();
        expect(screen.queryByText('Person 2000')).not.toBeInTheDocument();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('renders every row of a short list', async () => {
      renderWithProviders(<Grid rows={people(100)} />);
      const table = await grid();
      expect(table).not.toHaveAttribute('aria-rowcount');
      expect(bodyRows()).toHaveLength(100);
    });
  });
});

describe('<DataGrid> for a screen reader', () => {
  // The grid's own live region: said once when it changes, never moving focus.
  const announced = () => document.querySelector('[aria-live="polite"]')?.textContent;

  it('gives each row its place in the whole list when more rows are on the server', async () => {
    renderWithProviders(
      <main>
        <Grid total={1000} hasNextPage onLoadMore={vi.fn()} />
      </main>,
    );
    const table = await grid();
    // The header row is row 1, so the first row of data is row 2 of 1,001.
    expect(table).toHaveAttribute('aria-rowcount', '1001');
    expect(screen.getAllByRole('row').map((row) => row.getAttribute('aria-rowindex'))).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
    await expectNoAxeViolations();
  });

  it('ignores a total smaller than the rows loaded', async () => {
    renderWithProviders(<Grid total={2} />);
    expect(await grid()).not.toHaveAttribute('aria-rowcount');
  });

  it('announces loading, nothing found and the sort, and leaves focus where it was', async () => {
    const view = renderWithProviders(<Grid status="loading" rows={[]} />);
    await grid();
    expect(announced()).toBe('Loading…');

    view.rerender(<Grid onSortChange={vi.fn()} />);
    // How many rows there are is the screen's to say, in its own words: not said twice.
    expect(announced()).toBe('');
    const button = within(screen.getByRole('columnheader', { name: 'Name' })).getByRole('button');
    button.focus();
    view.rerender(<Grid onSortChange={vi.fn()} sort={{ id: 'name', desc: false }} />);
    expect(announced()).toBe('Sorted by Name, ascending.');
    expect(button).toHaveFocus();

    view.rerender(<Grid onSortChange={vi.fn()} hasNextPage onLoadMore={vi.fn()} loadingMore />);
    expect(announced()).toBe('Loading more…');

    view.rerender(<Grid rows={[]} />);
    expect(announced()).toBe('No rows to show.');
  });

  it('leaves an error to its alert, so it is said once', async () => {
    renderWithProviders(<Grid status="error" rows={[]} errorMessage="The system is busy." />);
    await grid();
    expect(screen.getByRole('alert')).toHaveTextContent('The system is busy.');
    expect(announced()).toBe('');
  });

  it('names the row in an action by its first column when the screen gives no row label', async () => {
    renderWithProviders(
      <Grid rowLabel={undefined} actions={[{ id: 'open', label: 'Open', onSelect: vi.fn() }]} />,
    );
    await grid();
    expect(screen.getByRole('button', { name: 'Open: Person 2' })).toBeInTheDocument();
  });

  it('reaches a link in a row and the row actions after it from the keyboard', async () => {
    const onArchive = vi.fn();
    const linked: GridColumn<Person>[] = [
      {
        id: 'name',
        header: 'Name',
        value: (row) => row.name,
        hideable: false,
        render: (row, text) => <a href={`#${row.id}`}>{text}</a>,
      },
    ];
    renderWithProviders(
      <Grid
        rows={people(2)}
        columns={linked}
        actions={[{ id: 'archive', label: 'Archive', onSelect: onArchive }]}
      />,
    );
    await grid();
    await userEvent.tab();
    expect(screen.getByRole('link', { name: 'Person 1' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Archive: Person 1' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onArchive).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
    await userEvent.tab();
    expect(screen.getByRole('link', { name: 'Person 2' })).toHaveFocus();
  });
});

describe('masks', () => {
  it('keeps only the last characters readable', () => {
    expect(maskPhone('+91 98765 43210')).toBe('•••••••••3210');
    expect(maskMrn('MRN-TEST-00042')).toBe('•••••••••••042');
    // A value too short to mask partially is hidden entirely.
    expect(maskMrn('42')).toBe('••');
    expect(maskPhone('')).toBe('');
  });
});
