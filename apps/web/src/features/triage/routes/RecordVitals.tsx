import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useFeatureFlag, usePermission } from '@/access';
import { usePatientName } from '@/features/patients';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import {
  Form,
  SubmitButton,
  TextAreaField,
  TextField,
  useFieldValue,
  useZodForm,
} from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { AllergiesPanel } from '../components/AllergiesPanel';
import { FlagMark, RangesNote, ReadingList } from '../components/reading';
import { useReading, useRecordVitals, useVitalRanges, useVitals } from '../hooks/use-triage';
import {
  bmiOf,
  blankVitals,
  flagOf,
  RANGED,
  toVitalsCreate,
  toVitalsValues,
  vitalsFormSchema,
  type RangedMeasure,
  type VitalsValues,
} from '../schemas';
import type { Vitals, VitalRanges } from '../types';

type Ranges = VitalRanges['ranges'];

/** An id from the address, or empty when it is not one. */
const idFrom = (value: string | null | undefined) =>
  value && /^[\w-]{1,64}$/.test(value) ? value : '';

/** Refusals this screen has words for, as keys of the feature's strings. */
const REFUSALS: Record<string, string> = {
  token_not_for_patient: 'form.refused.tokenNotForPatient',
  unknown_correction: 'form.refused.unknownCorrection',
};

const numberOf = (text: unknown) => {
  const value = typeof text === 'string' && text.trim() !== '' ? Number(text) : NaN;
  return Number.isFinite(value) ? value : undefined;
};

/** High or low beside a field as it is typed, from the ranges that apply to the patient. */
function LiveFlag({ name, ranges }: { name: RangedMeasure; ranges: Ranges | undefined }) {
  const flag = flagOf(numberOf(useFieldValue(name)), ranges?.[name]);
  return flag ? <FlagMark flag={flag} /> : null;
}

/** BMI from what is typed, for show only. */
function LiveBmi() {
  const { t } = useTranslation('triage');
  const format = useFormatters();
  const bmi = bmiOf(numberOf(useFieldValue('weight')), numberOf(useFieldValue('height')));
  if (bmi === undefined || !Number.isFinite(bmi)) return null;
  return (
    <p className="text-sm text-muted-foreground">
      {t('form.bmi', { value: format.number(bmi, { maximumFractionDigits: 1 }) })}
    </p>
  );
}

function Measurement({
  name,
  decimal = false,
  ranges,
}: {
  name: keyof VitalsValues;
  decimal?: boolean;
  ranges?: Ranges;
}) {
  const { t } = useTranslation('triage');
  return (
    <div className="flex flex-col gap-1">
      <TextField<VitalsValues>
        name={name}
        label={t(`form.${name}`)}
        inputMode={decimal ? 'decimal' : 'numeric'}
        maxLength={5}
        autoComplete="off"
      />
      {(RANGED as readonly string[]).includes(name) && (
        <LiveFlag name={name as RangedMeasure} ranges={ranges} />
      )}
    </div>
  );
}

