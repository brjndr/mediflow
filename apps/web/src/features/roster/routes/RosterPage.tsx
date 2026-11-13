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
import { CopyWeekDialog } from '../components/CopyWeekDialog';
import { LeavePanel } from '../components/LeavePanel';
import { OnCallPanel } from '../components/OnCallPanel';
import { ShiftDialog } from '../components/ShiftDialog';
import { SwapDialog } from '../components/SwapDialog';
import { TemplatesPanel } from '../components/TemplatesPanel';
import { useApprovedLeaves, useCancelShift, useShifts } from '../hooks/use-roster';
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
  const leaves = useApprovedLeaves(range);
  const leaveList = useMemo(() => leaves.data ?? [], [leaves.data]);
  const rows = useMemo(() => shifts.data?.pages.flatMap((page) => page.items) ?? [], [shifts.data]);
  const conflicts = useMemo(() => rosterConflicts(rows), [rows]);
  const [adding, setAdding] = useState(false);
  const [copying, setCopying] = useState(false);
  const [swappingId, setSwappingId] = useState<string | null>(null);
  const swapping = swappingId === null ? undefined : rows.find((row) => row.id === swappingId);
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
          if (
            leaveList.some(
              (one) =>
                one.userId === row.userId && one.startsAt < row.endsAt && one.endsAt > row.startsAt,
            )
          ) {
            return t('state.onLeave');
          }
          const flag = conflicts.get(row.id);
          return flag ? t(`conflict.${flag}`, { hours: MIN_REST_HOURS }) : t('state.scheduled');
        },
      },
    ],
    [t, format, conflicts, leaveList],
  );

  const actions = useMemo<GridAction<RosterShift>[]>(
    () => [
      {
        id: 'swap',
        label: t('swap.open'),
        requires: 'roster:manage',
        disabled: (row) => row.status !== 'scheduled',
        onSelect: (row) => setSwappingId(row.id),
      },
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
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setCopying(true)}>
              {t('copy.open')}
            </Button>
            <Button onClick={() => setAdding(true)}>{t('new.open')}</Button>
          </div>
        </Can>
      </div>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <OnCallPanel />
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap items-center gap-2">
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
          <div className="flex min-w-0 flex-col md:min-w-48 gap-1.5">
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
      {leaveList.length > 0 && (
        <section aria-labelledby="roster-week-leave" className="rounded-md border p-4">
          <h2 id="roster-week-leave" className="text-base font-semibold">
            {t('weekLeave.heading')}
          </h2>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {leaveList.map((one) => (
              <li key={one.id}>
                <span className="font-medium">{one.userName}</span>
                {' · '}
                {t('weekLeave.period', {
                  from: format.dateTime(one.startsAt),
                  to: format.dateTime(one.endsAt),
                })}
              </li>
            ))}
          </ul>
        </section>
      )}
      <TemplatesPanel say={say} />
      <LeavePanel today={todayIn(timezone)} />
      {copying && (
        <CopyWeekDialog
          weekStartUtc={dayBoundsUtc(weekStart, timezone).start}
          {...(department ? { departmentId: department } : {})}
          onClose={() => setCopying(false)}
        />
      )}
      {swapping && (
        <SwapDialog
          shift={swapping}
          others={rows.filter(
            (row) => row.status === 'scheduled' && row.userId !== swapping.userId,
          )}
          onClose={() => setSwappingId(null)}
          onDone={(text) => {
            setSwappingId(null);
            say(text);
          }}
        />
      )}
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
