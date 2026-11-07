import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters } from '@/tenancy';
import { CodeDiagnosisDialog } from '../components/CodeDiagnosisDialog';
import { RecordsNav } from '../components/RecordsNav';
import { useCodingQueue } from '../hooks/use-records';
import type { CodingItem, CodingState } from '../types';

const field =
  'h-9 w-full rounded-md border bg-background px-3 text-base md:text-sm pointer-coarse:h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * The coding queue (`records/coding`, MR-04, #192), for `medicalRecord:read`: diagnoses a doctor
 * wrote as text that still have no code, the oldest first, or those already coded. A coder with
 * `medicalRecord:code` picks the ICD-10 code from the server's search.
 */
export default function CodingQueue() {
  const { t } = useTranslation('records');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const stateId = useId();
  const [state, setState] = useState<CodingState>('uncoded');
  const queue = useCodingQueue(state);
  const rows = useMemo(() => queue.data?.pages.flatMap((page) => page.items) ?? [], [queue.data]);
  const total = queue.isPlaceholderData ? undefined : queue.data?.pages[0]?.total;
  const [codingId, setCodingId] = useState<string | null>(null);
  const coding = codingId === null ? undefined : rows.find((row) => row.diagnosisId === codingId);
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const columns = useMemo<GridColumn<CodingItem>[]>(
    () => [
      {
        id: 'patient',
        header: t('coding.columns.patient'),
        value: (row) => row.patientName,
        hideable: false,
      },
      { id: 'mrn', header: t('coding.columns.mrn'), value: (row) => row.patientMrn, mask: maskMrn },
      { id: 'text', header: t('coding.columns.text'), value: (row) => row.text },
      {
        id: 'code',
        header: t('coding.columns.code'),
        value: (row) => (row.code ? `${row.code.code} ${row.code.title}` : t('coding.none')),
      },
      {
        id: 'recorded',
        header: t('coding.columns.recorded'),
        value: (row) => format.date(row.recordedAt),
      },
      { id: 'doctor', header: t('coding.columns.doctor'), value: (row) => row.doctorName },
    ],
    [t, format],
  );

  const actions = useMemo<GridAction<CodingItem>[]>(
    () => [
      {
        id: 'code',
        label: t('coding.code'),
        requires: 'medicalRecord:code',
        onSelect: (row) => setCodingId(row.diagnosisId),
      },
    ],
    [t],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('coding.heading')}</h1>
      <RecordsNav />
      <p className="text-sm text-muted-foreground">{t('coding.intro')}</p>
      <div className="flex flex-col gap-1.5 md:max-w-xs">
        <label htmlFor={stateId} className="text-sm font-medium">
          {t('coding.state')}
        </label>
        <select
          id={stateId}
          className={field}
          value={state}
          onChange={(event) => setState(event.target.value as CodingState)}
        >
          <option value="uncoded">{t('coding.uncoded')}</option>
          <option value="coded">{t('coding.coded')}</option>
        </select>
      </div>
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {[message.text, total === undefined ? '' : t('coding.count', { count: total })]
          .filter(Boolean)
          .join(' ')}
      </p>
      <DataGrid
        label={t('coding.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.diagnosisId}
        rowLabel={(row) => row.patientName}
        actions={actions}
        status={queue.isPending ? 'loading' : queue.isError ? 'error' : 'ready'}
        errorMessage={queue.isError ? tCommon(errorMessageKey(queue.error)) : undefined}
        onRetry={() => void queue.refetch()}
        emptyMessage={t(state === 'uncoded' ? 'coding.emptyUncoded' : 'coding.emptyCoded')}
        hasNextPage={queue.hasNextPage && !queue.isPlaceholderData}
        total={total}
        loadingMore={queue.isFetchingNextPage}
        onLoadMore={() => void queue.fetchNextPage()}
      />
      {coding && (
        <CodeDiagnosisDialog
          item={coding}
          onClose={() => setCodingId(null)}
          onCoded={(coded) => {
            setCodingId(null);
            setMessage((now) => ({
              text: t('coding.done', { name: coded.patientName }),
              count: now.count + 1,
            }));
          }}
        />
      )}
    </div>
  );
}
