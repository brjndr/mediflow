import {
  columnVisibilityFeature,
  createColumnHelper,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type SortingState,
  type ColumnVisibilityState,
  type RowData,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isAllowed, useAccessPolicy } from '@/access';
import { cn } from '@/shared/lib/utils';
import type { Permission } from '@/shared/types';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';

/**
 * The app's data grid. Screens describe their columns with GridColumn and never touch the table
 * library directly, so the library can change without the screens changing.
 *
 * It is a server-side grid: the screen gives it the rows it has loaded and is told when the user
 * asks for a different sort or for more rows. It never sorts, filters or pages data itself, and
 * it never needs the full dataset.
 */

export interface GridColumn<Row> {
  id: string;
  /** Already translated. */
  header: string;
  /** The cell's text. Also what a mask is applied to. */
  value: (row: Row) => string | number | null | undefined;
  /** Custom cell content. Receives the (masked) text. */
  render?: (row: Row, text: string) => ReactNode;
  /** The server can sort by this column. */
  sortable?: boolean;
  /** The user may hide it from the Columns menu. Default true. */
  hideable?: boolean;
  /** Shown masked in the grid, e.g. `maskPhone`. */
  mask?: (text: string) => string;
  /** Field-level access: the column exists only for users who hold this permission. */
  requires?: Permission;
  align?: 'start' | 'end';
}

export interface GridSort {
  id: string;
  desc: boolean;
}

export interface GridAction<Row> {
  id: string;
  /** Already translated. Describe the action; the row is added for screen readers. */
  label: string;
  onSelect: (row: Row) => void;
  /** The action is offered only to users who hold this permission. */
  requires?: Permission;
  featureFlag?: string;
  disabled?: (row: Row) => boolean;
}

interface DataGridProps<Row> {
  /** Names the table for assistive technology. */
  label: string;
  columns: GridColumn<Row>[];
  rows: Row[];
  rowId: (row: Row) => string;
  /** Text that identifies a row to a screen reader, e.g. the patient's name. */
  rowLabel?: (row: Row) => string;
  status: 'loading' | 'error' | 'ready';
  errorMessage?: string;
  onRetry?: () => void;
  emptyMessage: string;
  sort?: GridSort | null;
  onSortChange?: (sort: GridSort | null) => void;
  actions?: GridAction<Row>[];
  hasNextPage?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  /** Rows are virtualised (only those in view are in the DOM) above this many. */
  virtualizeAbove?: number;
}

const features = tableFeatures({ rowSortingFeature, columnVisibilityFeature });
const ROW_HEIGHT = 44;

