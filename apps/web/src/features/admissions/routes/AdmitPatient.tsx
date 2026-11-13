import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { useSession } from '@/app/session';
import { useDoctorOptions } from '@/features/doctors';
import { PatientSearch, usePatientName, type PatientName } from '@/features/patients';
import { usePermission } from '@/access';
import { currencyDigits, toMinor } from '@/features/services';
import { useTenant } from '@/tenancy';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import {
  CheckboxField,
  Form,
  SelectField,
  TextAreaField,
  TextField,
  SubmitButton,
  useFieldError,
  useFieldFocusRef,
  useFieldValue,
  useSetFieldValue,
  useZodForm,
} from '@/shared/ui/form';
import { BedPicker } from '../components/BedPicker';
import { useAdmit } from '../hooks/use-admissions';
import {
  ADMISSION_CONSENTS,
  ADMISSION_TYPES,
  ATTENDANT_RELATIONS,
  admitSchema,
  type AdmitValues,
} from '../schemas';
import type { Admission } from '../types';

/** Refusals this form has words for: the bed or the stay changed under the person. */
function refusalKey(error: unknown): string | null {
  if (!isApiError(error)) return null;
  switch (error.serverCode) {
    case 'bed_not_available':
      return 'admit.refused.bed';
    case 'already_admitted':
      return 'admit.refused.admitted';
    case 'unknown_doctor':
      return 'admit.refused.doctor';
    default:
      return null;
  }
}

