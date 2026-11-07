import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { usePermission } from '@/access';
import { Button } from '@/shared/ui/button';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import type { GridAction } from '@/shared/ui/data-grid';
import type { BedAction } from '../api';
import { BedGrid } from '../components/BedGrid';
import { BlockPanel } from '../components/BlockPanel';
import { LiveStatus } from '../components/LiveStatus';
import { useBedAction, useBedEvents, useWardOptions } from '../hooks/use-board';
import { allowedActions, BOARD_STATUSES } from '../schemas';
import type { BoardBed, BoardBedStatus } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
const field = 'flex min-w-52 flex-col gap-1 text-sm font-medium';

/** Refusals this screen has words for, as keys of the feature's strings. */
function refusalKey(error: unknown): string | null {
  if (!isApiError(error)) return null;
  if (
    error.serverCode === 'conflict' ||
    error.serverCode === 'invalid_transition' ||
    error.serverCode === 'bed_not_available' ||
    error.serverCode === 'bed_not_blocked'
  ) {
    return 'refused.changed';
  }
  return null;
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function BedBoard() {
  const { t } = useTranslation('admissions');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const mayWards = usePermission('ward:read');
  const wards = useWardOptions(mayWards);

  const [wardId, setWardId] = useState('');
  const [status, setStatus] = useState<BoardBedStatus | ''>('');
  const events = useBedEvents(true, wardId);
  const live = events === 'live';

  const action = useBedAction();
  // What this person last did, said once in the status line; others' changes are not announced.
  const [done, setDone] = useState<{ text: string; at: number }>();
  const [blocking, setBlocking] = useState<BoardBed | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  usePanelFocus(blocking, box, statusLine);
  // A row that changed status may have left the filtered list and taken focus with it.
  useEffect(() => {
    if (done) focusIfLost(statusLine.current);
  }, [done]);

  const run = async (next: BedAction, said: string) => {
    action.reset();
    setDone(undefined);
    try {
      await action.mutateAsync(next);
      setBlocking(null);
      setDone({ text: said, at: Date.now() });
    } catch (error) {
      if (refusalKey(error) === 'refused.changed') setBlocking(null);
      focusIfLost(statusLine.current);
    }
  };

  const pending = action.isPending;
  const actions: GridAction<BoardBed>[] = [
    {
      id: 'mark-cleaning',
      label: t('actions.markCleaning'),
      requires: 'bed:update',
      disabled: (row) => pending || !allowedActions(row.status).markCleaning,
      onSelect: (row) =>
        void run(
          { kind: 'housekeeping', bed: row, status: 'cleaning' },
          t('done.cleaning', { number: row.number }),
        ),
    },
    {
      id: 'mark-ready',
      label: t('actions.markReady'),
      requires: 'bed:update',
      disabled: (row) => pending || !allowedActions(row.status).markReady,
      onSelect: (row) =>
        void run(
          { kind: 'housekeeping', bed: row, status: 'available' },
          t('done.ready', { number: row.number }),
        ),
    },
    {
      id: 'block',
      label: t('actions.block'),
      requires: 'ward:manage',
      disabled: (row) => pending || blocking !== null || !allowedActions(row.status).block,
      onSelect: (row) => setBlocking(row),
    },
    {
      id: 'unblock',
      label: t('actions.unblock'),
      requires: 'ward:manage',
      disabled: (row) => pending || !allowedActions(row.status).unblock,
      onSelect: (row) =>
        void run({ kind: 'unblock', bed: row }, t('done.unblocked', { number: row.number })),
    },
  ];

  const refused = refusalKey(action.error);

  return (
    <div ref={box} className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
          <p className="text-muted-foreground">{t('description')}</p>
          <LiveStatus status={events} />
        </div>
        <Button asChild variant="outline">
          <Link to="/admissions">{t('admissionsLink')}</Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        {mayWards && wards.isSuccess && (
          <label className={field}>
            {t('filters.ward')}
            <select
              value={wardId}
              onChange={(event) => setWardId(event.target.value)}
              className={control}
            >
              <option value="">{t('filters.allWards')}</option>
              {wards.data.map((ward) => (
                <option key={ward.id} value={ward.id}>
                  {ward.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={field}>
          {t('filters.status')}
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as BoardBedStatus | '')}
            className={control}
          >
            <option value="">{t('filters.allStatuses')}</option>
            {BOARD_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`status.${value}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {action.isError && (
        <p role="alert" className="text-sm text-destructive">
          {refused ? t(refused) : tCommon(errorMessageKey(action.error))}
        </p>
      )}
      {/* Always on the page, so a screen reader reads what is put in it; focusable, so focus has
          somewhere to go when the row it was on leaves the list. */}
      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm font-medium outline-none empty:sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {done?.text ?? ''}
      </p>

      {blocking && (
        <BlockPanel
          key={blocking.id}
          bed={blocking}
          pending={pending}
          onBack={() => setBlocking(null)}
          onSubmit={(reason) =>
            void run(
              { kind: 'block', bed: blocking, reason },
              t('done.blocked', { number: blocking.number }),
            )
          }
        />
      )}

      <BedGrid filters={{ wardId, status }} live={live} actions={actions} />
    </div>
  );
}
