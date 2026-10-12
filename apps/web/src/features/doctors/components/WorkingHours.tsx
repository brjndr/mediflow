import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
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

      {editable && (
        <Button type="submit" className="self-start" disabled={pending} aria-busy={pending}>
          {t('hours.save')}
        </Button>
      )}
    </form>
  );
}

/** A doctor's regular weekly hours: read by anyone who may see the doctor, changed by a manager. */
export function WorkingHours({ doctorId }: { doctorId: string }) {
  const { t } = useTranslation('doctors');
  const { t: tCommon } = useTranslation();
  const editable = usePermission('doctor:manage');
  const availability = useAvailability(doctorId);
  // Held here, not in the editor: the editor starts again when a newer version arrives, and what
  // happened to the last save has to outlive that.
  const save = useSaveAvailability(doctorId);
  const [saved, setSaved] = useState(false);
  const conflict = isApiError(save.error) && save.error.serverCode === 'conflict';

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
      {availability.isError && availability.data === undefined && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border p-4 text-sm">
          <span className="flex-1">{t('hours.failed')}</span>
          <Button size="sm" variant="outline" onClick={() => void availability.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      )}
      {availability.data && (
        <HoursEditor
          // A newer version from the server (after a save or a conflict) starts the editor again.
          key={availability.data.version}
          availability={availability.data}
          editable={editable}
          pending={save.isPending}
          onEdit={() => {
            setSaved(false);
            if (save.isError) save.reset();
          }}
          onSave={(sessions) => {
            setSaved(false);
            save.mutate(
              { sessions, expectedVersion: availability.data.version },
              { onSuccess: () => setSaved(true) },
            );
          }}
        />
      )}
      {save.isError && (
        <p role="alert" className="text-sm text-destructive">
          {conflict ? t('hours.conflict') : tCommon(errorMessageKey(save.error))}
        </p>
      )}
      <p role="status" className="text-sm text-muted-foreground">
        {saved ? t('hours.saved') : ''}
      </p>
    </section>
  );
}