function VitalsForm({
  initial,
  correcting,
  ranges,
  pending,
  error,
  onSubmit,
  cancelTo,
}: {
  initial: VitalsValues;
  correcting: boolean;
  ranges: Ranges | undefined;
  pending: boolean;
  error: string | null;
  onSubmit: (values: VitalsValues) => void;
  cancelTo: string;
}) {
  const { t } = useTranslation('triage');
  const form = useZodForm(vitalsFormSchema(correcting), initial);
  return (
    <Form form={form} onSubmit={onSubmit}>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-medium">{t('form.pressure')}</legend>
        <div className="grid grid-cols-2 items-start gap-3">
          <Measurement name="systolic" ranges={ranges} />
          <Measurement name="diastolic" ranges={ranges} />
        </div>
      </fieldset>
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-3">
        <Measurement name="pulse" ranges={ranges} />
        <Measurement name="temperature" decimal ranges={ranges} />
        <Measurement name="spo2" ranges={ranges} />
      </div>
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
        <Measurement name="weight" decimal />
        <Measurement name="height" decimal />
      </div>
      <LiveBmi />
      <TextAreaField<VitalsValues>
        name="chiefComplaint"
        label={t('form.complaint')}
        hint={t('form.complaintHint')}
        maxLength={500}
        rows={3}
      />
      {correcting && (
        <TextField<VitalsValues>
          name="correctionReason"
          label={t('form.reason')}
          required
          maxLength={200}
          autoComplete="off"
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <SubmitButton pending={pending}>
          {pending ? t('form.submitting') : t('form.submit')}
        </SubmitButton>
        <Button asChild variant="outline">
          <Link to={cancelTo}>{t('form.cancel')}</Link>
        </Button>
      </div>
    </Form>
  );
}

/** Who the reading is for, by name and MRN when this person may read patients. */
function PatientLine({ patientId }: { patientId: string }) {
  const { t } = useTranslation('triage');
  const canReadPatients = usePermission('patient:read');
  const patientsOn = useFeatureFlag('patients');
  const patient = usePatientName(canReadPatients && patientsOn ? patientId : '');
  if (!canReadPatients || !patientsOn || patient.isError) {
    return <p className="text-sm text-muted-foreground">{t('form.patientUnknown')}</p>;
  }
  if (!patient.data) return <p className="h-5" />;
  return (
    <p className="font-medium">
      {t('form.patient', {
        name: `${patient.data.firstName} ${patient.data.lastName}`,
        mrn: patient.data.mrn,
      })}
    </p>
  );
}

/** Whether vitals were already taken for this token: a second reading is allowed, and said. */
function TakenForToken({ patientId, tokenId }: { patientId: string; tokenId: string }) {
  const { t } = useTranslation('triage');
  const format = useFormatters();
  const taken = useVitals(patientId, { queueTokenId: tokenId, limit: 1 });
  const earlier = taken.data?.pages[0]?.items[0];
  if (!earlier) return null;
  return (
    <p className="rounded-md border p-3 text-sm">
      {t('form.alreadyTaken', { time: format.time(earlier.recordedAt) })}
    </p>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function RecordVitals() {
  const { t } = useTranslation('triage');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const canReadAllergies = usePermission('allergy:read');
  // Ids only, from the address: never anything about the patient.
  const params = useParams();
  const [search] = useSearchParams();
  const patientId = idFrom(params.patientId);
  const [tokenId] = useState(() => idFrom(search.get('token')));
  const [correctsId] = useState(() => idFrom(search.get('corrects')));
  const ranges = useVitalRanges(patientId);
  const original = useReading(patientId, correctsId);
  const record = useRecordVitals(patientId);
  const [saved, setSaved] = useState<Vitals>();
  const heading = useRef<HTMLHeadingElement>(null);

  // After saving, focus moves to the confirmation so a screen reader announces it.
  useEffect(() => {
    if (saved) heading.current?.focus();
  }, [saved]);

  const backTo = tokenId ? '/queue' : `/patients/${patientId}?tab=vitals`;
  const backLabel = tokenId ? t('form.back') : t('form.backToPatient');
  const rangeData = ranges.data?.ranges;

  const submit = async (values: VitalsValues) => {
    record.reset();
    try {
      setSaved(
        await record.mutateAsync(
          toVitalsCreate(values, { queueTokenId: tokenId, correctsId: correctsId || undefined }),
        ),
      );
    } catch {
      // Shown from the mutation state.
    }
  };

  if (saved) {
    const abnormal = RANGED.filter((name) => flagOf(saved[name], rangeData?.[name])).length;
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight">
          {t('form.savedHeading')}
        </h1>
        <p role="status">
          {t('form.saved')} {abnormal > 0 ? t('form.abnormal', { count: abnormal }) : ''}
        </p>
        <ReadingList reading={saved} ranges={rangeData} />
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link to={backTo}>{backLabel}</Link>
          </Button>
        </div>
      </div>
    );
  }

  const serverCode = isApiError(record.error) ? record.error.serverCode : undefined;
  const refused = serverCode ? REFUSALS[serverCode] : undefined;
  const failure = record.isError
    ? refused
      ? t(refused)
      : tCommon(errorMessageKey(record.error))
    : null;
  // The patient is not one this hospital has, or this person may not see.
  const missing =
    !patientId ||
    (isApiError(ranges.error) && (ranges.error.status === 404 || ranges.error.status === 403));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {correctsId ? t('form.correctHeading') : t('form.heading')}
        </h1>
        {patientId && <PatientLine patientId={patientId} />}
      </div>

      {missing ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm">
            {t('form.unavailable')}
          </p>
          <Button asChild variant="outline">
            <Link to={tokenId ? '/queue' : '/'}>{backLabel}</Link>
          </Button>
        </div>
      ) : (
        <>
          {canReadAllergies && <AllergiesPanel patientId={patientId} />}
          {tokenId && <TakenForToken patientId={patientId} tokenId={tokenId} />}
          <RangesNote ranges={rangeData} failed={ranges.isError} />
          {correctsId && original.isPending ? (
            <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
          ) : correctsId && original.isError ? (
            <p role="alert" className="text-sm">
              {t('form.readingNotFound')}
            </p>
          ) : (
            <>
              {original.data && (
                <p className="rounded-md border p-3 text-sm">
                  {t('form.correcting', { time: format.dateTime(original.data.recordedAt) })}
                </p>
              )}
              <VitalsForm
                // A correction starts from the reading it corrects, once it is known.
                key={original.data?.id ?? 'new'}
                initial={original.data ? toVitalsValues(original.data) : blankVitals}
                correcting={correctsId !== ''}
                ranges={rangeData}
                pending={record.isPending}
                error={failure}
                onSubmit={(values) => void submit(values)}
                cancelTo={backTo}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
