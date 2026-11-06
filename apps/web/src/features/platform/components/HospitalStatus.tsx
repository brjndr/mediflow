import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Form, TextField, useZodForm } from '@/shared/ui/form';
import { useFormatters } from '@/tenancy/use-formatters';
import {
  useOffboardHospital,
  useReactivateHospital,
  useSuspendHospital,
} from '../hooks/use-hospitals';
import { OFFBOARD_DAYS_DEFAULT, offboardSchema } from '../schemas';
import type { Hospital } from '../types';

type Asking = 'suspend' | 'reactivate' | 'offboard' | null;

const OFFBOARD_FORM = 'offboard-form';

/**
 * The hospital's status, and what may be done to it: suspend, reactivate, offboard. Each asks
 * first, saying what happens. Nothing here deletes data: the API closes the hospital, signs its
 * staff out, withdraws open invites and, for an offboarding, marks the date after which the data
 * may be deleted (the export and the deletion are not built).
 */
export function HospitalStatus({ hospital }: { hospital: Hospital }) {
  const { t } = useTranslation();
  const format = useFormatters();
  const suspend = useSuspendHospital(hospital.id);
  const reactivate = useReactivateHospital(hospital.id);
  const offboard = useOffboardHospital(hospital.id);
  const [asking, setAsking] = useState<Asking>(null);
  const [message, setMessage] = useState('');
  const [refused, setRefused] = useState('');
  const statusLine = useRef<HTMLParagraphElement>(null);
  const form = useZodForm(offboardSchema(hospital.slug), {
    slug: '',
    days: String(OFFBOARD_DAYS_DEFAULT),
  });

  const busy = suspend.isPending || reactivate.isPending || offboard.isPending;

  const done = (text: string) => {
    setAsking(null);
    setRefused('');
    setMessage(text);
    // The button that asked may be gone (Suspend became Reactivate): keep the keyboard's place.
    queueMicrotask(() => focusIfLost(statusLine.current));
  };

  const failed = (error: unknown) => {
    if (isApiError(error) && error.serverCode === 'invalid_transition') {
      // The question no longer fits the hospital: close it, say why where it stays on the page,
      // and let the page show the status the hospital really has.
      setAsking(null);
      form.reset();
      setMessage(t('platform.status.changedMeanwhile'));
      queueMicrotask(() => focusIfLost(statusLine.current));
      return;
    }
    setRefused(t(errorMessageKey(error)));
  };

  const run = (action: 'suspend' | 'reactivate') => {
    if (busy) return;
    const mutation = action === 'suspend' ? suspend : reactivate;
    mutation.mutate(undefined, {
      onSuccess: () => done(t(`platform.status.${action}.done`)),
      onError: failed,
    });
  };

  const close = () => {
    // A request is on its way: the answer was given, and the dialog stays until it is back.
    if (busy) return;
    setAsking(null);
    setRefused('');
    form.reset();
  };

  const runOffboard = (values: { days: string }) => {
    if (busy) return;
    offboard.mutate(Number(values.days), {
      onSuccess: () => {
        form.reset();
        done(t('platform.status.offboard.done'));
      },
      onError: failed,
    });
  };

  const open = (what: Exclude<Asking, null>) => {
    setMessage('');
    setRefused('');
    setAsking(what);
  };

  const { status } = hospital;
  return (
    <section aria-labelledby="hospital-status" className="flex flex-col gap-3">
      <h2 id="hospital-status" className="text-lg font-semibold">
        {t('platform.status.heading')}
      </h2>
      <p>
        <span className="font-medium">{t(`platform.hospitals.status.${status}`)}</span>
        {' · '}
        {t(`platform.status.explain.${status}`)}
      </p>
      {hospital.suspendedAt !== null && status === 'suspended' && (
        <p className="text-sm text-muted-foreground">
          {t('platform.status.since', { when: format.dateTime(hospital.suspendedAt) })}
        </p>
      )}
      {status === 'offboarding' && hospital.offboardingRequestedAt !== null && (
        <p className="text-sm text-muted-foreground">
          {t('platform.status.offboardingSince', {
            when: format.dateTime(hospital.offboardingRequestedAt),
          })}
          {hospital.deleteAfter !== null &&
            ` ${t('platform.status.deleteAfter', { when: format.dateTime(hospital.deleteAfter) })}`}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {status === 'active' && (
          <Button variant="outline" onClick={() => open('suspend')}>
            {t('platform.status.suspend.action')}
          </Button>
        )}
        {status !== 'active' && (
          <Button variant="outline" onClick={() => open('reactivate')}>
            {t('platform.status.reactivate.action')}
          </Button>
        )}
        {status !== 'offboarding' && (
          <Button variant="destructive" onClick={() => open('offboard')}>
            {t('platform.status.offboard.action')}
          </Button>
        )}
      </div>

      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {message}
      </p>

      <ConfirmDialog
        open={asking === 'suspend'}
        onClose={close}
        title={t('platform.status.suspend.title', { name: hospital.name })}
        description={t('platform.status.suspend.description')}
        cancelLabel={t('platform.status.cancel')}
        confirmLabel={t('platform.status.suspend.confirm')}
        destructive
        pending={busy}
        onConfirm={() => run('suspend')}
      >
        {refused !== '' && asking === 'suspend' && <Refusal text={refused} />}
      </ConfirmDialog>

      <ConfirmDialog
        open={asking === 'reactivate'}
        onClose={close}
        title={t('platform.status.reactivate.title', { name: hospital.name })}
        description={t(
          `platform.status.reactivate.description.${status === 'offboarding' ? 'offboarding' : 'suspended'}`,
        )}
        cancelLabel={t('platform.status.cancel')}
        confirmLabel={t('platform.status.reactivate.confirm')}
        pending={busy}
        onConfirm={() => run('reactivate')}
      >
        {refused !== '' && asking === 'reactivate' && <Refusal text={refused} />}
      </ConfirmDialog>

      <ConfirmDialog
        open={asking === 'offboard'}
        onClose={close}
        title={t('platform.status.offboard.title', { name: hospital.name })}
        description={t('platform.status.offboard.description')}
        cancelLabel={t('platform.status.cancel')}
        confirmLabel={t('platform.status.offboard.confirm')}
        confirmForm={OFFBOARD_FORM}
        destructive
        pending={busy}
      >
        <Form form={form} id={OFFBOARD_FORM} onSubmit={runOffboard} className="gap-3">
          <TextField
            name="slug"
            label={t('platform.status.offboard.slug', { slug: hospital.slug })}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            data-autofocus
          />
          <TextField
            name="days"
            label={t('platform.status.offboard.days')}
            hint={t('platform.status.offboard.daysHint')}
            inputMode="numeric"
            autoComplete="off"
          />
        </Form>
        {refused !== '' && asking === 'offboard' && <Refusal text={refused} />}
      </ConfirmDialog>
    </section>
  );
}

function Refusal({ text }: { text: string }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {text}
    </p>
  );
}
