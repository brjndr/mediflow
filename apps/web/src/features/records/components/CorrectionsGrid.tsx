import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { usePermission } from '@/access';
import { usePatientName } from '@/features/patients';
import { errorMessageKey } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { useCorrectionRequests } from '../hooks/use-records';
import type { CorrectionRequest, CorrectionStatus } from '../types';
import { DecideCorrectionDialog } from './CorrectionDialogs';

/** The patient's name, linked to the record; a plain word where the caller may not read it. */
function PatientCell({ patientId }: { patientId: string }) {
  const { t } = useTranslation('records');
  const name = usePatientName(patientId);
  const text = name.data
    ? `${name.data.firstName} ${name.data.lastName}`
    : t('corrections.patientRecord');
  return <Link to={`/patients/${patientId}`}>{text}</Link>;
}

/**
 * Requests to correct a record, newest first: the whole hospital's, or one patient's when a
 * `patientId` is given. A pending request has "Approve" and "Reject" for `correction:decide`.
 * Approving edits nothing: the module that owns the record applies it.
 */
export function CorrectionsGrid({
  status,
  patientId,
  label,
}: {
  status: CorrectionStatus | '';
  patientId?: string;
  label: string;
}) {
  const { t } = useTranslation('records');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const canDecide = usePermission('correction:decide');
  const requests = useCorrectionRequests(status, patientId);
  const rows = useMemo(
    () => requests.data?.pages.flatMap((page) => page.items) ?? [],
    [requests.data],
  );
  const total = requests.isPlaceholderData ? undefined : requests.data?.pages[0]?.total;
  const [deciding, setDeciding] = useState<{ id: string; decision: 'approve' | 'reject' } | null>(
    null,
  );
  const current = deciding ? rows.find((row) => row.id === deciding.id) : undefined;
  const statusLine = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(statusLine.current);
  }, [message]);

  const columns = useMemo<GridColumn<CorrectionRequest>[]>(
    () => [
      {
        id: 'proposed',
        header: t('corrections.columns.proposed'),
        value: (row) => row.proposed,
        hideable: false,
      },
      ...(patientId === undefined
        ? [
            {
              id: 'patient',
              header: t('corrections.columns.patient'),
              value: (row: CorrectionRequest) => row.patientId,
              render: (row: CorrectionRequest) => <PatientCell patientId={row.patientId} />,
            },
          ]
        : []),
      {
        id: 'target',
        header: t('corrections.columns.target'),
        value: (row) => t(`corrections.target.${row.targetKind}`),
      },
      { id: 'reason', header: t('corrections.columns.reason'), value: (row) => row.reason },
      {
        id: 'requested',
        header: t('corrections.columns.requested'),
        value: (row) => format.date(row.requestedAt),
      },
      {
        id: 'status',
        header: t('corrections.columns.status'),
        value: (row) => t(`corrections.status.${row.status}`),
      },
      {
        id: 'decision',
        header: t('corrections.columns.decision'),
        value: (row) => row.decisionReason ?? '',
      },
    ],
    [t, format, patientId],
  );

  const actions = useMemo<GridAction<CorrectionRequest>[]>(
    () =>
      canDecide
        ? [
            {
              id: 'approve',
              label: t('corrections.approve'),
              requires: 'correction:decide',
              disabled: (row) => row.status !== 'pending',
              onSelect: (row) => setDeciding({ id: row.id, decision: 'approve' }),
            },
            {
              id: 'reject',
              label: t('corrections.reject'),
              requires: 'correction:decide',
              disabled: (row) => row.status !== 'pending',
              onSelect: (row) => setDeciding({ id: row.id, decision: 'reject' }),
            },
          ]
        : [],
    [t, canDecide],
  );

  return (
    <div className="flex flex-col gap-3">
      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {[message.text, total === undefined ? '' : t('corrections.count', { count: total })]
          .filter(Boolean)
          .join(' ')}
      </p>
      <DataGrid
        label={label}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.proposed}
        actions={actions}
        status={requests.isPending ? 'loading' : requests.isError ? 'error' : 'ready'}
        errorMessage={requests.isError ? tCommon(errorMessageKey(requests.error)) : undefined}
        onRetry={() => void requests.refetch()}
        emptyMessage={t('corrections.empty')}
        hasNextPage={requests.hasNextPage && !requests.isPlaceholderData}
        total={total}
        loadingMore={requests.isFetchingNextPage}
        onLoadMore={() => void requests.fetchNextPage()}
      />
      {deciding && current && (
        <DecideCorrectionDialog
          request={current}
          decision={deciding.decision}
          onClose={() => setDeciding(null)}
          onDecided={(decided) => {
            setDeciding(null);
            setMessage((now) => ({
              text: t(`corrections.${deciding.decision}d`, { proposed: decided.proposed }),
              count: now.count + 1,
            }));
          }}
        />
      )}
    </div>
  );
}
