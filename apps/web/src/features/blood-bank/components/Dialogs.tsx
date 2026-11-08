import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PatientSearch, usePatientName, type PatientSummary } from '@/features/patients';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, SelectField, TextAreaField, TextField, useZodForm } from '@/shared/ui/form';
import { zonedToUtc } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import type { UnitMove } from '../api';
import { useMoveUnit, useRegisterUnit, useUnitHistory } from '../hooks/use-blood';
import {
  BLOOD_COMPONENTS,
  BLOOD_GROUPS,
  discardFormSchema,
  REASON_MAX,
  registerFormSchema,
  UNIT_NUMBER_MAX,
  type DiscardFormValues,
  type RegisterFormValues,
} from '../schemas';
import type { BloodUnit } from '../types';
import { refusalKey } from './refusal';

function useFailure(error: unknown) {
  const { t } = useTranslation('blood-bank');
  const { t: tCommon } = useTranslation();
  if (!error) return undefined;
  const key = refusalKey(error);
  return key ? t(key) : tCommon(errorMessageKey(error));
}

/** Splits a date and time typed in one field and reads them on the hospital's clock. */
function instant(value: string, timezone: string): string {
  const [day = '', time = '00:00'] = value.split('T');
  return zonedToUtc(day, time, timezone);
}

/** Registers a collected unit. The dates are on the hospital's clock. */
export function RegisterDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (unit: BloodUnit) => void;
}) {
  const { t } = useTranslation('blood-bank');
  const timezone = useTenant()?.timezone ?? 'UTC';
  const register = useRegisterUnit();
  const form = useZodForm(registerFormSchema, {
    unitNumber: '',
    bloodGroup: 'O+',
    component: 'red_cells',
    volumeMl: '',
    collectedAt: '',
    expiresAt: '',
  });
  const failure = useFailure(register.error);

  const submit = async (values: RegisterFormValues) => {
    try {
      onDone(
        await register.mutateAsync({
          unitNumber: values.unitNumber,
          bloodGroup: values.bloodGroup,
          component: values.component,
          volumeMl: Number(values.volumeMl),
          collectedAt: instant(values.collectedAt, timezone),
          expiresAt: instant(values.expiresAt, timezone),
        }),
      );
    } catch {
      // Said below, from the mutation state.
    }
  };

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
          <Button type="submit" form="blood-register-form" aria-disabled={register.isPending}>
            {register.isPending ? t('register.saving') : t('register.submit')}
          </Button>
        </>
      }
    >
      <Form form={form} id="blood-register-form" onSubmit={submit}>
        <TextField<RegisterFormValues>
          name="unitNumber"
          label={t('register.unitNumber')}
          required
          maxLength={UNIT_NUMBER_MAX}
          autoComplete="off"
          data-autofocus
        />
        <SelectField<RegisterFormValues>
          name="bloodGroup"
          label={t('columns.group')}
          required
          options={BLOOD_GROUPS.map((value) => ({ value, label: value }))}
        />
        <SelectField<RegisterFormValues>
          name="component"
          label={t('columns.component')}
          required
          options={BLOOD_COMPONENTS.map((value) => ({ value, label: t(`component.${value}`) }))}
        />
        <TextField<RegisterFormValues>
          name="volumeMl"
          label={t('register.volume')}
          required
          inputMode="numeric"
          autoComplete="off"
        />
        <TextField<RegisterFormValues>
          name="collectedAt"
          type="datetime-local"
          label={t('columns.collected')}
          required
        />
        <TextField<RegisterFormValues>
          name="expiresAt"
          type="datetime-local"
          label={t('columns.expires')}
          required
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

