import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessageKey, isApiError } from '@/shared/api';
import { DoctorForm } from '../components/DoctorForm';
import { StaffPicker } from '../components/StaffPicker';
import { useCreateDoctor } from '../hooks/use-doctors';
import type { DoctorFormValues } from '../schemas';
import type { DoctorCandidate } from '../types';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

/** What the server said, as a key of this feature's strings, when it has one. */
function refusal(error: unknown): 'create.exists' | 'create.invalid' | null {
  if (!isApiError(error)) return null;
  if (error.serverCode === 'doctor_exists') return 'create.exists';
  if (error.serverCode === 'validation_failed') return 'create.invalid';
  return null;
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function DoctorCreate() {
  const { t } = useTranslation('doctors');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const create = useCreateDoctor();
  const [staff, setStaff] = useState<DoctorCandidate | null>(null);
  const [staffMissing, setStaffMissing] = useState(false);
  const picker = useRef<HTMLDivElement>(null);

  const submit = async (values: DoctorFormValues) => {
    if (!staff) {
      setStaffMissing(true);
      return;
    }
    try {
      const doctor = await create.mutateAsync({
        userId: staff.userId,
        departmentId: values.departmentId,
        specialization: values.specialization,
        registrationNumber: values.registrationNumber || undefined,
        qualifications: values.qualifications || undefined,
        registrationCouncil: values.registrationCouncil || undefined,
        consultationMinutes: Number(values.consultationMinutes),
      });
      // Straight to the new profile, where the working hours are set.
      await navigate(`/doctors/${doctor.id}`, { replace: true });
    } catch (error) {
      // Shown from the mutation state below. Someone who has a profile now is no longer a choice.
      if (refusal(error) === 'create.exists') setStaff(null);
    }
  };

  const refused = refusal(create.error);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('create.heading')}</h1>
        <p className="text-muted-foreground">{t('create.description')}</p>
      </div>

      {create.isError && (
        <p role="alert" className="text-sm text-destructive">
          {refused ? t(refused) : tCommon(errorMessageKey(create.error))}
        </p>
      )}

      {/* Any attempt to save says so when nobody is chosen, together with the field messages. */}
      <div
        onSubmitCapture={() => {
          if (!staff) {
            setStaffMissing(true);
            // The person is the first thing to fix. The form's own check focuses the first invalid
            // field below this one, at once and again in a timeout of its own (React Hook Form),
            // so this waits one turn longer than that.
            setTimeout(() => {
              setTimeout(() => picker.current?.querySelector<HTMLElement>('input')?.focus(), 0);
            }, 0);
          }
        }}
      >
        <DoctorForm
          pending={create.isPending}
          submitLabel={t('create.submit')}
          onSubmit={submit}
          before={
            <div ref={picker}>
              <StaffPicker
                selected={staff}
                onSelect={(candidate) => {
                  setStaff(candidate);
                  setStaffMissing(false);
                }}
                error={staffMissing ? t('create.staffRequired') : undefined}
              />
            </div>
          }
          after={
            <Link to="/doctors" className={link}>
              {t('form.cancel')}
            </Link>
          }
        />
      </div>
    </div>
  );
}
