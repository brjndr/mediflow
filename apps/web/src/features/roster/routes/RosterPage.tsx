import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Can } from '@/access';
import { useDepartmentOptions } from '@/features/departments';
import { errorMessageKey } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { dayBoundsUtc, todayIn } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import { OnCallPanel } from '../components/OnCallPanel';
import { ShiftDialog } from '../components/ShiftDialog';
import { useCancelShift, useShifts } from '../hooks/use-roster';
import { rosterConflicts } from '../conflicts';
import { MIN_REST_HOURS } from '../schemas';
import type { RosterShift } from '../types';

const field =
  'h-9 w-full rounded-md border bg-background px-3 text-base md:text-sm pointer-coarse:h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The Monday of the week a day falls in. */
function mondayOf(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}

/**
 * The duty roster (`roster`, OP-01, #195), a week at a time on the hospital's clock, for
 * `roster:read`: who is on duty, in which department, and who is on call now. `roster:manage`
 * adds a shift (the kind fills the usual hours) and cancels one. Conflicts are said in words.
 */
export default function RosterPage() {
  const { t } = useTranslation('roster');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const departmentId = useId();
  const [weekStart, setWeekStart] = useState(() => mondayOf(todayIn(timezone)));
  const [department, setDepartment] = useState('');
  const departments = useDepartmentOptions();
  const range = useMemo(
    () => ({
      from: dayBoundsUtc(weekStart, timezone).start,
      to: dayBoundsUtc(addDays(weekStart, 6), timezone).end,
    }),
    [weekStart, timezone],
  );
  const shifts = useShifts({ ...range, ...(department ? { departmentId: department } : {}) });
  const rows = useMemo(() => shifts.data?.pages.flatMap((page) => page.items) ?? [], [shifts.data]);
  const conflicts = useMemo(() => rosterConflicts(rows), [rows]);
  const [adding, setAdding] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const cancelling =
    cancellingId === null ? undefined : rows.find((row) => row.id === cancellingId);
  const cancel = useCancelShift(cancellingId ?? '');
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const columns = useMemo<GridColumn<RosterShift>[]>(
    () => [
      { id: 'person', header: t('columns.person'), value: (row) => row.userName, hideable: false },
      {
        id: 'department',
        header: t('columns.department'),
        value: (row) => row.departmentName ?? '',
      },
      { id: 'kind', header: t('columns.kind'), value: (row) => t(`kind.${row.shiftKind}`) },
      { id: 'starts', header: t('columns.starts'), value: (row) => format.dateTime(row.startsAt) },
      { id: 'ends', header: t('columns.ends'), value: (row) => format.dateTime(row.endsAt) },
      {
        id: 'state',
        header: t('columns.state'),
        value: (row) => {
          if (row.status === 'cancelled') return t('state.cancelled');
          const flag = conflicts.get(row.id);
          return flag ? t(`conflict.${flag}`, { hours: MIN_REST_HOURS }) : t('state.scheduled');
        },
      },
    ],
    [t, format, conflicts],
  );

  const actions = useMemo<GridAction<RosterShift>[]>(
    () => [
      {
        id: 'cancel',
        label: t('cancel'),
        requires: 'roster:manage',
        disabled: (row) => row.status !== 'scheduled',
        onSelect: (row) => setCancellingId(row.id),
      },
    ],
    [t],
  );

  const flagged = [...conflicts.keys()].length;
  const lastDay = addDays(weekStart, 6);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <Can permission="roster:manage">
          <Button onClick={() => setAdding(true)}>{t('new.open')}</Button>
        </Can>
      </div>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <OnCallPanel />
      <div className="flex flex-wrap items-end gap-3">
        <div className="inline-flex items-center gap-2">
          <Button variant="outline" onClick={() => setWeekStart(addDays(weekStart, -7))}>
            {t('week.previous')}
          </Button>
          <Button variant="outline" onClick={() => setWeekStart(mondayOf(todayIn(timezone)))}>
            {t('week.current')}
          </Button>
          <Button variant="outline" onClick={() => setWeekStart(addDays(weekStart, 7))}>
            {t('week.next')}
          </Button>
        </div>
        {departments.available && (
          <div className="flex min-w-48 flex-col gap-1.5">
            <label htmlFor={departmentId} className="text-sm font-medium">
              {t('filter.department')}
            </label>
            <select
              id={departmentId}
              className={field}
              value={department}
              onChange={(event) => setDepartment(event.target.value)}
            >
              <option value="">{t('filter.all')}</option>
              {(departments.data ?? []).map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {[
          message.text,
          t('week.showing', {
            from: format.calendarDate(weekStart),
            to: format.calendarDate(lastDay),
          }),
          flagged > 0 ? t('conflict.count', { count: flagged }) : '',
        ]
          .filter(Boolean)
          .join(' ')}
      </p>
      <DataGrid
        label={t('heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.userName}
        actions={actions}
        status={shifts.isPending ? 'loading' : shifts.isError ? 'error' : 'ready'}
        errorMessage={shifts.isError ? tCommon(errorMessageKey(shifts.error)) : undefined}
        onRetry={() => void shifts.refetch()}
        emptyMessage={t('empty')}
        hasNextPage={shifts.hasNextPage && !shifts.isPlaceholderData}
        loadingMore={shifts.isFetchingNextPage}
        onLoadMore={() => void shifts.fetchNextPage()}
      />
      {adding && (
        <ShiftDialog
          day={
            todayIn(timezone) > lastDay || todayIn(timezone) < weekStart
              ? weekStart
              : todayIn(timezone)
          }
          onClose={() => setAdding(false)}
          onCreated={(created) => {
            setAdding(false);
            say(t('new.done', { name: created.userName }));
          }}
        />
      )}
      {cancelling && (
        <ConfirmDialog
          open
          onClose={() => setCancellingId(null)}
          title={t('cancelDialog.title', { name: cancelling.userName })}
          description={t('cancelDialog.description')}
          cancelLabel={t('close')}
          confirmLabel={t('cancelDialog.confirm')}
          destructive
          pending={cancel.isPending}
          onConfirm={() => {
            cancel.mutate(cancelling.version, {
              onSuccess: (done) => {
                setCancellingId(null);
                say(t('cancelDialog.done', { name: done.userName }));
              },
              onError: () => {
                setCancellingId(null);
                say(t('cancelDialog.failed'));
              },
            });
          }}
        />
      )}
    </div>
  );
}
