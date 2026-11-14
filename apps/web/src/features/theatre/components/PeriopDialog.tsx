import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, SelectField, SubmitButton, TextAreaField, useZodForm } from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import {
  useCompleteStep,
  usePeriop,
  useRecordFitness,
  useSaveAnaesthesia,
  useSignAnaesthesia,
} from '../hooks/use-theatre';
import {
  anaesthesiaFormSchema,
  ASA_CLASSES,
  CHECKLIST_PHASES,
  fitnessFormSchema,
  FITNESS,
  phaseOpen,
  TECHNIQUES,
  type AnaesthesiaFormValues,
  type FitnessFormValues,
} from '../schemas';
import type { ChecklistEntry, ChecklistStepCode, PeriopRecord, Surgery } from '../types';

const KNOWN_ERRORS = ['phase_incomplete', 'invalid_state', 'already_signed'];

/** The server's refusals in words; anything else goes through the shared messages. */
function useFailure(error: unknown): string | undefined {
  const { t } = useTranslation('theatre');
  const { t: tCommon } = useTranslation();
  if (!error) return undefined;
  if (isApiError(error) && error.serverCode && KNOWN_ERRORS.includes(error.serverCode)) {
    return t(`periop.errors.${error.serverCode}`);
  }
  return tCommon(errorMessageKey(error));
}

function Failure({ error }: { error: unknown }) {
  const text = useFailure(error);
  return text ? (
    <p role="alert" className="text-sm text-destructive">
      {text}
    </p>
  ) : null;
}

function FitnessSection({
  surgery,
  record,
  canWrite,
  onSaved,
}: {
  surgery: Surgery;
  record: PeriopRecord;
  canWrite: boolean;
  onSaved: (message: string) => void;
}) {
  const { t } = useTranslation('theatre');
  const format = useFormatters();
  const save = useRecordFitness(surgery.id);
  const form = useZodForm(fitnessFormSchema, {
    status: (record.fitness?.status ?? '') as FitnessFormValues['status'],
    notes: record.fitness?.notes ?? '',
  });
  const submit = async (values: FitnessFormValues) => {
    try {
      await save.mutateAsync({
        status: values.status,
        ...(values.notes ? { notes: values.notes } : {}),
      });
      onSaved(t('periop.done.fitness'));
    } catch {
      // Said below, from the mutation state.
    }
  };
  const fitness = record.fitness;
  return (
    <section aria-labelledby="fitness-heading" className="flex flex-col gap-3">
      <h3 id="fitness-heading" className="text-base font-semibold">
        {t('periop.fitness.heading')}
      </h3>
      <p className="text-sm text-muted-foreground">
        {fitness
          ? t('periop.fitness.current', {
              status: t(`periop.fitness.status.${fitness.status}`),
              name: fitness.assessedByName,
              time: format.dateTime(fitness.assessedAt),
            })
          : t('periop.fitness.none')}
      </p>
      {canWrite && (
        <Form form={form} id="periop-fitness-form" onSubmit={submit}>
          <SelectField<FitnessFormValues>
            name="status"
            label={t('periop.fitness.label')}
            required
            placeholder={t('periop.fitness.choose')}
            options={FITNESS.map((value) => ({
              value,
              label: t(`periop.fitness.status.${value}`),
            }))}
          />
          <TextAreaField<FitnessFormValues> name="notes" label={t('periop.fitness.notes')} />
          <Failure error={save.error} />
          <div>
            <SubmitButton pending={save.isPending}>{t('periop.fitness.save')}</SubmitButton>
          </div>
        </Form>
      )}
    </section>
  );
}

