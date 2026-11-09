import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PatientSearch, type PatientSummary } from '@/features/patients';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, SelectField, TextField, useZodForm } from '@/shared/ui/form';
import { useRegisterCase } from '../hooks/use-emergency';
import {
  ARRIVAL_MODES,
  CATEGORIES,
  registerFormSchema,
  SEXES,
  type RegisterFormValues,
} from '../schemas';
import type { EmergencyCase } from '../types';
import { failureText } from './failure';

/**
 * Quick registration (#171): an arrival is on the board after the complaint and how they came.
 * An unidentified patient needs nothing more (the server gives a temporary ID); a patient on
 * record is chosen by search and only the id is sent.
 */
export function RegisterDialog({
  onClose,
  onRegistered,
}: {
  onClose: () => void;
  onRegistered: (made: EmergencyCase) => void;
}) {
  const { t } = useTranslation('emergency');
  const { t: tCommon } = useTranslation();
  const register = useRegisterCase();
  const [known, setKnown] = useState(false);
  const [patient, setPatient] = useState<PatientSummary>();
  const [missing, setMissing] = useState(false);
  const form = useZodForm(registerFormSchema, {
    alias: '',
    sex: 'unknown',
    approximateAge: '',
    complaint: '',
    arrivalMode: 'walk_in',
    category: '',
  });

  const submit = async (values: RegisterFormValues) => {
    if (known && !patient) {
      setMissing(true);
      return;
    }
    try {
      const made = await register.mutateAsync({
        complaint: values.complaint,
        arrivalMode: values.arrivalMode,
        ...(values.category ? { category: Number(values.category) } : {}),
        ...(known && patient
          ? { patientId: patient.id }
          : {
              sex: values.sex,
              ...(values.alias ? { alias: values.alias } : {}),
              ...(values.approximateAge ? { approximateAge: Number(values.approximateAge) } : {}),
            }),
      });
      onRegistered(made);
    } catch {
      // Said below, from the mutation state.
    }
  };
  const failure = failureText(register.error, t, tCommon);

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('register.title')}
      description={t('register.description')}
      closeLabel={t('close')}
      busy={register.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="emergency-register-form" aria-busy={register.isPending}>
            {register.isPending ? t('register.saving') : t('register.save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="emergency-register-form" onSubmit={submit}>
        <div role="group" aria-label={t('register.who')} className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant={known ? 'outline' : 'default'}
            aria-pressed={!known}
            onClick={() => setKnown(false)}
          >
            {t('register.unidentified')}
          </Button>
          <Button
            type="button"
            variant={known ? 'default' : 'outline'}
            aria-pressed={known}
            onClick={() => setKnown(true)}
          >
            {t('register.onRecord')}
          </Button>
        </div>

        {known ? (
          patient ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
              <div className="min-w-0">
                <p className="break-words">
                  {patient.firstName} {patient.lastName}
                </p>
                <p className="text-xs text-muted-foreground">{patient.mrn}</p>
              </div>
              <Button type="button" variant="outline" onClick={() => setPatient(undefined)}>
                {t('register.change')}
              </Button>
            </div>
          ) : (
            <>
              <PatientSearch
                label={t('register.patient')}
                required
                focusOnMount
                onSelect={(chosen) => {
                  setPatient(chosen);
                  setMissing(false);
                }}
              />
              {missing && (
                <p role="alert" className="text-sm text-destructive">
                  {t('register.choosePatient')}
                </p>
              )}
            </>
          )
        ) : (
          <>
            <SelectField<RegisterFormValues>
              name="sex"
              label={t('register.sex')}
              options={SEXES.map((value) => ({ value, label: t(`sex.${value}`) }))}
            />
            <TextField<RegisterFormValues>
              name="approximateAge"
              label={t('register.age')}
              hint={t('register.ageHint')}
              inputMode="numeric"
              autoComplete="off"
            />
            <TextField<RegisterFormValues>
              name="alias"
              label={t('register.alias')}
              hint={t('register.aliasHint')}
              autoComplete="off"
            />
          </>
        )}

        <TextField<RegisterFormValues>
          name="complaint"
          label={t('register.complaint')}
          required
          autoComplete="off"
        />
        <SelectField<RegisterFormValues>
          name="arrivalMode"
          label={t('register.arrival')}
          options={ARRIVAL_MODES.map((value) => ({ value, label: t(`arrival.${value}`) }))}
        />
        <SelectField<RegisterFormValues>
          name="category"
          label={t('register.category')}
          placeholder={t('register.notTriaged')}
          options={CATEGORIES.map((value) => ({
            value: String(value),
            label: t(`category.long.${value}`),
          }))}
        />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}
