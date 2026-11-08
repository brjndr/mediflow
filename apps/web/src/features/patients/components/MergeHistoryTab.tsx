import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { SlotProps } from '@/registry';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { usePatientMerges } from '../hooks/use-merge';
import type { PatientMerge } from '../types';
import { DetailTab } from './DetailTabs';

/**
 * The "Merge history" tab (`patient.detail.tabs`, #558): the records merged into this one, newest
 * first, with why, who and when, and how many rows each module moved. For `patient:merge`.
 */
export default function MergeHistoryTab({ context }: SlotProps) {
  const { t } = useTranslation('patients');
  const patientId = typeof context?.patientId === 'string' ? context.patientId : '';
  if (!patientId) return null;
  return (
    <DetailTab id="merges" title={t('merge.history.tab')}>
      <MergeHistory key={patientId} patientId={patientId} />
    </DetailTab>
  );
}

function MergeHistory({ patientId }: { patientId: string }) {
  const { t } = useTranslation('patients');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const merges = usePatientMerges(patientId);

  const columns = useMemo<GridColumn<PatientMerge>[]>(
    () => [
      {
        id: 'when',
        header: t('merge.history.when'),
        value: (row) => format.dateTime(row.mergedAt),
        hideable: false,
        // The merged record keeps its id: the link opens it, read-only.
        render: (row, text) => (
          <Link className="font-medium underline" to={`/patients/${row.sourcePatientId}`}>
            {text}
          </Link>
        ),
      },
      { id: 'reason', header: t('merge.history.reason'), value: (row) => row.reason },
      { id: 'by', header: t('merge.history.by'), value: (row) => row.mergedBy },
      {
        id: 'moved',
        header: t('merge.history.moved'),
        value: (row) => {
          const parts = Object.entries(row.moved).map(
            ([module, count]) =>
              `${t(`merge.modules.${module}`, { defaultValue: module })}: ${count}`,
          );
          return parts.length > 0 ? parts.join(', ') : t('merge.history.nothing');
        },
      },
    ],
    [t, format],
  );

  return (
    <section aria-labelledby="merge-history-heading" className="flex flex-col gap-3">
      <h2 id="merge-history-heading" className="text-lg font-semibold">
        {t('merge.history.heading')}
      </h2>
      <DataGrid
        label={t('merge.history.heading')}
        columns={columns}
        rows={merges.data ?? []}
        rowId={(row) => row.id}
        rowLabel={(row) => t('merge.history.rowLabel', { when: format.dateTime(row.mergedAt) })}
        status={merges.isPending ? 'loading' : merges.isError ? 'error' : 'ready'}
        errorMessage={merges.isError ? tCommon(errorMessageKey(merges.error)) : undefined}
        onRetry={() => void merges.refetch()}
        emptyMessage={t('merge.history.empty')}
      />
    </section>
  );
}
