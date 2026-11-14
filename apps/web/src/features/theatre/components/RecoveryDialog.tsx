import { CheckCircle2, HeartPulse } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { EncounterOrders } from '@/features/clinical';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import {
  Form,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  useZodForm,
} from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { useAddRecoveryNote, useRecovery } from '../hooks/use-theatre';
import { RECOVERY_READINESS, recoveryFormSchema, type RecoveryFormValues } from '../schemas';
import type { RecoveryRecord, Surgery } from '../types';

const KNOWN_ERRORS = ['invalid_state', 'feature_disabled'];

function Failure({ error }: { error: unknown }) {
  const { t } = useTranslation('theatre');
  const { t: tCommon } = useTranslation();
  if (!error) return null;
  const text =
    isApiError(error) && error.serverCode && KNOWN_ERRORS.includes(error.serverCode)
      ? t(`recovery.errors.${error.serverCode}`)
      : tCommon(errorMessageKey(error));
  return (
    <p role="alert" className="text-sm text-destructive">
      {text}
    </p>
  );
}

function NotesSection({
  surgery,
  record,
  onSaved,
}: {
  surgery: Surgery;
  record: RecoveryRecord;
  onSaved: (message: string) => void;
}) {
  const { t } = useTranslation('theatre');
  const format = useFormatters();
  const canPerform = usePermission('surgery:perform');
  const started = surgery.status === 'in_progress' || surgery.status === 'completed';
  const add = useAddRecoveryNote(surgery.id);
  const form = useZodForm(recoveryFormSchema, {
    text: '',
    painScore: '',
    readiness: 'in_recovery',
  });

  const submit = async (values: RecoveryFormValues) => {
    try {
      await add.mutateAsync({
        text: values.text,
        readiness: values.readiness,
        ...(values.painScore !== '' ? { painScore: Number(values.painScore) } : {}),
      });
      form.reset({ text: '', painScore: '', readiness: values.readiness });
      onSaved(t('recovery.notes.added'));
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <section aria-labelledby="recovery-notes-heading" className="flex flex-col gap-3">
      <h3 id="recovery-notes-heading" className="text-base font-semibold">
        {t('recovery.notes.heading')}
      </h3>
      {!started && (
        <p className="text-sm text-muted-foreground">{t('recovery.notes.notStarted')}</p>
      )}
      {record.notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('recovery.notes.none')}</p>
      ) : (
        <ul
          aria-label={t('recovery.notes.listLabel')}
          className="flex flex-col divide-y rounded-md border"
        >
          {record.notes.map((note) => (
            <li key={note.id} className="flex flex-col gap-1 px-3 py-2 text-sm">
              <span className="flex items-center gap-1 font-medium">
                {note.readiness === 'ready_for_ward' ? (
                  <CheckCircle2 aria-hidden className="size-4" />
                ) : (
                  <HeartPulse aria-hidden className="size-4" />
                )}
                {t(`recovery.notes.readiness.${note.readiness}`)}
                {note.painScore !== null && (
                  <span className="font-normal text-muted-foreground">
                    {' - '}
                    {t('recovery.notes.pain', { score: note.painScore })}
                  </span>
                )}
              </span>
              <span className="whitespace-pre-wrap">{note.text}</span>
              <span className="text-muted-foreground">
                {t('recovery.notes.by', {
                  name: note.addedByName,
                  time: format.dateTime(note.addedAt),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canPerform && started && (
        <Form form={form} id="recovery-note-form" onSubmit={submit}>
          <TextAreaField<RecoveryFormValues>
            name="text"
            label={t('recovery.notes.note')}
            hint={t('recovery.notes.noteHint')}
            required
          />
          <TextField<RecoveryFormValues>
            name="painScore"
            label={t('recovery.notes.painScore')}
            inputMode="numeric"
          />
          <SelectField<RecoveryFormValues>
            name="readiness"
            label={t('recovery.notes.readinessLabel')}
            required
            options={RECOVERY_READINESS.map((value) => ({
              value,
              label: t(`recovery.notes.readiness.${value}`),
            }))}
          />
          <Failure error={add.error} />
          <div>
            <SubmitButton pending={add.isPending}>{t('recovery.notes.add')}</SubmitButton>
          </div>
        </Form>
      )}
    </section>
  );
}

/**
 * Recovery-room notes and the orders for the visit (OT-04, #179). Everyone with the theatre
 * reads; `surgery:perform` writes a note once the surgery has started. Orders are the clinical
 * module's own panels on the visit the surgery is charged to, each with its own permissions.
 */
export function RecoveryDialog({ surgery, onClose }: { surgery: Surgery; onClose: () => void }) {
  const { t } = useTranslation('theatre');
  const { t: tCommon } = useTranslation();
  const recovery = useRecovery(surgery.id);
  const [done, setDone] = useState('');
  const statusLine = useRef<HTMLParagraphElement>(null);
  const said = (message: string) => {
    setDone(message);
    setTimeout(() => focusIfLost(statusLine.current), 0);
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('recovery.title', { procedure: surgery.procedure })}
      description={t('recovery.description')}
      closeLabel={t('close')}
      size="lg"
      footer={<Button onClick={onClose}>{t('close')}</Button>}
    >
      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm font-medium outline-none empty:sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {done}
      </p>
      {recovery.isPending ? (
        <p>{t('recovery.loading')}</p>
      ) : recovery.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(recovery.error))}
          </p>
          <Button variant="outline" onClick={() => void recovery.refetch()}>
            {t('recovery.retry')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          <NotesSection surgery={surgery} record={recovery.data} onSaved={said} />
          <section aria-labelledby="recovery-orders-heading" className="flex flex-col gap-3">
            <h3 id="recovery-orders-heading" className="text-base font-semibold">
              {t('recovery.orders.heading')}
            </h3>
            {recovery.data.encounterId ? (
              <EncounterOrders encounterId={recovery.data.encounterId} />
            ) : (
              <p className="text-sm text-muted-foreground">{t('recovery.orders.none')}</p>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}
