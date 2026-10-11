import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { errorMessageKey } from '@/shared/api';
import { DuplicateWarning } from '../components/DuplicateWarning';
import { PatientForm } from '../components/PatientForm';
import { useCheckDuplicates, useCreatePatient } from '../hooks/use-register-patient';
import type { PatientFormValues } from '../schemas';
import type { PatientCreate as PatientCreateBody, PatientDuplicateMatch } from '../types';

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
  // A key identifies one request body: an identical resubmit (double click, retry) reuses it and
  // cannot create two patients, while an edited form gets a new key.
  const attempt = useRef<{ body: string; key: string }>(undefined);
  // Kept in memory only, never in the address or browser storage.
  const [values, setValues] = useState<PatientFormValues>();
  const [matches, setMatches] = useState<PatientDuplicateMatch[]>();
  const heading = useRef<HTMLHeadingElement>(null);

  // After registering, move focus to the confirmation so a screen reader announces it.
  useEffect(() => {
    if (create.isSuccess) heading.current?.focus();
  }, [create.isSuccess]);

  const register = (submitted: PatientFormValues) => {
    const body = toRequest(submitted);
    const serialized = JSON.stringify(body);
    if (attempt.current?.body !== serialized) {
      attempt.current = { body: serialized, key: crypto.randomUUID() };
    }
    return create.mutateAsync({ body, idempotencyKey: attempt.current.key });
  };

  const submit = async (submitted: PatientFormValues) => {
    check.reset();
    create.reset();
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
      setValues(undefined);
      attempt.current = undefined;
    } catch {
      // The error is shown from the mutation state below. A failed check stops registration.
    }
  };

  const registerAnyway = async () => {
    if (!values) return;
    create.reset();
    try {
      await register(values);
      setValues(undefined);
      attempt.current = undefined;
      setMatches(undefined);
    } catch {
      // Shown from the mutation state.
    }
  };

  const goBack = () => {
    check.reset();
    create.reset();
    setMatches(undefined);
  };

  const error = check.error ?? create.error;

  if (create.isSuccess) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-6">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight">
          {t('created.heading')}
        </h1>
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

      {error && !matches && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(error))}
        </p>
      )}

      {matches ? (
        <>
          {create.error && (
            <p role="alert" className="text-sm text-destructive">
              {tCommon(errorMessageKey(create.error))}
            </p>
          )}
          <DuplicateWarning
            matches={matches}
            pending={create.isPending}
            onRegisterAnyway={() => void registerAnyway()}
            onBack={goBack}
          />
        </>
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
