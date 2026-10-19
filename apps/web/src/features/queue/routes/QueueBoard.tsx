import { Radio, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Can, usePermission } from '@/access';
import { useSession } from '@/app/session';
import { useDepartmentOptions } from '@/features/departments';
import { useDoctorOptions } from '@/features/doctors';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import type { GridAction } from '@/shared/ui/data-grid';
import type { QueueAction } from '../api';
import { PriorityPanel } from '../components/PriorityPanel';
import { TokenGrid } from '../components/TokenGrid';
import { useQueueAction } from '../hooks/use-queue-actions';
import { FALLBACK_REFRESH_MS, useQueueEvents } from '../hooks/use-queue';
import { allowedActions } from '../schemas';
import type { QueueToken, QueueTokenStatus } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
const field = 'flex min-w-52 flex-col gap-1 text-sm font-medium';

/** The groups of the board, in the order they are shown. Served tokens are not on the board. */
const GROUPS = ['called', 'waiting', 'skipped'] as const satisfies readonly QueueTokenStatus[];

/** Refusals this screen has words for, as keys of the feature's strings. */
function refusalKey(error: unknown): string | null {
  if (!isApiError(error)) return null;
  if (error.serverCode === 'conflict' || error.serverCode === 'invalid_transition') {
    return 'refused.changed';
  }
  if (error.serverCode === 'queue_empty') return 'refused.empty';
  return null;
}

