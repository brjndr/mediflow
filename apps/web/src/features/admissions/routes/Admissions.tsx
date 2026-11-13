import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { useFormatters } from '@/tenancy';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { maskMrn } from '@/shared/utils/mask';
import { AdmissionDetailsPanel } from '../components/AdmissionDetailsPanel';
import { BedHistoryPanel } from '../components/BedHistoryPanel';
import { BedPicker } from '../components/BedPicker';
import { DischargePanel } from '../components/DischargePanel';
import { useAdmissions, useChangeBed, useDischarge } from '../hooks/use-admissions';
import { MOVE_NOTE_MAX, MOVE_REASONS, type MoveReason } from '../schemas';
import type { Admission, DischargeType } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';

type StatusFilter = 'admitted' | 'discharged' | '';

/** Giving a bed or moving to another, for one admission: the beds free now, then confirm. */
function BedPanel({
  admission,
  pending,
  onSubmit,
  onBack,
}: {
  admission: Admission;
  pending: boolean;
  onSubmit: (bedId: string, reason?: MoveReason, note?: string) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation('admissions');
  const [bedId, setBedId] = useState('');
  const [reason, setReason] = useState<MoveReason | ''>('');
  const [note, setNote] = useState('');
  const [missing, setMissing] = useState(false);
  const moving = admission.bed !== undefined;
  return (
    <section
      aria-labelledby="admission-bed-heading"
      className="flex flex-col gap-3 rounded-md border p-4"
    >
      <h2
        id="admission-bed-heading"
        data-panel-heading
        tabIndex={-1}
        className="rounded-sm text-lg font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {t(moving ? 'bedPanel.moveHeading' : 'bedPanel.giveHeading', {
          patient: admission.patientName,
        })}
      </h2>
      <BedPicker
        patientId={admission.patientId}
        value={bedId}
        onChange={(next) => {
          setBedId(next);
          setMissing(false);
        }}
      />
      <div className="flex flex-wrap gap-4">
        <label className="flex min-w-48 flex-col gap-1 text-sm font-medium">
          {t('bedPanel.reason')}
          <select
            value={reason}
            onChange={(event) => setReason(event.target.value as MoveReason | '')}
            className={control}
          >
            <option value="">{t('bedPanel.noReason')}</option>
            {MOVE_REASONS.map((each) => (
              <option key={each} value={each}>
                {t(`moveReasons.${each}`)}
              </option>
            ))}
          </select>
        </label>
        {reason !== '' && (
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm font-medium">
            {t('bedPanel.note')}
            <input
              type="text"
              value={note}
              maxLength={MOVE_NOTE_MAX}
              onChange={(event) => setNote(event.target.value)}
              className={control}
            />
          </label>
        )}
      </div>
      {missing && (
        <p role="alert" className="text-sm text-destructive">
          {t('admit.bedRequired')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          aria-disabled={pending || undefined}
          onClick={() => {
            if (pending) return;
            if (bedId === '') setMissing(true);
            else
              onSubmit(bedId, reason || undefined, reason ? note.trim() || undefined : undefined);
          }}
        >
          {t(moving ? 'bedPanel.move' : 'bedPanel.give')}
        </Button>
        <Button type="button" variant="outline" onClick={onBack}>
          {t('bedPanel.back')}
        </Button>
      </div>
    </section>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function Admissions() {
  const { t } = useTranslation('admissions');
  const navigate = useNavigate();
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const [status, setStatus] = useState<StatusFilter>('admitted');
  const list = useAdmissions(status);
  const rows = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const total = list.data?.pages[0]?.total;

  const change = useChangeBed();
  const discharge = useDischarge();
  const [target, setTarget] = useState<Admission | null>(null);
  const [leaving, setLeaving] = useState<Admission | null>(null);
  const [history, setHistory] = useState<Admission | null>(null);
  const [details, setDetails] = useState<Admission | null>(null);
  const [done, setDone] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  usePanelFocus(target ?? leaving ?? history ?? details, box, statusLine);

  const choose = async (bedId: string, reason?: MoveReason, note?: string) => {
    if (!target) return;
    change.reset();
    setDone('');
    try {
      const updated = await change.mutateAsync({ admission: target, bedId, reason, note });
      setTarget(null);
      setDone(t('done.bed', { patient: updated.patientName, bed: updated.bed?.bedNumber ?? '' }));
    } catch (error) {
      // Someone else changed the stay or the bed first: the panel closes, the list is read again.
      if (isApiError(error) && ['conflict', 'bed_not_available'].includes(error.serverCode ?? '')) {
        setTarget(null);
      }
    }
  };

  const release = async (type: DischargeType, billAcknowledged: boolean) => {
    if (!leaving) return;
    discharge.reset();
    setDone('');
    try {
      const updated = await discharge.mutateAsync({ admission: leaving, type, billAcknowledged });
      setLeaving(null);
      setDone(t('done.discharged', { patient: updated.patientName }));
    } catch (error) {
      // Changed first or already over: the panel closes and the list is read again. A refusal
      // about notes keeps the panel, so the desk can try again once the notes are signed.
      if (
        isApiError(error) &&
        ['conflict', 'invalid_transition'].includes(error.serverCode ?? '')
      ) {
        setLeaving(null);
      }
    }
  };

  const columns = useMemo<GridColumn<Admission>[]>(
    () => [
      {
        id: 'patient',
        header: t('columns.patient'),
        value: (row) => row.patientName,
        hideable: false,
      },
      { id: 'mrn', header: t('columns.mrn'), value: (row) => row.patientMrn, mask: maskMrn },
      {
        id: 'bed',
        header: t('columns.bed'),
        value: (row) =>
          row.bed ? t('bedOf', { number: row.bed.bedNumber, ward: row.bed.wardName }) : t('noBed'),
      },
      { id: 'doctor', header: t('columns.doctor'), value: (row) => row.doctorName },
      { id: 'type', header: t('columns.type'), value: (row) => t(`types.${row.admissionType}`) },
      {
        id: 'admittedAt',
        header: t('columns.admittedAt'),
        value: (row) => format.dateTime(row.admittedAt),
      },
      {
        id: 'deposit',
        header: t('columns.deposit'),
        value: (row) => (row.depositMinor !== undefined ? format.money(row.depositMinor) : '—'),
      },
      {
        id: 'status',
        header: t('columns.status'),
        value: (row) => t(`admissionStatus.${row.status}`),
      },
    ],
    [t, format],
  );

  const actions: GridAction<Admission>[] = [
    {
      id: 'bed',
      label: t('actions.bed'),
      requires: 'admission:transfer',
      disabled: (row) =>
        row.status !== 'admitted' || target !== null || leaving !== null || change.isPending,
      onSelect: (row) => {
        setHistory(null);
        setTarget(row);
      },
    },
    {
      id: 'discharge',
      label: t('actions.discharge'),
      requires: 'admission:discharge',
      disabled: (row) =>
        row.status !== 'admitted' || target !== null || leaving !== null || discharge.isPending,
      onSelect: (row) => {
        setHistory(null);
        discharge.reset();
        setLeaving(row);
      },
    },
    {
      id: 'details',
      label: t('actions.details'),
      requires: 'admission:read',
      disabled: () => target !== null || leaving !== null,
      onSelect: (row) => {
        setHistory(null);
        setDetails(row);
      },
    },
    {
      id: 'summary',
      label: t('actions.summary'),
      requires: 'dischargeSummary:read',
      onSelect: (row) => navigate(`/admissions/${row.id}/summary`),
    },
    {
      id: 'bill',
      label: t('actions.bill'),
      requires: 'charge:read',
      featureFlag: 'billing',
      onSelect: (row) => navigate(`/billing/stays/${row.id}`),
    },
    {
      id: 'history',
      label: t('actions.history'),
      requires: 'admission:read',
      disabled: () => target !== null || leaving !== null,
      onSelect: (row) => {
        setDetails(null);
        setHistory(row);
      },
    },
  ];

  const refused =
    isApiError(change.error) &&
    ['conflict', 'bed_not_available'].includes(change.error.serverCode ?? '');

  const dischargeCode = isApiError(discharge.error) ? discharge.error.serverCode : undefined;
  const dischargeFailure = !discharge.isError
    ? ''
    : dischargeCode === 'clearance_pending'
      ? t('discharge.clearancePending')
      : dischargeCode === 'bill_outstanding' || dischargeCode === 'bill_unconfirmed'
        ? t('discharge.billRefused')
        : dischargeCode === 'unsigned_notes'
          ? t('discharge.unsignedNotes')
          : dischargeCode === 'encounter_not_open'
            ? t('discharge.notOpen')
            : dischargeCode === 'conflict' || dischargeCode === 'invalid_transition'
              ? t('refused.admission')
              : tCommon(errorMessageKey(discharge.error));

  return (
    <div ref={box} className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('admissionsHeading')}</h1>
          <p className="text-muted-foreground">{t('admissionsDescription')}</p>
        </div>
        <Can permission="admission:create">
          <Button asChild>
            <Link to="/admissions/new">{t('admit.open')}</Link>
          </Button>
        </Can>
      </div>

      <label className="flex min-w-52 flex-col gap-1 text-sm font-medium">
        {t('filters.status')}
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as StatusFilter)}
          className={`${control} max-w-xs`}
        >
          <option value="admitted">{t('admissionStatus.admitted')}</option>
          <option value="discharged">{t('admissionStatus.discharged')}</option>
          <option value="">{t('filters.allStatuses')}</option>
        </select>
      </label>

      {change.isError && (
        <p role="alert" className="text-sm text-destructive">
          {refused ? t('refused.admission') : tCommon(errorMessageKey(change.error))}
        </p>
      )}
      {discharge.isError && (
        <p role="alert" className="text-sm text-destructive">
          {dischargeFailure}
        </p>
      )}
      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm font-medium outline-none empty:sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {done}
      </p>

      {target && (
        <BedPanel
          key={target.id}
          admission={target}
          pending={change.isPending}
          onSubmit={(bedId, reason, note) => void choose(bedId, reason, note)}
          onBack={() => setTarget(null)}
        />
      )}

      {leaving && (
        <DischargePanel
          key={leaving.id}
          admission={leaving}
          pending={discharge.isPending}
          onSubmit={(type, acknowledged) => void release(type, acknowledged)}
          onBack={() => setLeaving(null)}
        />
      )}

      {history && (
        <BedHistoryPanel key={history.id} admission={history} onBack={() => setHistory(null)} />
      )}

      {details && (
        <AdmissionDetailsPanel
          key={details.id}
          admission={details}
          onBack={() => setDetails(null)}
        />
      )}

      <DataGrid
        label={t('admissionsGrid')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => t('admissionRowLabel', { patient: row.patientName })}
        actions={list.isPlaceholderData ? [] : actions}
        status={list.isPending ? 'loading' : list.isError ? 'error' : 'ready'}
        errorMessage={list.isError ? tCommon(errorMessageKey(list.error)) : undefined}
        onRetry={() => void list.refetch()}
        emptyMessage={t('admissionsEmpty')}
        hasNextPage={list.hasNextPage && !list.isPlaceholderData}
        total={list.isPlaceholderData ? undefined : total}
        loadingMore={list.isFetchingNextPage}
        onLoadMore={() => void list.fetchNextPage()}
      />
    </div>
  );
}
