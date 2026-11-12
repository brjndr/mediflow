import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Can, usePermission } from '@/access';
import { useSession } from '@/app/session';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { utcToZoned } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import type { LeaveMove } from '../api';
import { useLeaves, useMoveLeave } from '../hooks/use-roster';
import type { RosterLeave } from '../types';
import { LeaveDialog } from './LeaveDialog';

const REFUSED: Record<string, string> = {
  shifts_in_leave: 'leave.errors.shifts',
  own_request: 'leave.errors.own',
  conflict: 'leave.errors.changed',
  invalid_transition: 'leave.errors.changed',
};

/**
 * Leave requests on the roster page (#591): anyone with `roster:requestLeave` asks for days off;
 * `roster:manage` approves or rejects a request that is not their own. Approved leave keeps the
 * person off new shifts, and an approval waits until their shifts in that time are cancelled.
 */
export function LeavePanel({ today }: { today: string }) {
  const { t } = useTranslation('roster');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const me = useSession()?.user.id;
  const canManage = usePermission('roster:manage');
  const canRequest = usePermission('roster:requestLeave');
  const leaves = useLeaves();
  const rows = useMemo(() => leaves.data?.pages.flatMap((page) => page.items) ?? [], [leaves.data]);
  const [asking, setAsking] = useState(false);
  const move = useMoveLeave();
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const columns = useMemo<GridColumn<RosterLeave>[]>(() => {
    const firstDay = (leave: RosterLeave) => utcToZoned(leave.startsAt, timezone).day;
    // The period ends at the start of the day after the last one away.
    const lastDay = (leave: RosterLeave) =>
      utcToZoned(new Date(Date.parse(leave.endsAt) - 1).toISOString(), timezone).day;
    return [
      { id: 'person', header: t('columns.person'), value: (row) => row.userName, hideable: false },
      {
        id: 'from',
        header: t('leave.columns.from'),
        value: (row) => format.calendarDate(firstDay(row)),
      },
      {
        id: 'to',
        header: t('leave.columns.to'),
        value: (row) => format.calendarDate(lastDay(row)),
      },
      {
        id: 'state',
        header: t('columns.state'),
        value: (row) =>
          row.decidedByName
            ? t('leave.decidedBy', {
                state: t(`leave.state.${row.status}`),
                name: row.decidedByName,
              })
            : t(`leave.state.${row.status}`),
      },
    ];
  }, [t, format, timezone]);

  const actions = useMemo<GridAction<RosterLeave>[]>(() => {
    const run = (row: RosterLeave, kind: LeaveMove) =>
      move.mutate(
        { leaveId: row.id, move: kind, version: row.version },
        {
          onSuccess: (done) => say(t(`leave.done.${kind}`, { name: done.userName })),
          onError: (error) => {
            const code = isApiError(error) ? error.serverCode : undefined;
            say(
              code !== undefined && REFUSED[code]
                ? t(REFUSED[code])
                : tCommon(errorMessageKey(error)),
            );
          },
        },
      );
    return [
      {
        id: 'approve',
        label: t('leave.approve'),
        requires: 'roster:manage',
        disabled: (row) => row.status !== 'requested' || row.userId === me || move.isPending,
        onSelect: (row) => run(row, 'approve'),
      },
      {
        id: 'reject',
        label: t('leave.reject'),
        requires: 'roster:manage',
        disabled: (row) => row.status !== 'requested' || row.userId === me || move.isPending,
        onSelect: (row) => run(row, 'reject'),
      },
      {
        id: 'cancel',
        label: t('leave.withdraw'),
        disabled: (row) =>
          (row.status !== 'requested' && row.status !== 'approved') ||
          !(row.userId === me ? canRequest : canManage) ||
          move.isPending,
        onSelect: (row) => run(row, 'cancel'),
      },
    ];
  }, [t, tCommon, me, canManage, canRequest, move]);

  return (
    <section aria-labelledby="roster-leave" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="roster-leave" className="text-lg font-semibold">
          {t('leave.heading')}
        </h2>
        <Can permission="roster:requestLeave">
          <Button variant="outline" onClick={() => setAsking(true)}>
            {t('leave.new.open')}
          </Button>
        </Can>
      </div>
      <p className="text-sm text-muted-foreground">{t('leave.intro')}</p>
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {message.text}
      </p>
      <DataGrid
        label={t('leave.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.userName}
        actions={actions}
        status={leaves.isPending ? 'loading' : leaves.isError ? 'error' : 'ready'}
        errorMessage={leaves.isError ? tCommon(errorMessageKey(leaves.error)) : undefined}
        onRetry={() => void leaves.refetch()}
        emptyMessage={t('leave.empty')}
        hasNextPage={leaves.hasNextPage}
        loadingMore={leaves.isFetchingNextPage}
        onLoadMore={() => void leaves.fetchNextPage()}
      />
      {asking && (
        <LeaveDialog
          day={today}
          onClose={() => setAsking(false)}
          onRequested={() => {
            setAsking(false);
            say(t('leave.new.done'));
          }}
        />
      )}
    </section>
  );
}
