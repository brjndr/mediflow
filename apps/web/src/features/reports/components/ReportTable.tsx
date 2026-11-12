import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import type { ReportColumn, ReportResult } from '../types';

type Cell = string | number | null;
interface Line {
  id: string;
  cells: Cell[];
  total: boolean;
}

/**
 * A report as a table: the columns the server names, translated here, and its totals as a last
 * line. Money is in minor units and shown in the hospital's currency. A report holds counts,
 * money and catalog names, never a patient, so nothing here is masked.
 */
export function ReportTable({ result, label }: { result: ReportResult; label: string }) {
  const { t } = useTranslation('reports');
  const format = useFormatters();

  const lines = useMemo<Line[]>(() => {
    const rows = result.rows.map((cells, index) => ({ id: `row-${index}`, cells, total: false }));
    const hasTotals = result.totals.some((cell) => cell !== null);
    return hasTotals ? [...rows, { id: 'totals', cells: result.totals, total: true }] : rows;
  }, [result.rows, result.totals]);

  const show = (column: ReportColumn, cell: Cell): string => {
    if (cell === null || cell === '') return '';
    switch (column.type) {
      case 'money':
        return format.money(Number(cell));
      case 'integer':
        return format.number(Number(cell));
      case 'minutes':
        return t('table.minutes', { count: Number(cell), formatted: format.number(Number(cell)) });
      case 'date':
        return format.calendarDate(String(cell));
      default:
        // A fixed set of words the server sends as keys (a payment method, an age band).
        return column.key === 'method' || column.key === 'ageBucket'
          ? t(`values.${column.key}.${String(cell)}`, { defaultValue: String(cell) })
          : String(cell);
    }
  };

  const columns = useMemo<GridColumn<Line>[]>(
    () =>
      result.columns.map((column, index) => ({
        id: column.key,
        header: t(`columns.${column.key}`, { defaultValue: column.key }),
        // The first column names the line, and the totals line says so there.
        value: (line) =>
          line.total && index === 0 ? t('table.total') : show(column, line.cells[index] ?? null),
        align: column.type === 'text' || column.type === 'date' ? 'start' : 'end',
        hideable: index !== 0,
      })),
    // `show` reads only the formatters, which change with the hospital.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result.columns, t, format],
  );

  return (
    <DataGrid
      label={label}
      columns={columns}
      rows={lines}
      rowId={(line) => line.id}
      rowLabel={(line) => (line.total ? t('table.total') : String(line.cells[0] ?? ''))}
      status="ready"
      emptyMessage={t('table.empty')}
    />
  );
}
