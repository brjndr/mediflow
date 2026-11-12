import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePatientName } from '@/features/patients';
import { errorMessageKey } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { useLegalHolds, useReleaseHold } from '../hooks/use-holds';
import type { LegalHold } from '../types';

function PatientCell({ id }: { id: string }) {
  const name = usePatientName(id).data;
  return <>{name ? `${name.firstName} ${name.lastName} (${name.mrn})` : id}</>;
}

/**
 * The active legal holds of the hospital (#628), for `documentRetention:read`; releasing one
 * needs `documentRetention:manage` and is confirmed first. A hold is never deleted, only released.
 */
export function HoldsSection() {
  const { t } = useTranslation('documents');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const holds = useLegalHolds();
  const release = useReleaseHold();
  const status = useRef<HTMLParagraphElement>(null);
  const [releasing, setReleasing] = useState<LegalHold | null>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);
  const rows = useMemo(() => holds.data?.pages.flatMap((page) => page.items) ?? [], [holds.data]);

  const columns = useMemo<GridColumn<LegalHold>[]>(
    () => [
      {
        id: 'covers',
        header: t('holds.columns.covers'),
        value: (row) => (row.documentId ? t('holds.oneDocument') : t('holds.allDocuments')),
        hideable: false,
        render: (_row, text) => <span className="font-medium">{text}</span>,
      },
      {
        id: 'patient',
        header: t('holds.columns.patient'),
        value: (row) => row.patientId,
        render: (row) => <PatientCell id={row.patientId} />,
      },
      { id: 'reason', header: t('holds.columns.reason'), value: (row) => row.reason },
      {
        id: 'placed',
        header: t('holds.columns.placed'),
        value: (row) => format.dateTime(row.placedAt),
      },
    ],
    [t, format],
  );
  const actions: GridAction<LegalHold>[] = [
    {
      id: 'release',
      label: t('holds.release'),
      requires: 'documentRetention:manage',
      onSelect: (row) => setReleasing(row),
    },
  ];

  const confirm = async () => {
    if (!releasing) return;
    try {
      await release.mutateAsync(releasing.id);
      setMessage((now) => ({ text: t('holds.released'), count: now.count + 1 }));
    } catch (error) {
      setMessage((now) => ({ text: tCommon(errorMessageKey(error)), count: now.count + 1 }));
    }
    setReleasing(null);
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="holds-heading">
      <h2 id="holds-heading" className="text-xl font-semibold">
        {t('holds.heading')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('holds.note')}</p>
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm outline-none empty:hidden focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {message.text && <span key={message.count}>{message.text}</span>}
      </p>
      <DataGrid
        label={t('holds.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) =>
          t('holds.rowLabel', {
            covers: row.documentId ? t('holds.oneDocument') : t('holds.allDocuments'),
          })
        }
        actions={actions}
        status={holds.isPending ? 'loading' : holds.isError ? 'error' : 'ready'}
        errorMessage={holds.isError ? tCommon(errorMessageKey(holds.error)) : undefined}
        onRetry={() => void holds.refetch()}
        emptyMessage={t('holds.empty')}
        hasNextPage={holds.hasNextPage}
        loadingMore={holds.isFetchingNextPage}
        onLoadMore={() => void holds.fetchNextPage()}
      />
      <ConfirmDialog
        open={releasing !== null}
        onClose={() => setReleasing(null)}
        title={t('holds.confirmTitle')}
        description={t('holds.confirmDescription')}
        cancelLabel={t('close')}
        confirmLabel={t('holds.release')}
        onConfirm={() => void confirm()}
        pending={release.isPending}
      />
    </section>
  );
}
