import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/app/session';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Form, TextField, useZodForm } from '@/shared/ui/form';
import { useFormatters } from '@/tenancy/use-formatters';
import {
  useApproveDeletion,
  useCancelDeletion,
  useHospitalDeletion,
  useHospitalExports,
  useRequestDeletion,
} from '../hooks/use-hospitals';
import { deletionRequestSchema } from '../schemas';
import type { Hospital } from '../types';

type Asking = 'request' | 'approve' | 'cancel' | null;

const REQUEST_FORM = 'deletion-request-form';

/** The reasons the API gives for refusing, with their own words; others get the generic message. */
const REFUSALS = new Set([
  'hospital_not_offboarding',
  'grace_period_not_over',
  'export_not_downloaded',
  'legal_hold',
  'medico_legal_open',
  'deletion_in_progress',
  'approver_must_differ',
  'no_deletion_awaiting_approval',
  'no_open_deletion',
  'deletion_running',
]);

/**
 * Deleting an offboarded hospital's data: the export and the deletion as they stand, and the
 * steps a platform admin may take (request, approve as a second admin, cancel). Each step asks
 * first. The API decides every rule; a refusal is shown as the reason it gives (a legal hold,
 * an open medico-legal case, no downloaded export), never as a guess made here.
 */
export function HospitalDeletion({ hospital }: { hospital: Hospital }) {
  const { t } = useTranslation();
  const format = useFormatters();
  const session = useSession();
  const exports = useHospitalExports(hospital.id);
  const deletion = useHospitalDeletion(hospital.id);
  const requestStep = useRequestDeletion(hospital.id);
  const approveStep = useApproveDeletion(hospital.id);
  const cancelStep = useCancelDeletion(hospital.id);
  const [asking, setAsking] = useState<Asking>(null);
  const [message, setMessage] = useState('');
  const [refused, setRefused] = useState('');
  const statusLine = useRef<HTMLParagraphElement>(null);
  const form = useZodForm(deletionRequestSchema, { waiverReference: '' });

  const busy = requestStep.isPending || approveStep.isPending || cancelStep.isPending;
  const current = deletion.data ?? null;
  const me = session?.user.id;

  const done = (text: string) => {
    setAsking(null);
    setRefused('');
    setMessage(text);
    form.reset();
    // The button that asked is gone once the request changed: keep the keyboard's place.
    queueMicrotask(() => focusIfLost(statusLine.current));
  };

  const failed = (error: unknown) => {
    if (isApiError(error) && error.serverCode !== undefined && REFUSALS.has(error.serverCode)) {
      setRefused(t(`platform.deletion.refused.${error.serverCode}`));
      return;
    }
    setRefused(t(errorMessageKey(error)));
  };

  const close = () => {
    if (busy) return;
    setAsking(null);
    setRefused('');
    form.reset();
  };

  const open = (what: Exclude<Asking, null>) => {
    setMessage('');
    setRefused('');
    setAsking(what);
  };

  const run = (what: 'approve' | 'cancel') => {
    if (busy) return;
    const step = what === 'approve' ? approveStep : cancelStep;
    step.mutate(undefined, {
      onSuccess: () => done(t(`platform.deletion.${what}.done`)),
      onError: failed,
    });
  };

  const runRequest = (values: { waiverReference: string }) => {
    if (busy) return;
    requestStep.mutate(values.waiverReference, {
      onSuccess: () => done(t('platform.deletion.request.done')),
      onError: failed,
    });
  };

  const latestExport = exports.data?.find((item) => item.status === 'succeeded');
  const status = current?.status;
  const canRequest =
    hospital.status === 'offboarding' &&
    (current === null || status === 'done' || status === 'failed' || status === 'cancelled');
  const canApprove = hospital.status === 'offboarding' && status === 'requested';
  const ownRequest = canApprove && me !== undefined && current?.requestedBy === me;
  const canCancel = status === 'requested' || status === 'approved';

  return (
    <section aria-labelledby="hospital-deletion" className="flex flex-col gap-3">
      <h2 id="hospital-deletion" className="text-lg font-semibold">
        {t('platform.deletion.heading')}
      </h2>

      <h3 className="text-sm font-medium">{t('platform.deletion.exportHeading')}</h3>
      {exports.isPending ? (
        <p className="text-sm text-muted-foreground">{t('platform.deletion.loading')}</p>
      ) : exports.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t(errorMessageKey(exports.error))}
        </p>
      ) : latestExport === undefined ? (
        <p className="text-sm text-muted-foreground">{t('platform.deletion.exportNone')}</p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t('platform.deletion.exportMade', {
            when: format.dateTime(latestExport.finishedAt ?? latestExport.requestedAt),
          })}{' '}
          {latestExport.firstDownloadedAt === null
            ? t('platform.deletion.exportNotDownloaded')
            : t('platform.deletion.exportDownloaded', {
                when: format.dateTime(latestExport.firstDownloadedAt),
              })}
        </p>
      )}

      <h3 className="text-sm font-medium">{t('platform.deletion.requestHeading')}</h3>
      {deletion.isPending ? (
        <p className="text-sm text-muted-foreground">{t('platform.deletion.loading')}</p>
      ) : deletion.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t(errorMessageKey(deletion.error))}
        </p>
      ) : current === null ? (
        <p className="text-sm text-muted-foreground">{t('platform.deletion.none')}</p>
      ) : (
        <div className="flex flex-col gap-1 text-sm">
          <p>
            <span className="font-medium">{t(`platform.deletion.status.${current.status}`)}</span>
            {' · '}
            {t(`platform.deletion.explain.${current.status}`)}
          </p>
          <p className="text-muted-foreground">
            {t('platform.deletion.requestedOn', { when: format.dateTime(current.requestedAt) })}
            {current.approvedAt !== null &&
              ` ${t('platform.deletion.approvedOn', { when: format.dateTime(current.approvedAt) })}`}
            {current.finishedAt !== null &&
              ` ${t('platform.deletion.finishedOn', { when: format.dateTime(current.finishedAt) })}`}
          </p>
          <p className="text-muted-foreground">
            {current.basis === 'waiver'
              ? t('platform.deletion.basisWaiver', { reference: current.waiverReference ?? '' })
              : t('platform.deletion.basisExport')}
          </p>
          {current.failure !== null && (
            <p role="alert" className="text-destructive">
              {t('platform.deletion.failure', {
                reason: t(`platform.deletion.reason.${current.failure}`, {
                  defaultValue: current.failure,
                }),
              })}
            </p>
          )}
          {current.status === 'done' && current.rowCount !== null && (
            <p className="text-muted-foreground">
              {t('platform.deletion.counts', {
                tables: current.tableCount ?? 0,
                rows: current.rowCount,
                files: current.fileCount ?? 0,
              })}
            </p>
          )}
        </div>
      )}

      {ownRequest && (
        <p className="text-sm text-muted-foreground">{t('platform.deletion.secondAdmin')}</p>
      )}

      <div className="flex flex-wrap gap-2">
        {canRequest && (
          <Button variant="destructive" onClick={() => open('request')}>
            {t('platform.deletion.request.action')}
          </Button>
        )}
        {canApprove && !ownRequest && (
          <Button variant="destructive" onClick={() => open('approve')}>
            {t('platform.deletion.approve.action')}
          </Button>
        )}
        {canCancel && (
          <Button variant="outline" onClick={() => open('cancel')}>
            {t('platform.deletion.cancel.action')}
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
        open={asking === 'request'}
        onClose={close}
        title={t('platform.deletion.request.title', { name: hospital.name })}
        description={t('platform.deletion.request.description')}
        cancelLabel={t('platform.status.cancel')}
        confirmLabel={t('platform.deletion.request.confirm')}
        confirmForm={REQUEST_FORM}
        destructive
        pending={busy}
      >
        <Form form={form} id={REQUEST_FORM} onSubmit={runRequest} className="gap-3">
          <TextField
            name="waiverReference"
            label={t('platform.deletion.request.waiver')}
            hint={t('platform.deletion.request.waiverHint')}
            autoComplete="off"
            data-autofocus
          />
        </Form>
        {refused !== '' && asking === 'request' && <Refusal text={refused} />}
      </ConfirmDialog>

      <ConfirmDialog
        open={asking === 'approve'}
        onClose={close}
        title={t('platform.deletion.approve.title', { name: hospital.name })}
        description={t('platform.deletion.approve.description')}
        cancelLabel={t('platform.status.cancel')}
        confirmLabel={t('platform.deletion.approve.confirm')}
        destructive
        pending={busy}
        onConfirm={() => run('approve')}
      >
        {refused !== '' && asking === 'approve' && <Refusal text={refused} />}
      </ConfirmDialog>

      <ConfirmDialog
        open={asking === 'cancel'}
        onClose={close}
        title={t('platform.deletion.cancel.title', { name: hospital.name })}
        description={t('platform.deletion.cancel.description')}
        cancelLabel={t('platform.deletion.cancel.keep')}
        confirmLabel={t('platform.deletion.cancel.confirm')}
        pending={busy}
        onConfirm={() => run('cancel')}
      >
        {refused !== '' && asking === 'cancel' && <Refusal text={refused} />}
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
