import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { useAvailability, useSaveAvailability } from '../hooks/use-doctors';
import { hoursProblems, WEEKDAYS } from '../schemas';
import type { DoctorAvailability, DoctorSession, Weekday } from '../types';

/** A session being edited. The key only tells rows apart on screen. */
interface Row extends DoctorSession {
  key: number;
}

const timeInput =
  'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';

interface EditorProps {
  availability: DoctorAvailability;
  editable: boolean;
  pending: boolean;
  /** Saves these hours from the version the editor opened with. */
  onSave: (sessions: DoctorSession[]) => void;
  /** Something was changed: what was said about the last save no longer holds. */
  onEdit: () => void;
}

/** The week, a day at a time. Works from the hours as they were when it opened. */
function HoursEditor({ availability, editable, pending, onSave, onEdit }: EditorProps) {
  const { t } = useTranslation('doctors');
  const [rows, setRows] = useState<Row[]>(() =>
    availability.sessions.map((session, key) => ({ ...session, key })),
  );
  const [nextKey, setNextKey] = useState(availability.sessions.length);
  // Problems show once saving was tried, then follow the typing.
  const [checked, setChecked] = useState(false);

  const sessions = rows.map(({ day, start, end }) => ({ day, start, end }));
  const problems = checked ? hoursProblems(sessions) : {};

  const change = (next: Row[]) => {
    onEdit();
    setRows(next);
  };
  const add = (day: Weekday) => {
    change([...rows, { key: nextKey, day, start: '', end: '' }]);
    setNextKey(nextKey + 1);
  };

  const submit = () => {
    setChecked(true);
    if (Object.keys(hoursProblems(sessions)).length === 0) onSave(sessions);
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <fieldset disabled={pending} className="contents">
        <ul className="flex flex-col divide-y rounded-lg border">
          {WEEKDAYS.map((day) => {
            const dayName = t(`hours.days.${day}`);
            const ofDay = rows.filter((row) => row.day === day);
            const problem = problems[day];
            return (
              <li key={day} className="flex flex-col gap-2 p-3 md:flex-row md:items-start md:gap-4">
                <h3 className="w-28 shrink-0 pt-1 text-sm font-medium">{dayName}</h3>
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  {ofDay.length === 0 && (
                    <p className="pt-1 text-sm text-muted-foreground">{t('hours.dayOff')}</p>
                  )}
                  {ofDay.map((row, index) => {
                    const n = index + 1;
                    const set = (field: 'start' | 'end', value: string) =>
                      change(rows.map((r) => (r.key === row.key ? { ...r, [field]: value } : r)));
                    return (
                      <div key={row.key} className="flex flex-wrap items-center gap-2 text-sm">
                        {editable ? (
                          <>
                            <input
                              type="time"
                              aria-label={t('hours.fromFor', { day: dayName, n })}
                              aria-invalid={problem ? true : undefined}
                              value={row.start}
                              onChange={(event) => set('start', event.target.value)}
                              className={timeInput}
                            />
                            <span aria-hidden="true">–</span>
                            <input
                              type="time"
                              aria-label={t('hours.toFor', { day: dayName, n })}
                              aria-invalid={problem ? true : undefined}
                              value={row.end}
                              onChange={(event) => set('end', event.target.value)}
                              className={timeInput}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={t('hours.removeFor', { day: dayName, n })}
                              onClick={() => change(rows.filter((r) => r.key !== row.key))}
                            >
                              {t('hours.remove')}
                            </Button>
                          </>
                        ) : (
                          <span>
                            {row.start} – {row.end}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {problem && (
                    <p role="alert" className="text-sm text-destructive">
                      {t(problem)}
                    </p>
                  )}
                  {editable && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="self-start"
                      aria-label={t('hours.addFor', { day: dayName })}
                      onClick={() => add(day)}
                    >
                      {t('hours.add')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </fieldset>

      {editable && (
        <Button
          type="submit"
          className="self-start"
          aria-disabled={pending || undefined}
          aria-busy={pending}
        >
          {t('hours.save')}
        </Button>
      )}
    </form>
  );
}

const problem =
  'rounded-sm text-sm text-destructive outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/** A doctor's regular weekly hours: read by anyone who may see the doctor, changed by a manager. */
export function WorkingHours({ doctorId }: { doctorId: string }) {
  const { t } = useTranslation('doctors');
  const { t: tCommon } = useTranslation();
  const editable = usePermission('doctor:manage');
  const availability = useAvailability(doctorId);
  const save = useSaveAvailability(doctorId);
  const [saved, setSaved] = useState(false);
  // What the editor works from: the hours as they were when it opened, not the live query, so a
  // refresh in the background never takes away what is being typed. `round` starts the editor
  // again when a newer version is taken up.
  const [base, setBase] = useState<DoctorAvailability | null>(null);
  const [round, setRound] = useState(0);
  const [dirty, setDirty] = useState(false);
  // The version a save is made from. After a conflict it moves to the newest one while the typed
  // hours stay, so saving again replaces what the other person saved, knowingly.
  const [expected, setExpected] = useState(0);
  const [conflict, setConflict] = useState<'none' | 'awaiting' | 'shown'>('none');

  const latest = availability.data;
  if (latest && (base === null || (!dirty && latest.version !== base.version))) {
    setBase(latest);
    setExpected(latest.version);
    setRound(round + 1);
  } else if (latest && conflict === 'awaiting' && latest.version !== expected) {
    setExpected(latest.version);
    setConflict('shown');
  }

  const failed = save.isError && !(isApiError(save.error) && save.error.serverCode === 'conflict');

  // Saving disables the editor and a save starts it again from the saved hours, so what had
  // focus is gone: the keyboard goes to the line that says how it went.
  const statusLine = useRef<HTMLParagraphElement>(null);
  const problemLine = useRef<HTMLParagraphElement>(null);
  const refused = conflict !== 'none' || failed;
  useEffect(() => {
    if (saved) focusIfLost(statusLine.current);
    else if (refused) focusIfLost(problemLine.current);
  }, [saved, refused]);

  return (
    <section aria-labelledby="doctor-hours" className="flex flex-col gap-3">
      <div className="space-y-1">
        <h2 id="doctor-hours" className="text-lg font-semibold">
          {t('hours.heading')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('hours.description')}</p>
      </div>
      {availability.isPending && (
        <div role="status">
          <span className="sr-only">{t('hours.loading')}</span>
          <Skeleton className="h-40 w-full" />
        </div>
      )}
      {availability.isError && latest === undefined && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border p-4 text-sm">
          <span className="flex-1">{t('hours.failed')}</span>
          <Button size="sm" variant="outline" onClick={() => void availability.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      )}
      {base && (
        <HoursEditor
          key={round}
          availability={base}
          editable={editable}
          // Until the newest version is known after a conflict, a save would only conflict again.
          pending={save.isPending || conflict === 'awaiting'}
          onEdit={() => {
            setSaved(false);
            setDirty(true);
            if (failed) save.reset();
          }}
          onSave={(sessions) => {
            setSaved(false);
            save.mutate(
              { sessions, expectedVersion: expected },
              {
                onSuccess: () => {
                  // Clean again, so the saved version is taken up and shown.
                  setDirty(false);
                  setConflict('none');
                  setSaved(true);
                },
                onError: (error) => {
                  if (isApiError(error) && error.serverCode === 'conflict') {
                    setDirty(true);
                    setConflict('awaiting');
                  }
                },
              },
            );
          }}
        />
      )}
      {conflict !== 'none' && (
        <p ref={problemLine} tabIndex={-1} role="alert" className={problem}>
          {t('hours.conflict')}
        </p>
      )}
      {failed && (
        <p
          ref={conflict === 'none' ? problemLine : undefined}
          tabIndex={-1}
          role="alert"
          className={problem}
        >
          {tCommon(errorMessageKey(save.error))}
        </p>
      )}
      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {saved ? t('hours.saved') : ''}
      </p>
    </section>
  );
}