/** Holds a unit for a patient. */
export function ReserveDialog({
  unit,
  onClose,
  onDone,
}: {
  unit: BloodUnit;
  onClose: () => void;
  onDone: (move: UnitMove) => void;
}) {
  const { t } = useTranslation('blood-bank');
  const move = useMoveUnit();
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [missing, setMissing] = useState(false);
  const failure = useFailure(move.error);

  const submit = async () => {
    if (!patient) {
      setMissing(true);
      return;
    }
    const next: UnitMove = { unit, to: 'reserved', patientId: patient.id };
    try {
      await move.mutateAsync(next);
      onDone(next);
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('reserve.title', { number: unit.unitNumber })}
      description={t('reserve.description')}
      closeLabel={t('close')}
      busy={move.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button aria-disabled={move.isPending} onClick={() => void submit()}>
            {move.isPending ? t('reserve.saving') : t('reserve.submit')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {patient ? (
          <div className="flex flex-wrap items-center gap-2">
            <p role="status" className="text-sm">
              {t('reserve.chosen', { name: `${patient.firstName} ${patient.lastName}` })}
            </p>
            <Button type="button" variant="outline" onClick={() => setPatient(null)}>
              {t('reserve.change')}
            </Button>
          </div>
        ) : (
          <PatientSearch
            label={t('reserve.patient')}
            required
            focusOnMount
            onSelect={(chosen) => {
              setPatient(chosen);
              setMissing(false);
            }}
          />
        )}
        {missing && (
          <p role="alert" className="text-sm text-destructive">
            {t('reserve.missing')}
          </p>
        )}
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** Discards a unit, with the reason that is kept in its history. */
export function DiscardDialog({
  unit,
  onClose,
  onDone,
}: {
  unit: BloodUnit;
  onClose: () => void;
  onDone: (move: UnitMove) => void;
}) {
  const { t } = useTranslation('blood-bank');
  const move = useMoveUnit();
  const form = useZodForm(discardFormSchema, { reason: '' });
  const failure = useFailure(move.error);

  const submit = async ({ reason }: DiscardFormValues) => {
    const next: UnitMove = { unit, to: 'discarded', reason };
    try {
      await move.mutateAsync(next);
      onDone(next);
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('discard.title', { number: unit.unitNumber })}
      description={t('discard.description')}
      closeLabel={t('close')}
      busy={move.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            form="blood-discard-form"
            variant="destructive"
            aria-disabled={move.isPending}
          >
            {move.isPending ? t('discard.saving') : t('discard.submit')}
          </Button>
        </>
      }
    >
      <Form form={form} id="blood-discard-form" onSubmit={submit}>
        <TextAreaField<DiscardFormValues>
          name="reason"
          label={t('discard.reason')}
          required
          maxLength={REASON_MAX}
          data-autofocus
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

function PatientLabel({ id }: { id: string }) {
  const { t } = useTranslation('blood-bank');
  const name = usePatientName(id);
  if (name.data) return <>{`${name.data.firstName} ${name.data.lastName} (${name.data.mrn})`}</>;
  return <>{name.isPending ? t('history.loadingPatient') : t('history.patientUnavailable')}</>;
}

/** Every move a unit made, oldest first: the trace from collection to the patient. */
export function HistoryDialog({ unit, onClose }: { unit: BloodUnit; onClose: () => void }) {
  const { t } = useTranslation('blood-bank');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const history = useUnitHistory(unit.id);

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('history.title', { number: unit.unitNumber })}
      description={t('history.description')}
      closeLabel={t('close')}
      size="lg"
    >
      {history.isPending && <p role="status">{t('history.loading')}</p>}
      {history.isError && (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(history.error))}
          </p>
          <Button variant="outline" onClick={() => void history.refetch()}>
            {t('retry')}
          </Button>
        </div>
      )}
      {history.data && (
        <ol className="flex flex-col gap-3">
          {history.data.history.map((entry, index) => (
            <li key={index} className="rounded-md border p-3 text-sm">
              <p className="font-medium">
                {entry.fromStatus
                  ? t('history.move', {
                      from: t(`status.${entry.fromStatus}`),
                      to: t(`status.${entry.toStatus}`),
                    })
                  : t('history.first', { to: t(`status.${entry.toStatus}`) })}
              </p>
              <p className="text-muted-foreground">{format.dateTime(entry.occurredAt)}</p>
              {entry.patientId && (
                <p>
                  {t('history.patient')}: <PatientLabel id={entry.patientId} />
                </p>
              )}
              {entry.reason && (
                <p>
                  {t('history.reason')}: {entry.reason}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}