/** Whether the queue follows the server's events, said in words and an icon. */
function LiveStatus({ status }: { status: ReturnType<typeof useQueueEvents> }) {
  const { t } = useTranslation('queue');
  const seconds = FALLBACK_REFRESH_MS / 1000;
  const live = status === 'live';
  const Icon = live ? Radio : RefreshCw;
  return (
    <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      <Icon aria-hidden="true" className="size-4" />
      {live
        ? t('live.on')
        : status === 'stopped'
          ? t('live.off', { seconds })
          : status === 'retrying'
            ? t('live.retrying', { seconds })
            : t('live.connecting')}
    </p>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function QueueBoard() {
  const { t } = useTranslation('queue');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const session = useSession();
  const mayCall = usePermission('queue:call');
  const departments = useDepartmentOptions();
  const doctors = useDoctorOptions();
  const mine = doctors.data?.find((doctor) => doctor.userId === session?.user.id);

  const [departmentId, setDepartmentId] = useState('');
  // Null until someone chooses: a doctor sees their own queue first, everyone else the whole
  // hospital's. Choosing "every doctor" is a choice, and is kept.
  const [chosenDoctor, setChosenDoctor] = useState<string | null>(null);
  const doctorId = chosenDoctor ?? mine?.id ?? '';
  // Until the doctors are known, it is not known whose queue to show first.
  const doctorsSettled = !doctors.available || doctors.isSuccess || doctors.isError;
  const doctorChoices = (doctors.data ?? []).filter(
    (doctor) => departmentId === '' || doctor.departmentId === departmentId,
  );
  const doctor = doctors.data?.find((candidate) => candidate.id === doctorId);
  // A doctor's queue is all in their department: other departments' events are not for it.
  const shownDepartment = departmentId || doctor?.departmentId || '';

  const events = useQueueEvents(doctorsSettled, shownDepartment);
  const live = events === 'live';

  const action = useQueueAction();
  // What this person last did, said once in the status line; others' changes are not announced.
  const [done, setDone] = useState<{ text: string; at: number }>();
  const [panel, setPanel] = useState<QueueToken | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  usePanelFocus(panel, box, statusLine);
  // A row that moved to another group (skipped, recalled) took focus with it.
  useEffect(() => {
    if (done) focusIfLost(statusLine.current);
  }, [done]);

  const run = async (next: QueueAction, said: (token: QueueToken) => string) => {
    action.reset();
    setDone(undefined);
    try {
      const token = await action.mutateAsync(next);
      setPanel(null);
      setDone({ text: said(token), at: Date.now() });
    } catch (error) {
      // Shown from the mutation state. A token changed by someone else first closes its panel;
      // after a failure of the network the panel stays, with what was chosen in it.
      if (refusalKey(error) === 'refused.changed') setPanel(null);
      // The queue was read again: the row that had focus may have moved.
      focusIfLost(statusLine.current);
    }
  };

  const pending = action.isPending;
  const actionsFor = (() => {
    const name = (token: QueueToken) => ({ number: token.number, patient: token.patientName });
    const callAgain: GridAction<QueueToken> = {
      id: 'call-again',
      label: t('actions.callAgain'),
      requires: 'queue:call',
      disabled: (row) => pending || !allowedActions(row.status).callAgain,
      onSelect: (row) =>
        void run({ kind: 'call_again', tokenId: row.id, version: row.version }, (token) =>
          t('done.calledAgain', name(token)),
        ),
    };
    const skip: GridAction<QueueToken> = {
      id: 'skip',
      label: t('actions.skip'),
      requires: 'queue:call',
      disabled: (row) => pending || !allowedActions(row.status).skip,
      onSelect: (row) =>
        void run({ kind: 'skip', tokenId: row.id, version: row.version }, (token) =>
          t('done.skipped', name(token)),
        ),
    };
    const recall: GridAction<QueueToken> = {
      id: 'recall',
      label: t('actions.recall'),
      requires: 'queue:call',
      disabled: (row) => pending || !allowedActions(row.status).recall,
      onSelect: (row) =>
        void run({ kind: 'recall', tokenId: row.id, version: row.version }, (token) =>
          t('done.recalled', name(token)),
        ),
    };
    const priority: GridAction<QueueToken> = {
      id: 'priority',
      label: t('actions.priority'),
      requires: 'queue:call',
      disabled: (row) => pending || panel !== null || !allowedActions(row.status).priority,
      onSelect: (row) => setPanel(row),
    };
    return { called: [callAgain, skip], waiting: [priority], skipped: [recall, priority] };
  })();

  const refused = refusalKey(action.error);
  const enabled = doctorsSettled;

  return (
    <div ref={box} className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
          <p className="text-muted-foreground">{t('description')}</p>
          <LiveStatus status={events} />
        </div>
        <Can permission="queue:create">
          <Button asChild>
            <Link to="/queue/new">{t('issue.open')}</Link>
          </Button>
        </Can>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        {departments.available && (
          <label className={field}>
            {t('filters.department')}
            <select
              value={departmentId}
              onChange={(event) => {
                const next = event.target.value;
                setDepartmentId(next);
                // A doctor of another department is let go.
                const doctor = doctors.data?.find((candidate) => candidate.id === doctorId);
                if (next !== '' && doctor && doctor.departmentId !== next) setChosenDoctor('');
              }}
              className={control}
            >
              <option value="">{t('filters.allDepartments')}</option>
              {(departments.data ?? []).map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {doctors.available && (
          <label className={field}>
            {t('filters.doctor')}
            <select
              value={doctorId}
              onChange={(event) => setChosenDoctor(event.target.value)}
              className={control}
            >
              <option value="">{t('filters.allDoctors')}</option>
              {doctorChoices.map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.id === mine?.id ? t('filters.me', { name: doctor.name }) : doctor.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {mayCall && doctorId !== '' && (
          <Button
            type="button"
            aria-disabled={pending || undefined}
            onClick={() => {
              if (pending) return;
              void run({ kind: 'call_next', doctorId }, (token) =>
                t('done.called', { number: token.number, patient: token.patientName }),
              );
            }}
          >
            {doctor ? t('actions.callNextFor', { name: doctor.name }) : t('actions.callNext')}
          </Button>
        )}
      </div>

      {action.isError && (
        <p role="alert" className="text-sm text-destructive">
          {refused ? t(refused) : tCommon(errorMessageKey(action.error))}
        </p>
      )}
      {/* Always on the page, so a screen reader reads what is put in it; focusable, so focus has
          somewhere to go when the row it was on moves to another group. */}
      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm font-medium outline-none empty:sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {done?.text ?? ''}
      </p>

      {panel && (
        <PriorityPanel
          key={panel.id}
          token={panel}
          pending={pending}
          onCancel={() => setPanel(null)}
          onSave={(priority) =>
            void run(
              { kind: 'priority', tokenId: panel.id, version: panel.version, priority },
              (token) => t('done.priority', { number: token.number, patient: token.patientName }),
            )
          }
        />
      )}

      {GROUPS.map((status) => (
        <section key={status} aria-labelledby={`queue-${status}`} className="flex flex-col gap-2">
          <h2 id={`queue-${status}`} className="text-lg font-semibold">
            {t(`groups.${status}`)}
          </h2>
          <TokenGrid
            filters={{ departmentId, doctorId, status }}
            enabled={enabled}
            live={live}
            actions={actionsFor[status]}
          />
        </section>
      ))}
    </div>
  );
}