/** The chosen patient, or the box to find one. The form holds the id; the name is for show. */
function PatientChoice({
  patient,
  onChange,
}: {
  patient: PatientName | undefined;
  onChange: (patient: PatientName | undefined) => void;
}) {
  const { t } = useTranslation('admissions');
  const setValue = useSetFieldValue();
  const error = useFieldError('patientId');
  const focusRef = useFieldFocusRef('patientId');
  const [moved, setMoved] = useState(false);
  const card = useRef<HTMLDivElement>(null);
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
          <p className="text-sm font-medium">{t('admit.patient')}</p>
          <div
            ref={card}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
          >
            <div className="min-w-0">
              <p className="break-words font-medium">
                {patient.firstName} {patient.lastName}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('admit.patientMrn', { mrn: patient.mrn })}
              </p>
            </div>
            <Button type="button" variant="outline" onClick={() => choose(undefined)}>
              {t('admit.changePatient')}
            </Button>
          </div>
        </>
      ) : (
        <PatientSearch
          label={t('admit.patient')}
          onSelect={choose}
          describedBy={error ? 'admit-patient-error' : undefined}
          focusOnMount={moved}
          required
        />
      )}
      {error && (
        <p id="admit-patient-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function BedChoice() {
  const setValue = useSetFieldValue();
  const value = useFieldValue('bedId');
  const error = useFieldError('bedId');
  const patientId = useFieldValue('patientId');
  const focusRef = useFieldFocusRef('bedId');
  return (
    <div ref={focusRef} className="flex flex-col gap-1.5">
      <BedPicker
        patientId={typeof patientId === 'string' ? patientId : undefined}
        value={typeof value === 'string' ? value : ''}
        onChange={(bedId) => setValue('bedId', bedId)}
        describedBy={error ? 'admit-bed-error' : undefined}
        invalid={Boolean(error)}
      />
      {error && (
        <p id="admit-bed-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function AdmitPatient() {
  const { t } = useTranslation('admissions');
  const { t: tCommon } = useTranslation();
  const session = useSession();
  const doctors = useDoctorOptions();
  const mayFindPatients = usePermission('patient:read');
  // Coming from a patient's screen, an OPD visit or the emergency desk: the patient is known.
  const [params] = useSearchParams();
  const [askedId] = useState(() => {
    const id = params.get('patientId') ?? '';
    return /^[\w-]{1,64}$/.test(id) ? id : '';
  });
  const askedType = params.get('type');
  const [askedVisit] = useState(() => {
    const id = params.get('encounterId') ?? '';
    return /^[\w-]{1,64}$/.test(id) ? id : '';
  });
  const [usedAsked, setUsedAsked] = useState(false);
  const askedPatient = usePatientName(mayFindPatients ? askedId : '');
  const [patient, setPatient] = useState<PatientName>();
  const [admitted, setAdmitted] = useState<Admission>();
  const admit = useAdmit();
  const digits = currencyDigits(useTenant()?.currency);
  const heading = useRef<HTMLHeadingElement>(null);

  const form = useZodForm(admitSchema, {
    patientId: '',
    admissionType: ADMISSION_TYPES.find((type) => type === askedType) ?? 'planned',
    doctorId: '',
    bedId: '',
    adviceNote: '',
    attendantName: '',
    attendantRelation: '',
    attendantPhone: '',
    deposit: '',
    consentAdmission: false,
    consentTreatment: false,
    consentFinancial: false,
    consentPrivacy: false,
  });

  if (askedPatient.data && !usedAsked) {
    setUsedAsked(true);
    if (!patient) setPatient(askedPatient.data);
  }
  useEffect(() => {
    if (patient && form.getValues('patientId') !== patient.id) {
      form.setValue('patientId', patient.id, { shouldValidate: form.formState.isSubmitted });
    }
  }, [patient, form]);

  // A doctor admits under their own profile unless they choose another.
  const mineId = doctors.data?.find((doctor) => doctor.userId === session?.user.id)?.id;
  useEffect(() => {
    if (mineId && form.getValues('doctorId') === '') form.setValue('doctorId', mineId);
  }, [mineId, form]);

  useEffect(() => {
    if (admitted) heading.current?.focus();
  }, [admitted]);

  const submit = async (values: AdmitValues) => {
    admit.reset();
    const deposit = values.deposit.trim() === '' ? undefined : toMinor(values.deposit, digits);
    if (deposit === null) {
      form.setError('deposit', { message: 'admissions:admit.depositInvalid' });
      return;
    }
    const consents = ADMISSION_CONSENTS.filter(
      (consent) =>
        values[`consent${consent[0]?.toUpperCase()}${consent.slice(1)}` as keyof AdmitValues],
    );
    const attendantName = values.attendantName.trim();
    if (
      attendantName === '' &&
      (values.attendantRelation !== '' || values.attendantPhone.trim() !== '')
    ) {
      form.setError('attendantName', { message: 'admissions:admit.attendantNameRequired' });
      return;
    }
    try {
      setAdmitted(
        await admit.mutateAsync({
          patientId: values.patientId,
          // The visit is the patient's only while the patient is the one it was linked for.
          ...(askedVisit && values.patientId === askedId ? { sourceEncounterId: askedVisit } : {}),
          admissionType: values.admissionType,
          bedId: values.bedId,
          ...(values.doctorId ? { doctorId: values.doctorId } : {}),
          ...(values.adviceNote.trim() ? { adviceNote: values.adviceNote.trim() } : {}),
          ...(attendantName ? { attendantName } : {}),
          ...(values.attendantRelation ? { attendantRelation: values.attendantRelation } : {}),
          ...(values.attendantPhone.trim() ? { attendantPhone: values.attendantPhone.trim() } : {}),
          ...(deposit !== undefined ? { depositMinor: deposit } : {}),
          ...(consents.length > 0 ? { consents } : {}),
        }),
      );
    } catch (error) {
      // A bed taken first is let go, so another is chosen from the list read again.
      if (isApiError(error) && error.serverCode === 'bed_not_available') {
        form.setValue('bedId', '');
      }
    }
  };

  const refused = refusalKey(admit.error);

  if (admitted) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-6">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight">
          {t('admit.done.heading')}
        </h1>
        <p role="status">
          {t('admit.done.summary', {
            patient: admitted.patientName,
            bed: admitted.bed?.bedNumber ?? '',
            ward: admitted.bed?.wardName ?? '',
            doctor: admitted.doctorName,
          })}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link to="/admissions">{t('admit.done.list')}</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/beds">{t('admit.done.board')}</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('admit.heading')}</h1>
        <p className="text-muted-foreground">{t('admit.description')}</p>
      </div>
      {admit.isError && (
        <p role="alert" className="text-sm text-destructive">
          {refused ? t(refused) : tCommon(errorMessageKey(admit.error))}
        </p>
      )}
      <Form form={form} onSubmit={(values: AdmitValues) => void submit(values)}>
        <PatientChoice patient={patient} onChange={setPatient} />
        <SelectField<AdmitValues>
          name="admissionType"
          label={t('admit.type')}
          required
          options={ADMISSION_TYPES.map((value) => ({ value, label: t(`types.${value}`) }))}
        />
        {doctors.available && doctors.data && (
          <SelectField<AdmitValues>
            name="doctorId"
            label={t('admit.doctor')}
            hint={t('admit.doctorHint')}
            placeholder={t('admit.ownDoctor')}
            options={doctors.data.map((doctor) => ({ value: doctor.id, label: doctor.name }))}
          />
        )}
        <BedChoice />
        <TextAreaField<AdmitValues>
          name="adviceNote"
          label={t('admit.advice')}
          hint={t('admit.adviceHint')}
        />
        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">{t('admit.attendant')}</legend>
          <TextField<AdmitValues>
            name="attendantName"
            label={t('admit.attendantName')}
            autoComplete="off"
          />
          <SelectField<AdmitValues>
            name="attendantRelation"
            label={t('admit.attendantRelation')}
            placeholder={t('admit.noRelation')}
            options={ATTENDANT_RELATIONS.map((value) => ({
              value,
              label: t(`relations.${value}`),
            }))}
          />
          <TextField<AdmitValues>
            name="attendantPhone"
            label={t('admit.attendantPhone')}
            type="tel"
            inputMode="tel"
            autoComplete="off"
          />
        </fieldset>
        <TextField<AdmitValues>
          name="deposit"
          label={t('admit.deposit')}
          hint={t('admit.depositHint')}
          inputMode="decimal"
          autoComplete="off"
        />
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">{t('admit.consents')}</legend>
          {ADMISSION_CONSENTS.map((consent) => (
            <CheckboxField<AdmitValues>
              key={consent}
              name={`consent${consent[0]?.toUpperCase()}${consent.slice(1)}` as 'consentAdmission'}
              label={t(`consentTypes.${consent}`)}
            />
          ))}
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={admit.isPending}>{t('admit.submit')}</SubmitButton>
          <Button asChild variant="outline">
            <Link to="/admissions">{t('admit.cancel')}</Link>
          </Button>
        </div>
      </Form>
    </div>
  );
}
