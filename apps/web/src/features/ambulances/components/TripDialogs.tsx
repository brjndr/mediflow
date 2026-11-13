import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { useFeatureFlag, usePermission } from '@/access';
import { useEncounters } from '@/features/clinical';
import { StaffSearch } from '@/features/staff';
import { PatientSearch, type PatientSummary } from '@/features/patients';
import { ServiceSearch, type ServiceOption } from '@/features/services';
import { useFormatters } from '@/tenancy';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, SelectField, TextField, useZodForm } from '@/shared/ui/form';
import { useAvailableAmbulances, useMoveTrip, useRequestTrip } from '../hooks/use-ambulances';
import { CREW_ROLES, MAX_CREW, tripFormSchema, type TripFormValues } from '../schemas';
import type { AmbulanceTrip, CrewRole } from '../types';

const REFUSED: Record<string, string> = {
  unknown_patient: 'errors.patient',
  unknown_encounter: 'errors.visit',
  unknown_service: 'errors.service',
  encounter_required: 'errors.visit',
  ambulance_unavailable: 'errors.unavailable',
  unknown_ambulance: 'errors.unavailable',
  unknown_crew: 'errors.crew',
  invalid_crew: 'errors.crewShape',
  crew_busy: 'errors.crewBusy',
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
  const [service, setService] = useState<ServiceOption>();
  const form = useZodForm(tripFormSchema, { pickup: '', destination: '', encounterId: '' });
  const format = useFormatters();
  // The patient's open visits to charge the trip to: needs the clinical module and its reading.
  const mayRead = usePermission('encounter:read');
  const clinicalOn = useFeatureFlag('clinical');
  const canChoose = mayRead && clinicalOn;
  const visits = useEncounters(
    { patientId: patient?.id, status: 'open' },
    { enabled: canChoose && patient !== undefined },
  );
  const open = (visits.data?.pages.flatMap((page) => page.items) ?? []).filter(
    (visit) => visit.status === 'open',
  );

  const submit = async (values: TripFormValues) => {
    try {
      await request.mutateAsync({
        ...(patient ? { patientId: patient.id } : {}),
        ...(patient && values.encounterId ? { encounterId: values.encounterId } : {}),
        ...(patient && values.encounterId && service ? { serviceId: service.id } : {}),
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
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setPatient(undefined);
                setService(undefined);
                form.setValue('encounterId', '');
              }}
            >
              {t('request.noPatient')}
            </Button>
          </div>
        ) : (
          <PatientSearch label={t('request.patientOptional')} onSelect={setPatient} />
        )}
        <TextField<TripFormValues> name="pickup" label={t('request.pickup')} required />
        <TextField<TripFormValues> name="destination" label={t('request.destination')} required />
        {patient && canChoose && (
          <>
            <SelectField<TripFormValues>
              name="encounterId"
              label={t('request.visit')}
              placeholder={t('request.noCharge')}
              hint={
                visits.isSuccess && open.length === 0
                  ? t('request.noVisit')
                  : t('request.visitHint')
              }
              options={open.map((visit) => ({
                value: visit.id,
                label: t('request.visitOption', {
                  type: t(`visitType.${visit.type}`),
                  when: format.dateTime(visit.openedAt),
                }),
              }))}
            />
            {service ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t('request.service')}</p>
                  <p className="break-words">{service.name}</p>
                  <p className="text-xs text-muted-foreground">{t('request.chargeNote')}</p>
                </div>
                <Button type="button" variant="outline" onClick={() => setService(undefined)}>
                  {t('request.noService')}
                </Button>
              </div>
            ) : (
              <ServiceSearch label={t('request.serviceOptional')} onSelect={setService} />
            )}
          </>
        )}
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}

const dispatchSchema = z.object({
  ambulanceId: z.string().min(1, 'validation.required'),
  /** The duty the next person added takes. */
  crewRole: z.enum(CREW_ROLES),
});
interface Chosen {
  userId: string;
  userName: string;
  duty: CrewRole;
}
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
  const form = useZodForm(dispatchSchema, { ambulanceId: '', crewRole: 'driver' });
  const [crew, setCrew] = useState<Chosen[]>([]);
  const nextRole = form.watch('crewRole');
  const hasDriver = crew.some((member) => member.duty === 'driver');
  const full = crew.length >= MAX_CREW;
  const failure = failureText(move.error, t, tCommon);

  const submit = async (values: DispatchValues) => {
    try {
      const done = await move.mutateAsync({
        trip,
        to: 'dispatched',
        ambulanceId: values.ambulanceId,
        crew: crew.map(({ userId, duty }) => ({ userId, duty })),
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
        <fieldset className="space-y-2 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">{t('crew.heading')}</legend>
          {crew.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('crew.none')}</p>
          ) : (
            <ul className="space-y-1" aria-label={t('crew.list')}>
              {crew.map((member) => (
                <li
                  key={member.userId}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <span className="break-words">
                    {member.userName}{' '}
                    <span className="text-muted-foreground">({t(`crew.duty.${member.duty}`)})</span>
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t('crew.remove', { name: member.userName })}
                    onClick={() => {
                      setCrew((list) => list.filter((one) => one.userId !== member.userId));
                    }}
                  >
                    {t('crew.removeShort')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {full ? (
            <p className="text-sm text-muted-foreground">{t('crew.full')}</p>
          ) : (
            <>
              <SelectField<DispatchValues>
                name="crewRole"
                label={t('crew.addAs')}
                options={CREW_ROLES.filter((duty) => duty !== 'driver' || !hasDriver).map(
                  (duty) => ({ value: duty, label: t(`crew.duty.${duty}`) }),
                )}
              />
              <StaffSearch
                label={t('crew.add')}
                onSelect={(person) => {
                  setCrew((list) =>
                    list.some((one) => one.userId === person.id)
                      ? list
                      : [
                          ...list,
                          { userId: person.id, userName: person.name, duty: nextRole as CrewRole },
                        ],
                  );
                  if (nextRole === 'driver') form.setValue('crewRole', 'paramedic');
                }}
              />
            </>
          )}
        </fieldset>
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}
