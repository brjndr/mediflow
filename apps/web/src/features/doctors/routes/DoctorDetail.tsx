import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { PageSkeleton } from '@/shared/ui/page-skeleton';
import { SystemPage } from '@/shared/ui/system-page';
import { DoctorForm } from '../components/DoctorForm';
import { WorkingHours } from '../components/WorkingHours';
import { useDoctor, useUpdateDoctor } from '../hooks/use-doctors';
import type { DoctorField, DoctorFormValues } from '../schemas';
import type { Doctor, DoctorUpdate } from '../types';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

/** The fields the person changed, as the API takes them. */
function changes(values: DoctorFormValues, changed: DoctorField[]): Partial<DoctorUpdate> {
  const all = {
    departmentId: values.departmentId,
    specialization: values.specialization,
    registrationNumber: values.registrationNumber,
    consultationMinutes: Number(values.consultationMinutes),
  } satisfies Partial<DoctorUpdate>;
  return Object.fromEntries(changed.map((field) => [field, all[field]]));
}

/** The profile, with what a manager may do to it. */
function Profile({ doctor }: { doctor: Doctor }) {
  const { t } = useTranslation('doctors');
  const { t: tCommon } = useTranslation();
  const update = useUpdateDoctor(doctor.id);
  // The profile as it was when the form opened: the form works from this snapshot, so a refresh
  // in the background never changes what is being typed over.
  const [editing, setEditing] = useState<Doctor | null>(null);
  // The version a save is made from. After a conflict it moves to the newest one while the form
  // keeps what was typed, and only the fields the person changed are sent again.
  const [expected, setExpected] = useState(doctor.version);
  const [conflict, setConflict] = useState<'none' | 'awaiting' | 'shown'>('none');
  // What was just done, said once in a status line.
  const [done, setDone] = useState<string | null>(null);

  if (conflict === 'awaiting' && doctor.version !== expected) {
    setExpected(doctor.version);
    setConflict('shown');
  }

  const start = (next: Doctor | null) => {
    update.reset();
    setDone(null);
    setConflict('none');
    setExpected(doctor.version);
    setEditing(next);
  };

  const save = async (values: DoctorFormValues, changed: DoctorField[]) => {
    setDone(null);
    // Nothing was changed: there is nothing to send.
    if (changed.length === 0) return start(null);
    try {
      await update.mutateAsync({ ...changes(values, changed), expectedVersion: expected });
      setEditing(null);
      setConflict('none');
      setDone(t('detail.saved'));
    } catch (error) {
      if (isApiError(error) && error.serverCode === 'conflict') setConflict('awaiting');
    }
  };

  const setActive = (active: boolean) => {
    setDone(null);
    update.mutate(
      { active, expectedVersion: doctor.version },
      {
        onSuccess: (saved) =>
          setDone(t(active ? 'detail.activated' : 'detail.deactivated', { name: saved.name })),
      },
    );
  };

  const conflicted = isApiError(update.error) && update.error.serverCode === 'conflict';

  // The form and the buttons take each other's place, so the keyboard follows: to the profile's
  // heading when the form opens (its department list is drawn again when its options arrive, so
  // a field would lose focus), back to Edit when it closes, and back to the button after a change
  // of status (it is disabled while saving, which drops focus to the page).
  const box = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const isEditing = editing !== null;
  const wasEditing = useRef(false);
  useEffect(() => {
    if (isEditing) {
      wasEditing.current = true;
      heading.current?.focus();
    } else if (wasEditing.current) {
      wasEditing.current = false;
      focusIfLost(box.current?.querySelector<HTMLElement>('[data-opens="edit"]'));
    }
  }, [isEditing]);
  useEffect(() => {
    if (!isEditing) focusIfLost(box.current?.querySelector<HTMLElement>('[data-toggle]'));
  }, [done, update.isError, isEditing]);

  return (
    <section ref={box} aria-labelledby="doctor-profile" className="flex flex-col gap-3">
      <h2
        id="doctor-profile"
        ref={heading}
        tabIndex={-1}
        className="rounded-sm text-lg font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {t('detail.profile')}
      </h2>
      {!doctor.active && (
        <p className="text-sm text-muted-foreground">{t('detail.inactiveNote')}</p>
      )}
      {(conflict !== 'none' || conflicted) && (
        <p role="alert" className="text-sm text-destructive">
          {t(editing ? 'detail.conflict' : 'detail.conflictToggle')}
        </p>
      )}
      {update.isError && !conflicted && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(update.error))}
        </p>
      )}
      <p role="status" className="text-sm text-muted-foreground">
        {done ?? ''}
      </p>

      {editing ? (
        <DoctorForm
          editing={editing}
          // Until the newest version is known after a conflict, a save would only conflict again.
          pending={update.isPending || conflict === 'awaiting'}
          submitLabel={t('form.save')}
          onSubmit={save}
          after={
            <Button
              type="button"
              variant="outline"
              disabled={update.isPending}
              onClick={() => start(null)}
            >
              {t('form.cancel')}
            </Button>
          }
        />
      ) : (
        <>
          <dl className="grid max-w-xl grid-cols-1 gap-x-6 gap-y-3 text-sm md:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">{t('columns.department')}</dt>
              <dd className="break-words">{doctor.departmentName}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('columns.specialization')}</dt>
              <dd className="break-words">{doctor.specialization}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('form.registrationNumber')}</dt>
              <dd className="break-words">{doctor.registrationNumber || t('detail.notGiven')}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('columns.consultation')}</dt>
              <dd>{t('minutes', { count: doctor.consultationMinutes })}</dd>
            </div>
          </dl>
          <Can permission="doctor:manage">
            <div className="flex flex-wrap gap-3">
              <Button
                data-opens="edit"
                variant="outline"
                disabled={update.isPending}
                onClick={() => start(doctor)}
              >
                {t('detail.edit')}
              </Button>
              <Button
                data-toggle
                variant="outline"
                disabled={update.isPending}
                onClick={() => setActive(!doctor.active)}
              >
                {t(doctor.active ? 'detail.deactivate' : 'detail.activate')}
              </Button>
            </div>
          </Can>
        </>
      )}
    </section>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function DoctorDetail() {
  const { t } = useTranslation('doctors');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const { doctorId = '' } = useParams();
  const doctor = useDoctor(doctorId);

  const back = (
    <Link to="/doctors" className={link}>
      {t('backToList')}
    </Link>
  );

  if (doctor.isPending) return <PageSkeleton label={t('detail.loading')} />;

  // Only when there is nothing to show: a failed background refresh leaves the profile on screen.
  if (doctor.data === undefined) {
    // One answer for a doctor that does not exist and one of another hospital.
    if (isApiError(doctor.error) && doctor.error.code === 'not_found') {
      return (
        <SystemPage
          title={t('detail.notFoundTitle')}
          description={t('detail.notFoundBody')}
          actions={back}
        />
      );
    }
    return (
      <SystemPage
        alert
        title={t('detail.errorTitle')}
        description={tCommon(errorMessageKey(doctor.error))}
        actions={
          isApiError(doctor.error) && doctor.error.code === 'forbidden' ? undefined : (
            <Button variant="outline" onClick={() => void doctor.refetch()}>
              {tCommon('grid.retry')}
            </Button>
          )
        }
      />
    );
  }

  const record = doctor.data;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
      <div className="space-y-1">
        {back}
        <h1 className="text-2xl font-semibold tracking-tight break-words">{record.name}</h1>
        <p className="text-muted-foreground">
          {record.departmentName}
          {!record.active && (
            <span className="ml-2 rounded-full border px-2 py-0.5 text-xs font-medium">
              {t('detail.inactive')}
            </span>
          )}
        </p>
      </div>
      <Profile key={record.id} doctor={record} />
      <WorkingHours key={record.id} doctorId={record.id} />
    </div>
  );
}
