import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { useFeatureFlag, usePermission } from '@/access';
import { useDepartmentOptions } from '@/features/departments';
import { useDoctorOptions } from '@/features/doctors';
import { PatientSearch, usePatientName, type PatientName } from '@/features/patients';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import {
  Form,
  SelectField,
  SubmitButton,
  useFieldError,
  useFieldFocusRef,
  useFieldValue,
  useSetFieldValue,
  useZodForm,
} from '@/shared/ui/form';
import { useIssueToken } from '../hooks/use-queue-actions';
import { issueSchema, PRIORITIES, type IssueValues } from '../schemas';
import type { QueueToken, QueueTokenCreate } from '../types';

function toRequest(values: IssueValues): QueueTokenCreate {
  return {
    patientId: values.patientId,
    departmentId: values.departmentId,
    ...(values.doctorId ? { doctorId: values.doctorId } : {}),
    ...(values.priority ? { priority: values.priority } : {}),
  };
}

/** Refusals this screen has words for, as keys of the feature's strings. */
const REFUSALS: Record<string, string> = {
  already_queued: 'issue.refused.alreadyQueued',
  doctor_not_in_department: 'issue.refused.doctorNotInDepartment',
  unknown_patient: 'issue.refused.unknownPatient',
};

/** The chosen patient, or the box to find one. The form holds the id; the name is for show. */
function PatientChoice({
  patient,
  onChange,
  focusSearch,
}: {
  patient: PatientName | undefined;
  onChange: (patient: PatientName | undefined) => void;
  /** Whether the search box takes focus when it appears ("Issue another"). */
  focusSearch: boolean;
}) {
  const { t } = useTranslation('queue');
  const setValue = useSetFieldValue();
  const error = useFieldError('patientId');
  // Not a kit field: a failed submit still focuses it first, as the first field of the form.
  const focusRef = useFieldFocusRef('patientId');
  const errorId = 'issue-patient-error';
  const card = useRef<HTMLDivElement>(null);
  // Where focus goes when one control replaces the other, so it is never left on the page.
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    if (moved && patient) card.current?.querySelector('button')?.focus();
  }, [moved, patient]);

  const choose = (next: PatientName | undefined) => {
    setMoved(true);
    onChange(next);
    setValue('patientId', next?.id ?? '');
  };

  return (
    <div ref={focusRef} className="flex flex-col gap-1.5">
      {patient ? (
        <>
          <p className="text-sm font-medium">{t('issue.patient')}</p>
          <div
            ref={card}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
          >
            <div className="min-w-0">
              <p className="break-words font-medium">
                {patient.firstName} {patient.lastName}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('issue.patientMrn', { mrn: patient.mrn })}
              </p>
            </div>
            <Button type="button" variant="outline" onClick={() => choose(undefined)}>
              {t('issue.changePatient')}
            </Button>
          </div>
        </>
      ) : (
        <PatientSearch
          label={t('issue.patient')}
          onSelect={choose}
          describedBy={error ? errorId : undefined}
          focusOnMount={moved || focusSearch}
          required
        />
      )}
      {error && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** The doctors of the chosen department, optional: a token for no doctor goes to any of them. */
function DoctorField() {
  const { t } = useTranslation('queue');
  const { t: tCommon } = useTranslation();
  const doctors = useDoctorOptions();
  const departmentId = String(useFieldValue('departmentId') ?? '');
  const doctorId = String(useFieldValue('doctorId') ?? '');
  const setValue = useSetFieldValue();
  const listed = doctors.data;
  const choices = useMemo(
    () => (listed ?? []).filter((doctor) => doctor.departmentId === departmentId),
    [listed, departmentId],
  );
  // A doctor of another department is let go when the department changes.
  useEffect(() => {
    if (doctorId !== '' && listed && !choices.some((doctor) => doctor.id === doctorId)) {
      setValue('doctorId', '');
    }
  }, [doctorId, listed, choices, setValue]);
  if (!doctors.available || departmentId === '') return null;
  return (
    <>
      <SelectField<IssueValues>
        name="doctorId"
        label={t('issue.doctor')}
        hint={t('issue.doctorHint')}
        // Not "Any doctor" while the list is not there: that would look like a choice.
        placeholder={doctors.isPending ? t('issue.doctorsLoading') : t('anyDoctor')}
        options={choices.map((doctor) => ({ value: doctor.id, label: doctor.name }))}
      />
      {doctors.isError && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(doctors.error))}
        </p>
      )}
    </>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function QueueIssue() {
  const { t } = useTranslation('queue');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const departments = useDepartmentOptions();
  // Finding a patient is the patients feature's: switched on, and open to this person.
  const canReadPatients = usePermission('patient:read');
  const patientsOn = useFeatureFlag('patients');
  const canFindPatients = canReadPatients && patientsOn;
  // The patient whose screen this was opened from (`?patientId`): an id only, never a name.
  const [params] = useSearchParams();
  const [askedId] = useState(() => {
    const id = params.get('patientId') ?? '';
    return /^[\w-]{1,64}$/.test(id) ? id : '';
  });
  const asked = usePatientName(canFindPatients ? askedId : '');
  const issue = useIssueToken();

  const form = useZodForm(issueSchema, {
    patientId: '',
    departmentId: '',
    doctorId: '',
    priority: '',
  });
  // Kept in memory only, never in the address or browser storage.
  const [patient, setPatient] = useState<PatientName>();
  const [issued, setIssued] = useState<QueueToken>();
  const [another, setAnother] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  // The patient asked for is chosen once, when known; a patient chosen meanwhile is kept.
  const askedPatient = asked.data;
  const [usedAsked, setUsedAsked] = useState(false);
  if (askedPatient && !usedAsked) {
    setUsedAsked(true);
    if (!patient) setPatient(askedPatient);
  }
  useEffect(() => {
    if (patient && form.getValues('patientId') !== patient.id)
      // Checked again after a failed submit, so "Choose the patient." does not stay.
      form.setValue('patientId', patient.id, { shouldValidate: form.formState.isSubmitted });
  }, [patient, form]);

  // After issuing, move focus to the confirmation so a screen reader announces it.
  useEffect(() => {
    if (issued) heading.current?.focus();
  }, [issued]);

  const submit = async (values: IssueValues) => {
    issue.reset();
    try {
      setIssued(await issue.mutateAsync(toRequest(values)));
    } catch {
      // Shown from the mutation state.
    }
  };

  const issueAnother = () => {
    setAnother(true);
    setIssued(undefined);
    setPatient(undefined);
    issue.reset();
    form.reset({
      patientId: '',
      departmentId: form.getValues('departmentId'),
      doctorId: form.getValues('doctorId'),
      priority: '',
    });
  };

  if (issued) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-6">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight">
          {t('issue.issued.heading', { number: issued.number })}
        </h1>
        <p role="status">
          {t('issue.issued.summary', {
            number: issued.number,
            patient: issued.patientName,
            department: issued.departmentName,
            doctor: issued.doctorName ?? t('anyDoctor'),
          })}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={issueAnother}>
            {t('issue.issued.another')}
          </Button>
          <Button asChild variant="outline">
            <Link to="/queue">{t('issue.back')}</Link>
          </Button>
        </div>
      </div>
    );
  }

  const unavailable = !departments.available
    ? 'issue.unavailable.departments'
    : !canFindPatients
      ? 'issue.unavailable.patients'
      : null;
  const serverCode = isApiError(issue.error) ? issue.error.serverCode : undefined;
  const refused = serverCode ? REFUSALS[serverCode] : undefined;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('issue.heading')}</h1>
        <p className="text-muted-foreground">{t('issue.description')}</p>
      </div>

      {unavailable ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm">
            {t(unavailable)}
          </p>
          <Button asChild variant="outline">
            <Link to="/queue">{t('issue.back')}</Link>
          </Button>
        </div>
      ) : (
        <Form form={form} onSubmit={submit}>
          {asked.isError && !patient && (
            <p role="alert" className="text-sm">
              {t('issue.askedNotFound')}
            </p>
          )}
          <PatientChoice
            patient={patient}
            focusSearch={another}
            onChange={(next) => {
              setPatient(next);
              issue.reset();
            }}
          />
          <SelectField<IssueValues>
            name="departmentId"
            label={t('issue.department')}
            required
            placeholder={
              departments.isPending ? t('issue.departmentsLoading') : t('issue.chooseDepartment')
            }
            options={(departments.data ?? []).map((department) => ({
              value: department.id,
              label: department.name,
            }))}
          />
          {departments.isError && (
            <p role="alert" className="text-sm text-destructive">
              {tCommon(errorMessageKey(departments.error))}
            </p>
          )}
          <DoctorField />
          <SelectField<IssueValues>
            name="priority"
            label={t('issue.priority')}
            hint={t('issue.priorityHint')}
            placeholder={t('priority.none')}
            options={PRIORITIES.map((value) => ({ value, label: t(`priority.${value}`) }))}
          />

          {issue.isError && (
            <p role="alert" className="text-sm text-destructive">
              {refused ? t(refused) : tCommon(errorMessageKey(issue.error))}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <SubmitButton pending={issue.isPending}>
              {issue.isPending ? t('issue.submitting') : t('issue.submit')}
            </SubmitButton>
            <Button asChild variant="outline">
              <Link to="/queue">{t('issue.cancel')}</Link>
            </Button>
          </div>
        </Form>
      )}
    </div>
  );
}
