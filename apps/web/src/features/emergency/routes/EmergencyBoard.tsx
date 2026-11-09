import { AlertTriangle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { usePatientName } from '@/features/patients';
import { errorMessageKey } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { IdentifyDialog, TriageDialog } from '../components/CaseDialogs';
import { RegisterDialog } from '../components/RegisterDialog';
import { useCases, useNow } from '../hooks/use-emergency';
import { isOverdue, minutesSince, TARGET_MINUTES, type Category } from '../schemas';
import type { EmergencyCase, EmergencyCaseStatus } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
const ACTIVE = 'active';

const CATEGORY_STYLE: Record<Category, string> = {
  1: 'bg-red-700 text-white',
  2: 'bg-orange-200 text-orange-950',
  3: 'bg-yellow-200 text-yellow-950',
  4: 'bg-green-200 text-green-950',
  5: 'bg-blue-200 text-blue-950',
};

/** A category as its number and word on a colour: the colour is never the only signal. */
function CategoryBadge({ category }: { category: number }) {
  const { t } = useTranslation('emergency');
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold',
        CATEGORY_STYLE[category as Category],
      )}
    >
      {t(`category.short.${category}`)}
    </span>
  );
}

function PatientOnRecord({ id }: { id: string }) {
  const { t } = useTranslation('emergency');
  const patient = usePatientName(id);
  if (patient.data) return <>{`${patient.data.firstName} ${patient.data.lastName}`}</>;
  return <>{t('onRecord')}</>;
}

/** Who the case is for: the name on record, the alias given at the door, or a plain word. */
function CaseWho({ row }: { row: EmergencyCase }) {
  const { t } = useTranslation('emergency');
  if (row.patientId) return <PatientOnRecord id={row.patientId} />;
  return <>{row.alias ?? t('unidentified')}</>;
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function EmergencyBoard() {
  const { t } = useTranslation('emergency');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const canRegister = usePermission('emergency:register');
  const now = useNow();

  const [status, setStatus] = useState<EmergencyCaseStatus | typeof ACTIVE>(ACTIVE);
  const cases = useCases(status === ACTIVE ? undefined : status);
  const [dialog, setDialog] = useState<
    'register' | { triage: EmergencyCase } | { identify: EmergencyCase }
  >();
  const [done, setDone] = useState<string>();
  const statusLine = useRef<HTMLParagraphElement>(null);
  // A row that moved on may have left the list and taken focus with it.
  useEffect(() => {
    if (done) focusIfLost(statusLine.current);
  }, [done]);

  const rows = useMemo(() => cases.data?.pages.flatMap((page) => page.items) ?? [], [cases.data]);
  const total = cases.data?.pages[0]?.total;
  const overdue = rows.filter((row) => isOverdue(row, now)).length;

  const closeDialog = () => {
    setDialog(undefined);
    setTimeout(() => focusIfLost(statusLine.current), 0);
  };

  const actions: GridAction<EmergencyCase>[] = [
    {
      id: 'triage',
      label: t('actions.triage'),
      requires: 'emergency:triage',
      disabled: (row) => row.status === 'disposed',
      onSelect: (row) => setDialog({ triage: row }),
    },
    {
      id: 'identify',
      label: t('actions.identify'),
      requires: 'emergency:register',
      disabled: (row) => row.patientId !== undefined,
      onSelect: (row) => setDialog({ identify: row }),
    },
  ];

  const columns = useMemo<GridColumn<EmergencyCase>[]>(
    () => [
      {
        id: 'patient',
        header: t('columns.patient'),
        value: (row) => row.alias ?? (row.patientId ? t('onRecord') : t('unidentified')),
        render: (row) => <CaseWho row={row} />,
        hideable: false,
      },
      { id: 'tempId', header: t('columns.tempId'), value: (row) => row.tempId },
      {
        id: 'category',
        header: t('columns.category'),
        value: (row) =>
          row.category === undefined ? t('category.none') : t(`category.short.${row.category}`),
        render: (row, text) =>
          row.category === undefined ? text : <CategoryBadge category={row.category} />,
        hideable: false,
      },
      {
        id: 'wait',
        header: t('columns.wait'),
        value: (row) =>
          row.status === 'waiting'
            ? t('wait.minutes', { count: minutesSince(row.arrivedAt, now) })
            : t(`status.${row.status}`),
        render: (row, text) =>
          isOverdue(row, now) ? (
            <span className="inline-flex items-center gap-1 font-medium text-destructive">
              <AlertTriangle aria-hidden="true" className="size-4" />
              {text}
              <span>
                {t('wait.overdue', { minutes: TARGET_MINUTES[row.category as Category] })}
              </span>
            </span>
          ) : (
            text
          ),
        hideable: false,
      },
      { id: 'complaint', header: t('columns.complaint'), value: (row) => row.complaint },
      {
        id: 'arrival',
        header: t('columns.arrival'),
        value: (row) => t(`arrival.${row.arrivalMode}`),
      },
      {
        id: 'arrived',
        header: t('columns.arrived'),
        value: (row) => format.dateTime(row.arrivedAt),
      },
    ],
    [t, format, now],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm font-medium outline-none empty:sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {done ?? ''}
      </p>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="flex min-w-44 flex-col gap-1 text-sm font-medium">
          {t('filter.label')}
          <select
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as EmergencyCaseStatus | typeof ACTIVE)
            }
            className={control}
          >
            <option value={ACTIVE}>{t('filter.active')}</option>
            <option value="waiting">{t('status.waiting')}</option>
            <option value="in_treatment">{t('status.in_treatment')}</option>
          </select>
        </label>
        {canRegister && <Button onClick={() => setDialog('register')}>{t('register.open')}</Button>}
      </div>

      <p className="text-sm text-muted-foreground">
        {total === undefined || cases.isPlaceholderData ? '' : t('count', { count: total })}
        {overdue > 0 && !cases.isPlaceholderData ? ` ${t('overdueCount', { count: overdue })}` : ''}
      </p>

      <DataGrid
        label={t('gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => t('rowLabel', { id: row.tempId })}
        actions={cases.isPlaceholderData ? [] : actions}
        status={cases.isPending ? 'loading' : cases.isError ? 'error' : 'ready'}
        errorMessage={cases.isError ? tCommon(errorMessageKey(cases.error)) : undefined}
        onRetry={() => void cases.refetch()}
        emptyMessage={t('empty')}
        hasNextPage={cases.hasNextPage && !cases.isPlaceholderData}
        total={cases.isPlaceholderData ? undefined : total}
        loadingMore={cases.isFetchingNextPage}
        onLoadMore={() => void cases.fetchNextPage()}
      />

      {dialog === 'register' && (
        <RegisterDialog
          onClose={closeDialog}
          onRegistered={(made) => {
            setDone(t('done.registered', { id: made.tempId }));
            closeDialog();
          }}
        />
      )}
      {typeof dialog === 'object' && 'triage' in dialog && (
        <TriageDialog
          row={dialog.triage}
          onClose={closeDialog}
          onDone={(category) => {
            setDone(t('done.triaged', { id: dialog.triage.tempId, category }));
            closeDialog();
          }}
        />
      )}
      {typeof dialog === 'object' && 'identify' in dialog && (
        <IdentifyDialog
          row={dialog.identify}
          onClose={closeDialog}
          onDone={() => {
            setDone(t('done.identified', { id: dialog.identify.tempId }));
            closeDialog();
          }}
        />
      )}
    </div>
  );
}
