import type { ReportResult } from '../types';

/** The sum of one numeric column of a report's rows; 0 when the report has no such column. */
export function sumColumn(report: ReportResult, key: string): number {
  const at = report.columns.findIndex((column) => column.key === key);
  if (at < 0) return 0;
  return report.rows.reduce((sum, row) => sum + Number(row[at] ?? 0), 0);
}
