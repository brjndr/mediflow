import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { errorMessageKey } from '@/shared/api';
import { DuplicateWarning } from '../components/DuplicateWarning';
import { PatientForm } from '../components/PatientForm';
import { useCheckDuplicates, useCreatePatient } from '../hooks/use-register-patient';
import type { PatientFormValues } from '../schemas';
import type { PatientCreate as PatientCreateBody, PatientSummary } from '../types';

/** Empty optional fields are left out, and the server adds when and by whom consent was recorded. */
function toRequest(values: PatientFormValues): PatientCreateBody {
  return {
    firstName: values.firstName,
    lastName: values.lastName,
    dob: values.dob,
    gender: values.gender,
    phone: values.phone,
    email: values.email || undefined,
    address: values.address || undefined,
    contactConsent: { given: values.contactConsent },
  };
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function PatientCreate() {
  const { t } = useTranslation('patients');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const check = useCheckDuplicates();
  const create = useCreatePatient();
  // One key per registration attempt: a double click or a retry cannot create two patients.
  const idempotencyKey = useRef(crypto.randomUUID());
  // Kept in memory only, never in the address or browser storage.
  const [values, setValues] = useState<PatientFormValues>();
  const [matches, setMatches] = useState<PatientSummary[]>();

  const register = (submitted: PatientFormValues) =>
    create.mutateAsync({ body: toRequest(submitted), idempotencyKey: idempotencyKey.current });

  const submit = async (submitted: PatientFormValues) => {
    setValues(submitted);
    try {
      const found = await check.mutateAsync({
        firstName: submitted.firstName,
        lastName: submitted.lastName,
        dob: submitted.dob,
        phone: submitted.phone,
      });
      if (found.items.length > 0) {
        setMatches(found.items);
        return;
      }
      await register(submitted);
    } catch {
      // The error is shown from the mutation state below.
    }
  };

  const registerAnyway = async () => {
    if (!values) return;
    try {
      await register(values);
    } catch {
      // Shown from the mutation state.
    }
  };

  const error = check.error ?? create.error;

  if (create.isSuccess) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('created.heading')}</h1>
        <p role="status">
          {t('created.mrn')} <strong>{create.data.mrn}</strong>
        </p>
        <Link to="/patients" className="text-sm font-medium underline">
          {t('created.backToList')}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('create.heading')}</h1>
        <p className="text-muted-foreground">{t('create.description')}</p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(error))}
        </p>
      )}

      {matches ? (
        <DuplicateWarning
          matches={matches}
          pending={create.isPending}
          onRegisterAnyway={() => void registerAnyway()}
          onBack={() => setMatches(undefined)}
        />
      ) : (
        <PatientForm
          onSubmit={submit}
          pending={check.isPending || create.isPending}
          initialValues={values}
        />
      )}
    </div>
  );
}
