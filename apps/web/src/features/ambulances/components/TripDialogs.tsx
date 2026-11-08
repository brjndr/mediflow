import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { PatientSearch, type PatientSummary } from '@/features/patients';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, SelectField, TextField, useZodForm } from '@/shared/ui/form';
import { useAvailableAmbulances, useMoveTrip, useRequestTrip } from '../hooks/use-ambulances';
import { tripFormSchema, type TripFormValues } from '../schemas';
import type { AmbulanceTrip } from '../types';

const REFUSED: Record<string, string> = {
  unknown_patient: 'errors.patient',
  ambulance_unavailable: 'errors.unavailable',
  unknown_ambulance: 'errors.unavailable',
  conflict: 'errors.changed',
  invalid_transition: 'errors.changed',
};

function failureText(
  error: unknown,
  t: (key: string) => string,
  tCommon: (key: string) => string,
): string | undefined {
  if (!error) return undefined;
  const code = isApiError(error) ? error.serverCode : undefined;
  return code !== undefined && REFUSED[code] ? t(REFUSED[code]) : tCommon(errorMessageKey(error));
}

/**
 * Asks for a trip (#197). The patient is optional: an emergency may have no record yet. Only the
 * patient's id is sent; the name chosen is shown here and kept nowhere.
 */
export function RequestTripDialog({
  onClose,
  onRequested,
}: {
  onClose: () => void;
  onRequested: () => void;
}) {
  const { t } = useTranslation('ambulances');
  const { t: tCommon } = useTranslation();
  const request = useRequestTrip();
  const [patient, setPatient] = useState<PatientSummary>();
  const form = useZodForm(tripFormSchema, { pickup: '', destination: '' });

  const submit = async (values: TripFormValues) => {
    try {
      await request.mutateAsync({
        ...(patient ? { patientId: patient.id } : {}),
        pickup: values.pickup,
        destination: values.destination,
      });
      onRequested();
    } catch {
      // Said below, from the mutation state.
    }
  };
  const failure = failureText(request.error, t, tCommon);

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('request.title')}
      description={t('request.description')}
      closeLabel={t('close')}
      busy={request.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="ambulance-trip-form" aria-busy={request.isPending}>
            {request.isPending ? t('request.saving') : t('request.save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="ambulance-trip-form" onSubmit={submit}>
        {patient ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t('request.patient')}</p>
              <p className="break-words">
                {patient.firstName} {patient.lastName}
              </p>
              <p className="text-xs text-muted-foreground">{patient.mrn}</p>
            </div>
            <Button type="button" variant="outline" onClick={() => setPatient(undefined)}>
              {t('request.noPatient')}
            </Button>
          </div>
        ) : (
          <PatientSearch label={t('request.patientOptional')} onSelect={setPatient} />
        )}
        <TextField<TripFormValues> name="pickup" label={t('request.pickup')} required />
        <TextField<TripFormValues> name="destination" label={t('request.destination')} required />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}

const dispatchSchema = z.object({ ambulanceId: z.string().min(1, 'validation.required') });
type DispatchValues = z.infer<typeof dispatchSchema>;

/** Sends a requested trip with one of the available ambulances. */
export function DispatchDialog({
  trip,
  onClose,
  onDispatched,
}: {
  trip: AmbulanceTrip;
  onClose: () => void;
  onDispatched: (registration: string) => void;
}) {
  const { t } = useTranslation('ambulances');
  const { t: tCommon } = useTranslation();
  const move = useMoveTrip();
  const available = useAvailableAmbulances();
  const form = useZodForm(dispatchSchema, { ambulanceId: '' });
  const failure = failureText(move.error, t, tCommon);

  const submit = async (values: DispatchValues) => {
    try {
      const done = await move.mutateAsync({
        trip,
        to: 'dispatched',
        ambulanceId: values.ambulanceId,
      });
      onDispatched(done.ambulanceRegistration ?? '');
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('dispatch.title')}
      description={t('dispatch.description', {
        pickup: trip.pickup,
        destination: trip.destination,
      })}
      closeLabel={t('close')}
      busy={move.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="ambulance-dispatch-form" aria-busy={move.isPending}>
            {move.isPending ? t('dispatch.saving') : t('dispatch.save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="ambulance-dispatch-form" onSubmit={submit}>
        <SelectField<DispatchValues>
          name="ambulanceId"
          label={t('dispatch.ambulance')}
          required
          placeholder={t('dispatch.choose')}
          hint={available.data?.length === 0 ? t('dispatch.none') : undefined}
          options={(available.data ?? []).map((one) => ({
            value: one.id,
            label: `${one.registration} (${t(`kind.${one.kind}`)})`,
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