function ChecklistSection({
  surgeryId,
  record,
  canWrite,
  onDone,
}: {
  surgeryId: string;
  record: PeriopRecord;
  canWrite: boolean;
  onDone: (message: string) => void;
}) {
  const { t } = useTranslation('theatre');
  const format = useFormatters();
  const complete = useCompleteStep(surgeryId);
  const entries = new Map<ChecklistStepCode, ChecklistEntry>(
    record.checklist.map((entry) => [entry.step, entry]),
  );
  const done = new Set(entries.keys());

  const run = async (step: ChecklistStepCode) => {
    complete.reset();
    try {
      await complete.mutateAsync({ step });
      onDone(t('periop.done.step', { step: t(`periop.steps.${step}`) }));
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <section aria-labelledby="checklist-heading" className="flex flex-col gap-4">
      <h3 id="checklist-heading" className="text-base font-semibold">
        {t('periop.checklist.heading')}
      </h3>
      <p className="text-sm text-muted-foreground">{t('periop.checklist.description')}</p>
      <Failure error={complete.error} />
      {CHECKLIST_PHASES.map(({ phase, steps }, index) => {
        const open = phaseOpen(index, done);
        return (
          <div key={phase} className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold">{t(`periop.phases.${phase}`)}</h4>
            {!open && (
              <p className="text-sm text-muted-foreground">{t('periop.checklist.waiting')}</p>
            )}
            <ul className="flex flex-col divide-y rounded-md border">
              {steps.map((step) => {
                const entry = entries.get(step);
                return (
                  <li
                    key={step}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                  >
                    <span className="text-sm">{t(`periop.steps.${step}`)}</span>
                    {entry ? (
                      <span className="text-sm text-muted-foreground">
                        {t('periop.checklist.signed', {
                          name: entry.completedByName,
                          time: format.dateTime(entry.completedAt),
                        })}
                      </span>
                    ) : canWrite ? (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t('periop.checklist.markLabel', {
                          step: t(`periop.steps.${step}`),
                        })}
                        aria-disabled={!open || complete.isPending || undefined}
                        onClick={() => open && !complete.isPending && void run(step)}
                      >
                        {t('periop.checklist.mark')}
                      </Button>
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        {t('periop.checklist.pending')}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

function AnaesthesiaSection({
  surgeryId,
  record,
  canWrite,
  onSaved,
}: {
  surgeryId: string;
  record: PeriopRecord;
  canWrite: boolean;
  onSaved: (message: string) => void;
}) {
  const { t } = useTranslation('theatre');
  const format = useFormatters();
  const save = useSaveAnaesthesia(surgeryId);
  const sign = useSignAnaesthesia(surgeryId);
  const draft = record.anaesthesia;
  const form = useZodForm(anaesthesiaFormSchema, {
    technique: (draft?.technique ?? '') as AnaesthesiaFormValues['technique'],
    asaClass: (draft ? String(draft.asaClass) : '') as AnaesthesiaFormValues['asaClass'],
    drugs: draft?.drugs ?? '',
    notes: draft?.notes ?? '',
  });
  const submit = async (values: AnaesthesiaFormValues) => {
    try {
      await save.mutateAsync({
        technique: values.technique,
        asaClass: Number(values.asaClass),
        ...(values.drugs ? { drugs: values.drugs } : {}),
        ...(values.notes ? { notes: values.notes } : {}),
      });
      form.reset(values);
      onSaved(t('periop.done.anaesthesiaSaved'));
    } catch {
      // Said below, from the mutation state.
    }
  };
  const signNow = async () => {
    sign.reset();
    try {
      await sign.mutateAsync();
      onSaved(t('periop.done.anaesthesiaSigned'));
    } catch {
      // Said below, from the mutation state.
    }
  };
  const signed = draft?.signedAt !== undefined;

  return (
    <section aria-labelledby="anaesthesia-heading" className="flex flex-col gap-3">
      <h3 id="anaesthesia-heading" className="text-base font-semibold">
        {t('periop.anaesthesia.heading')}
      </h3>
      {signed && draft ? (
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="font-medium">{t('periop.anaesthesia.technique')}</dt>
            <dd>{t(`periop.anaesthesia.techniques.${draft.technique}`)}</dd>
          </div>
          <div>
            <dt className="font-medium">{t('periop.anaesthesia.asa')}</dt>
            <dd>{draft.asaClass}</dd>
          </div>
          {draft.drugs && (
            <div className="sm:col-span-2">
              <dt className="font-medium">{t('periop.anaesthesia.drugs')}</dt>
              <dd className="whitespace-pre-wrap">{draft.drugs}</dd>
            </div>
          )}
          {draft.notes && (
            <div className="sm:col-span-2">
              <dt className="font-medium">{t('periop.anaesthesia.notes')}</dt>
              <dd className="whitespace-pre-wrap">{draft.notes}</dd>
            </div>
          )}
          <p className="text-muted-foreground sm:col-span-2">
            {t('periop.anaesthesia.signedBy', {
              name: draft.signedByName ?? '',
              time: draft.signedAt ? format.dateTime(draft.signedAt) : '',
            })}
          </p>
        </dl>
      ) : !canWrite ? (
        <p className="text-sm text-muted-foreground">
          {draft ? t('periop.anaesthesia.unsigned') : t('periop.anaesthesia.none')}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {draft
              ? t('periop.anaesthesia.draftSaved', { time: format.dateTime(draft.savedAt) })
              : t('periop.anaesthesia.none')}
          </p>
          <Form form={form} id="periop-anaesthesia-form" onSubmit={submit}>
            <SelectField<AnaesthesiaFormValues>
              name="technique"
              label={t('periop.anaesthesia.technique')}
              required
              placeholder={t('periop.anaesthesia.chooseTechnique')}
              options={TECHNIQUES.map((value) => ({
                value,
                label: t(`periop.anaesthesia.techniques.${value}`),
              }))}
            />
            <SelectField<AnaesthesiaFormValues>
              name="asaClass"
              label={t('periop.anaesthesia.asa')}
              required
              placeholder={t('periop.anaesthesia.chooseAsa')}
              options={ASA_CLASSES.map((value) => ({ value, label: `ASA ${value}` }))}
            />
            <TextAreaField<AnaesthesiaFormValues>
              name="drugs"
              label={t('periop.anaesthesia.drugs')}
            />
            <TextAreaField<AnaesthesiaFormValues>
              name="notes"
              label={t('periop.anaesthesia.notes')}
            />
            <Failure error={save.error ?? sign.error} />
            <div className="flex flex-wrap gap-2">
              <SubmitButton variant="outline" pending={save.isPending}>
                {t('periop.anaesthesia.save')}
              </SubmitButton>
              {draft && (
                <Button
                  aria-disabled={sign.isPending || form.formState.isDirty || undefined}
                  onClick={() => !sign.isPending && !form.formState.isDirty && void signNow()}
                >
                  {t('periop.anaesthesia.sign')}
                </Button>
              )}
            </div>
            {draft && form.formState.isDirty && (
              <p className="text-sm text-muted-foreground">{t('periop.anaesthesia.saveFirst')}</p>
            )}
          </Form>
        </>
      )}
    </section>
  );
}

/**
 * The pre-operative and peri-operative record of one surgery (#177): fitness, the checklist
 * steps (each timestamped and signed by the person who ticked it, by the server) and the
 * anaesthesia record. Everyone with the theatre sees it; `surgery:perform` changes it.
 */
export function PeriopDialog({ surgery, onClose }: { surgery: Surgery; onClose: () => void }) {
  const { t } = useTranslation('theatre');
  const { t: tCommon } = useTranslation();
  const periop = usePeriop(surgery.id);
  const canPerform = usePermission('surgery:perform');
  const canWrite =
    canPerform && (surgery.status === 'scheduled' || surgery.status === 'in_progress');
  const [done, setDone] = useState('');
  const statusLine = useRef<HTMLParagraphElement>(null);
  const said = (message: string) => {
    setDone(message);
    // The button that was pressed may be gone by now.
    setTimeout(() => focusIfLost(statusLine.current), 0);
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('periop.title', { procedure: surgery.procedure })}
      description={t('periop.description')}
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
      {periop.isPending ? (
        <p>{t('periop.loading')}</p>
      ) : periop.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(periop.error))}
          </p>
          <Button variant="outline" onClick={() => void periop.refetch()}>
            {t('periop.retry')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {!canWrite && <p className="text-sm text-muted-foreground">{t('periop.readOnly')}</p>}
          <FitnessSection
            surgery={surgery}
            record={periop.data}
            canWrite={canWrite}
            onSaved={said}
          />
          <ChecklistSection
            surgeryId={surgery.id}
            record={periop.data}
            canWrite={canWrite}
            onDone={said}
          />
          <AnaesthesiaSection
            surgeryId={surgery.id}
            record={periop.data}
            canWrite={canWrite}
            onSaved={said}
          />
        </div>
      )}
    </Dialog>
  );
}
