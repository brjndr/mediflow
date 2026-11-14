import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { usePermission } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters } from '@/tenancy';
import { AssignDialog } from '../components/AssignDialog';
import { RecordsNav } from '../components/RecordsNav';
import { useIncompleteRecords } from '../hooks/use-records';
import { GAPS, KINDS } from '../schemas';
import type { EncounterKind, IncompleteRecord, RecordGap } from '../types';

const field =
  'h-9 w-full rounded-md border bg-background px-3 text-base md:text-sm pointer-coarse:h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * Incomplete records (`records`, MR-04, #192), for `medicalRecord:read`: closed encounters whose
 * record still lacks something (a signed note, a diagnosis, a discharge summary, a consent), the
 * oldest first, narrowed by what is missing and by the kind of visit. The server finds the gaps;
 * the desk works the list by opening the consultation or the patient.
 */
export default function IncompleteRecords() {
  const { t } = useTranslation('records');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const navigate = useNavigate();
  const gapId = useId();
  const kindId = useId();
  const canEncounter = usePermission('encounter:read');
  const canPatient = usePermission('patient:read');
  const [gap, setGap] = useState<RecordGap | ''>('');
  const [kind, setKind] = useState<EncounterKind | ''>('');
  const records = useIncompleteRecords({ gap, kind });
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);
  const rows = useMemo(
    () => records.data?.pages.flatMap((page) => page.items) ?? [],
    [records.data],
  );
  const total = records.isPlaceholderData ? undefined : records.data?.pages[0]?.total;
  const assigning =
    assigningId === null ? undefined : rows.find((row) => row.encounterId === assigningId);

  const columns = useMemo<GridColumn<IncompleteRecord>[]>(
    () => [
      {
        id: 'patient',
        header: t('incomplete.columns.patient'),
        value: (row) => row.patientName,
        hideable: false,
      },
      {
        id: 'mrn',
        header: t('incomplete.columns.mrn'),
        value: (row) => row.patientMrn,
        mask: maskMrn,
      },
      {
        id: 'kind',
        header: t('incomplete.columns.kind'),
        value: (row) => t(`kind.${row.kind}`),
      },
      {
        id: 'closed',
        header: t('incomplete.columns.closed'),
        value: (row) => format.date(row.closedAt),
      },
      { id: 'doctor', header: t('incomplete.columns.doctor'), value: (row) => row.doctorName },
      {
        id: 'assigned',
        header: t('incomplete.columns.assigned'),
        value: (row) => row.assignedDoctorName ?? t('incomplete.assigned.none'),
      },
      {
        id: 'gaps',
        header: t('incomplete.columns.gaps'),
        value: (row) => row.gaps.map((each) => t(`gap.${each}`)).join(', '),
      },
    ],
    [t, format],
  );

  const actions = useMemo<GridAction<IncompleteRecord>[]>(
    () => [
      {
        id: 'assign',
        label: t('incomplete.assign'),
        requires: 'medicalRecord:assign',
        onSelect: (row: IncompleteRecord) => setAssigningId(row.encounterId),
      } satisfies GridAction<IncompleteRecord>,
      ...(canEncounter
        ? [
            {
              id: 'consultation',
              label: t('incomplete.openEncounter'),
              onSelect: (row: IncompleteRecord) => navigate(`/encounters/${row.encounterId}`),
            } satisfies GridAction<IncompleteRecord>,
          ]
        : []),
      ...(canPatient
        ? [
            {
              id: 'patient',
              label: t('incomplete.openPatient'),
              onSelect: (row: IncompleteRecord) => navigate(`/patients/${row.patientId}`),
            } satisfies GridAction<IncompleteRecord>,
          ]
        : []),
    ],
    [t, canEncounter, canPatient, navigate],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('incomplete.heading')}</h1>
      <RecordsNav />
      <p className="text-sm text-muted-foreground">{t('incomplete.intro')}</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:max-w-2xl">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={gapId} className="text-sm font-medium">
            {t('incomplete.gap')}
          </label>
          <select
            id={gapId}
            className={field}
            value={gap}
            onChange={(event) => setGap(event.target.value as RecordGap | '')}
          >
            <option value="">{t('incomplete.anyGap')}</option>
            {GAPS.map((each) => (
              <option key={each} value={each}>
                {t(`gap.${each}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={kindId} className="text-sm font-medium">
            {t('incomplete.kind')}
          </label>
          <select
            id={kindId}
            className={field}
            value={kind}
            onChange={(event) => setKind(event.target.value as EncounterKind | '')}
          >
            <option value="">{t('incomplete.anyKind')}</option>
            {KINDS.map((each) => (
              <option key={each} value={each}>
                {t(`kind.${each}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {[message.text, total === undefined ? '' : t('incomplete.count', { count: total })]
          .filter(Boolean)
          .join(' ')}
      </p>
      <DataGrid
        label={t('incomplete.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.encounterId}
        rowLabel={(row) => row.patientName}
        actions={actions}
        status={records.isPending ? 'loading' : records.isError ? 'error' : 'ready'}
        errorMessage={records.isError ? tCommon(errorMessageKey(records.error)) : undefined}
        onRetry={() => void records.refetch()}
        emptyMessage={t('incomplete.empty')}
        hasNextPage={records.hasNextPage && !records.isPlaceholderData}
        total={total}
        loadingMore={records.isFetchingNextPage}
        onLoadMore={() => void records.fetchNextPage()}
      />
      {assigning && (
        <AssignDialog
          record={assigning}
          onClose={() => setAssigningId(null)}
          onAssigned={(updated) => {
            setAssigningId(null);
            setMessage((now) => ({
              text: updated.assignedDoctorName
                ? t('assign.done', {
                    name: updated.patientName,
                    doctor: updated.assignedDoctorName,
                  })
                : t('assign.removed', { name: updated.patientName }),
              count: now.count + 1,
            }));
          }}
        />
      )}
    </div>
  );
}
