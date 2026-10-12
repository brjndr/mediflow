import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { PageSkeleton } from '@/shared/ui/page-skeleton';
import { SystemPage } from '@/shared/ui/system-page';
import { DoctorForm } from '../components/DoctorForm';
import { WorkingHours } from '../components/WorkingHours';
import { useDoctor, useUpdateDoctor } from '../hooks/use-doctors';
import type { DoctorFormValues } from '../schemas';
import type { Doctor } from '../types';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

/** The profile, with what a manager may do to it. */
function Profile({ doctor }: { doctor: Doctor }) {
  const { t } = useTranslation('doctors');
  const { t: tCommon } = useTranslation();
  const update = useUpdateDoctor(doctor.id);
  const [editing, setEditing] = useState(false);
  // What was just done, said once in a status line.
  const [done, setDone] = useState<string | null>(null);

  const start = (next: boolean) => {
    update.reset();
    setDone(null);
    setEditing(next);
  };

  const save = async (values: DoctorFormValues) => {
    setDone(null);
    try {
      await update.mutateAsync({
        departmentId: values.departmentId,
        specialization: values.specialization,
        registrationNumber: values.registrationNumber,
        consultationMinutes: Number(values.consultationMinutes),
        expectedVersion: doctor.version,
      });
      setEditing(false);
      setDone(t('detail.saved'));
    } catch (error) {
      // The version on screen is out of date: the form closes on the refreshed profile.
      if (isApiError(error) && error.serverCode === 'conflict') setEditing(false);
    }
  };

  const setActive = (active: boolean) => {
    setDone(null);
    setEditing(false);
    update.mutate(
      { active, expectedVersion: doctor.version },
      {
        onSuccess: (saved) =>
          setDone(t(active ? 'detail.activated' : 'detail.deactivated', { name: saved.name })),
      },
    );
  };

  const conflict = isApiError(update.error) && update.error.serverCode === 'conflict';

  return (
    <section aria-labelledby="doctor-profile" className="flex flex-col gap-3">
      <h2 id="doctor-profile" className="text-lg font-semibold">
        {t('detail.profile')}
      </h2>
      {!doctor.active && (
        <p className="text-sm text-muted-foreground">{t('detail.inactiveNote')}</p>
      )}
      {update.isError && (
        <p role="alert" className="text-sm text-destructive">
          {conflict ? t('detail.conflict') : tCommon(errorMessageKey(update.error))}
        </p>
      )}
      <p role="status" className="text-sm text-muted-foreground">
        {done ?? ''}
      </p>

      {editing ? (
        <DoctorForm
          // A newer version of the profile is a new form.
          key={doctor.version}
          editing={doctor}
          pending={update.isPending}
          submitLabel={t('form.save')}
          onSubmit={save}
          after={
            <Button
              type="button"
              variant="outline"
              disabled={update.isPending}
              onClick={() => start(false)}
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
              <Button variant="outline" disabled={update.isPending} onClick={() => start(true)}>
                {t('detail.edit')}
              </Button>
              <Button
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
      <Profile doctor={record} />
      <WorkingHours doctorId={record.id} />
    </div>
  );
}
