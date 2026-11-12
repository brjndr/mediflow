import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { usePatientName } from '@/features/patients';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { MedicoLegalBadge } from '../components/MedicoLegalPanel';
import { useMlcRegister } from '../hooks/use-emergency';
import type { EmergencyCase } from '../types';

function Who({ row }: { row: EmergencyCase }) {
  const { t } = useTranslation('emergency');
  const patient = usePatientName(row.patientId ?? '');
  if (row.patientId && patient.data) {
    return <>{`${patient.data.firstName} ${patient.data.lastName}`}</>;
  }
  if (row.patientId) return <>{t('onRecord')}</>;
  return <>{row.alias ?? t('unidentified')}</>;
}

/**
 * The register of medico-legal cases (#676): every flagged case, any status, newest first. It
 * lists the flag and the case only; the record itself (category, account, police) is opened on
 * the case page, where each view is audited.
 */
export default function MedicoLegalCases() {
  const { t } = useTranslation('emergency');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const cases = useMlcRegister();
  const rows = useMemo(() => cases.data?.pages.flatMap((page) => page.items) ?? [], [cases.data]);
  const total = cases.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<EmergencyCase>[]>(
    () => [
      {
        id: 'patient',
        header: t('columns.patient'),
        value: (row) => row.alias ?? (row.patientId ? t('onRecord') : t('unidentified')),
        render: (row) => (
          <span className="flex flex-wrap items-center gap-2">
            <Link className="underline" to={`/emergency/${row.id}`}>
              <Who row={row} />
            </Link>
            <MedicoLegalBadge />
          </span>
        ),
        hideable: false,
      },
      { id: 'tempId', header: t('columns.tempId'), value: (row) => row.tempId },
      { id: 'status', header: t('mlcRegister.status'), value: (row) => t(`status.${row.status}`) },
      { id: 'complaint', header: t('columns.complaint'), value: (row) => row.complaint },
      {
        id: 'arrived',
        header: t('columns.arrived'),
        value: (row) => format.dateTime(row.arrivedAt),
      },
    ],
    [t, format],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <Link className="text-sm underline" to="/emergency">
          {t('care.back')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{t('mlcRegister.heading')}</h1>
        <p className="text-muted-foreground">{t('mlcRegister.description')}</p>
      </div>
      <p role="status" className="text-sm text-muted-foreground empty:sr-only">
        {total === undefined ? '' : t('mlcRegister.count', { count: total })}
      </p>
      <DataGrid
        label={t('mlcRegister.gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => t('rowLabel', { id: row.tempId })}
        status={cases.isPending ? 'loading' : cases.isError ? 'error' : 'ready'}
        errorMessage={cases.isError ? tCommon(errorMessageKey(cases.error)) : undefined}
        onRetry={() => void cases.refetch()}
        emptyMessage={t('mlcRegister.empty')}
        hasNextPage={cases.hasNextPage}
        total={total}
        loadingMore={cases.isFetchingNextPage}
        onLoadMore={() => void cases.fetchNextPage()}
      />
    </div>
  );
}