export function DataGrid<Row extends RowData>({
  label,
  columns,
  rows,
  rowId,
  rowLabel,
  status,
  errorMessage,
  onRetry,
  emptyMessage,
  sort = null,
  onSortChange,
  actions = [],
  hasNextPage = false,
  onLoadMore,
  loadingMore = false,
  virtualizeAbove = 100,
}: DataGridProps<Row>) {
  const { t } = useTranslation();
  const policy = useAccessPolicy();
  const menuId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>({});

  // Columns and actions the user may not see are left out entirely, not hidden with CSS.
  // A column or action with no requirement of its own is available to whoever can see the grid;
  // the route guard already decided that. One that names a permission or a module is checked.
  const allowedColumns = useMemo(
    () =>
      columns.filter(
        (column) =>
          column.requires === undefined || isAllowed(policy, { requires: column.requires }),
      ),
    [columns, policy],
  );
  const allowedActions = useMemo(
    () =>
      actions.filter(
        (action) =>
          (action.requires === undefined && action.featureFlag === undefined) ||
          isAllowed(policy, { requires: action.requires, featureFlag: action.featureFlag }),
      ),
    [actions, policy],
  );

  const tableColumns = useMemo(() => {
    const helper = createColumnHelper<typeof features, Row>();
    return helper.columns(
      allowedColumns.map((column) =>
        // An accessor column, because the library only lets columns with a value be sorted.
        helper.accessor((row) => column.value(row), {
          id: column.id,
          header: column.header,
          enableSorting: column.sortable === true,
          enableHiding: column.hideable !== false,
        }),
      ),
    );
  }, [allowedColumns]);

  const sorting: SortingState = useMemo(() => (sort ? [sort] : []), [sort]);
  const table = useTable({
    features,
    columns: tableColumns,
    data: rows,
    getRowId: rowId,
    // The server sorts. The grid only records which sort was asked for.
    manualSorting: true,
    enableSortingRemoval: true,
    state: { sorting, columnVisibility },
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(sorting) : updater;
      onSortChange?.(next[0] ?? null);
    },
    onColumnVisibilityChange: setColumnVisibility,
  });

  const byId = useMemo(
    () => new Map(allowedColumns.map((column) => [column.id, column])),
    [allowedColumns],
  );
  const visibleColumns = table
    .getVisibleLeafColumns()
    .flatMap((column) => byId.get(column.id) ?? []);
  const hideable = table.getAllLeafColumns().filter((column) => column.getCanHide());
  const hasActions = allowedActions.length > 0;
  const columnCount = visibleColumns.length + (hasActions ? 1 : 0);

  const virtual = rows.length > virtualizeAbove;
  // The virtualizer returns functions that cannot be memoized safely, which the React Compiler
  // lint reports. Nothing here relies on that memoization.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    enabled: virtual,
  });
  const window = virtual ? virtualizer.getVirtualItems() : null;
  const first = window?.[0];
  const last = window?.[window.length - 1];
  const padTop = first ? first.start : 0;
  const padBottom = last ? virtualizer.getTotalSize() - last.end : 0;
  const shown = window
    ? window.map((item) => ({ row: rows[item.index], index: item.index }))
    : rows.map((row, index) => ({ row, index }));

  const text = (column: GridColumn<Row>, row: Row) => {
    const raw = column.value(row);
    const plain = raw === null || raw === undefined ? '' : String(raw);
    return column.mask && plain ? column.mask(plain) : plain;
  };

  return (
    <div className="flex flex-col gap-2">
      {hideable.length > 0 && (
        <details className="relative self-end">
          <summary className="cursor-pointer list-none rounded-md border px-3 py-1.5 text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50">
            {t('grid.columns')}
          </summary>
          <fieldset
            id={menuId}
            className="absolute right-0 z-10 mt-1 flex min-w-44 flex-col gap-1 rounded-md border bg-background p-2 shadow-md"
          >
            <legend className="sr-only">{t('grid.columns')}</legend>
            {hideable.map((column) => (
              <label key={column.id} className="flex items-center gap-2 px-1 py-0.5 text-sm">
                <input
                  type="checkbox"
                  checked={column.getIsVisible()}
                  onChange={column.getToggleVisibilityHandler()}
                />
                {byId.get(column.id)?.header}
              </label>
            ))}
          </fieldset>
        </details>
      )}

      <div
        ref={scroller}
        className={cn(
          'overflow-x-auto rounded-lg border',
          virtual && 'max-h-[32rem] overflow-y-auto',
        )}
      >
        <table
          aria-label={label}
          aria-busy={status === 'loading' || loadingMore}
          aria-rowcount={virtual ? rows.length + 1 : undefined}
          className="w-full border-collapse text-sm"
        >
          <thead className={cn('bg-background', virtual && 'sticky top-0 z-[1]')}>
            <tr className="border-b">
              {visibleColumns.map((column) => {
                const tableColumn = table.getColumn(column.id);
                const direction = tableColumn?.getIsSorted() ?? false;
                const canSort = tableColumn?.getCanSort() === true && onSortChange !== undefined;
                const SortIcon =
                  direction === 'asc' ? ArrowUp : direction === 'desc' ? ArrowDown : ArrowUpDown;
                return (
                  <th
                    key={column.id}
                    scope="col"
                    aria-sort={
                      !canSort
                        ? undefined
                        : direction === 'asc'
                          ? 'ascending'
                          : direction === 'desc'
                            ? 'descending'
                            : 'none'
                    }
                    className={cn(
                      'h-10 px-3 font-medium whitespace-nowrap',
                      column.align === 'end' ? 'text-right' : 'text-left',
                    )}
                  >
                    {canSort ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-sm outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        onClick={tableColumn?.getToggleSortingHandler()}
                      >
                        {column.header}
                        <SortIcon aria-hidden className="size-3.5 text-muted-foreground" />
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
              {hasActions && (
                <th scope="col" className="h-10 px-3 text-right font-medium">
                  <span className="sr-only">{t('grid.actions')}</span>
                </th>
              )}
            </tr>
          </thead>

          <tbody>
            {status === 'loading' &&
              Array.from({ length: 5 }, (_, index) => (
                <tr key={index} className="border-b last:border-0">
                  <td colSpan={columnCount} className="px-3 py-2">
                    <Skeleton className="h-5 w-full" />
                  </td>
                </tr>
              ))}

            {status === 'error' && (
              <tr>
                <td colSpan={columnCount} className="px-3 py-6">
                  <div role="alert" className="flex items-center justify-center gap-3">
                    <span>{errorMessage ?? t('errors.unknown')}</span>
                    {onRetry && (
                      <Button size="sm" variant="outline" onClick={onRetry}>
                        {t('grid.retry')}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            )}

            {status === 'ready' && rows.length === 0 && (
              <tr>
                <td colSpan={columnCount} className="px-3 py-8 text-center text-muted-foreground">
                  {emptyMessage}
                </td>
              </tr>
            )}

            {status === 'ready' && padTop > 0 && (
              <tr aria-hidden style={{ height: padTop }}>
                <td colSpan={columnCount} />
              </tr>
            )}
            {status === 'ready' &&
              shown.map(({ row, index }) => {
                if (row === undefined) return null;
                const name = rowLabel?.(row);
                return (
                  <tr
                    key={rowId(row)}
                    aria-rowindex={virtual ? index + 2 : undefined}
                    style={virtual ? { height: ROW_HEIGHT } : undefined}
                    className="border-b last:border-0 hover:bg-accent/50"
                  >
                    {visibleColumns.map((column) => {
                      const cellText = text(column, row);
                      return (
                        <td
                          key={column.id}
                          className={cn(
                            'px-3 py-2',
                            column.align === 'end' ? 'text-right tabular-nums' : 'text-left',
                          )}
                        >
                          {column.render ? column.render(row, cellText) : cellText}
                        </td>
                      );
                    })}
                    {hasActions && (
                      <td className="px-3 py-1 text-right whitespace-nowrap">
                        {allowedActions.map((action) => (
                          <Button
                            key={action.id}
                            size="sm"
                            variant="ghost"
                            disabled={action.disabled?.(row)}
                            aria-label={name ? `${action.label}: ${name}` : undefined}
                            onClick={() => action.onSelect(row)}
                          >
                            {action.label}
                          </Button>
                        ))}
                      </td>
                    )}
                  </tr>
                );
              })}
            {status === 'ready' && padBottom > 0 && (
              <tr aria-hidden style={{ height: padBottom }}>
                <td colSpan={columnCount} />
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {status === 'ready' && hasNextPage && onLoadMore && (
        <Button
          className="self-center"
          variant="outline"
          disabled={loadingMore}
          onClick={onLoadMore}
        >
          {loadingMore ? t('grid.loadingMore') : t('grid.loadMore')}
        </Button>
      )}
    </div>
  );
}
