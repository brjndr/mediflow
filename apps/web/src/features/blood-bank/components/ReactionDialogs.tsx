import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Can } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, SelectField, TextAreaField, TextField, useZodForm } from '@/shared/ui/form';
import { StatusBadge, type StatusTone } from '@/shared/ui/status-badge';
import { useFormatters, useTenant } from '@/tenancy';
import { useReactionUpdate, useRecordReaction, useTrace } from '../hooks/use-blood';
import {
  ACTIONS_MAX,
  REACTION_KINDS,
  REACTION_SEVERITIES,
  reactionFormSchema,
  reactionUpdateFormSchema,
  severityRank,
  type ReactionFormValues,
  type ReactionUpdateFormValues,
} from '../schemas';
import type { BloodUnit, ReactionSeverity, TransfusionReaction } from '../types';
import { PatientLabel } from './Dialogs';
import { instant, useFailure } from './helpers';

const TONES: Record<ReactionSeverity, StatusTone> = {
  mild: 'info',
  moderate: 'warning',
  severe: 'danger',
};

function SeverityBadge({ severity }: { severity: ReactionSeverity }) {
  const { t } = useTranslation('blood-bank');
  return <StatusBadge tone={TONES[severity]} label={t(`severity.${severity}`)} />;
}

/** Records a reaction to a unit that was given. A severe or hemolytic one holds its siblings. */
export function ReactionDialog({
  unit,
  onClose,
  onDone,
}: {
  unit: BloodUnit;
  onClose: () => void;
  onDone: (reaction: TransfusionReaction) => void;
}) {
  const { t } = useTranslation('blood-bank');
  const timezone = useTenant()?.timezone ?? 'UTC';
  const record = useRecordReaction();
  const form = useZodForm(reactionFormSchema, {
    kind: 'febrile',
    severity: 'mild',
    transfusedAt: '',
    onsetAt: '',
    actions: '',
  });
  const kind = form.watch('kind');
  const severity = form.watch('severity');
  const holds = kind === 'hemolytic' || severity === 'severe';
  const failure = useFailure(record.error);

  const submit = async (values: ReactionFormValues) => {
    if (!unit.patientId) return;
    try {
      onDone(
        await record.mutateAsync({
          unitId: unit.id,
          patientId: unit.patientId,
          kind: values.kind,
          severity: values.severity,
          transfusedAt: instant(values.transfusedAt, timezone),
          onsetAt: instant(values.onsetAt, timezone),
          actions: values.actions,
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
      title={t('reaction.title', { number: unit.unitNumber })}
      description={t('reaction.description')}
      closeLabel={t('close')}
      busy={record.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            form="blood-reaction-form"
            variant={holds ? 'destructive' : 'default'}
            aria-disabled={record.isPending}
          >
            {record.isPending ? t('reaction.saving') : t('reaction.submit')}
          </Button>
        </>
      }
    >
      <Form form={form} id="blood-reaction-form" onSubmit={submit}>
        <p className="text-sm text-muted-foreground">
          {unit.patientId ? (
            <>
              {t('history.patient')}: <PatientLabel id={unit.patientId} />
            </>
          ) : (
            t('reaction.noPatient')
          )}
        </p>
        <SelectField<ReactionFormValues>
          name="kind"
          label={t('reaction.kind')}
          required
          options={REACTION_KINDS.map((value) => ({ value, label: t(`reaction.kinds.${value}`) }))}
        />
        <SelectField<ReactionFormValues>
          name="severity"
          label={t('reaction.severity')}
          required
          hint={t('reaction.severityHint')}
          options={REACTION_SEVERITIES.map((value) => ({
            value,
            label: t(`severity.${value}`),
          }))}
        />
        <TextField<ReactionFormValues>
          name="transfusedAt"
          type="datetime-local"
          label={t('reaction.transfusedAt')}
          required
        />
        <TextField<ReactionFormValues>
          name="onsetAt"
          type="datetime-local"
          label={t('reaction.onsetAt')}
          required
        />
        <TextAreaField<ReactionFormValues>
          name="actions"
          label={t('reaction.actions')}
          required
          maxLength={ACTIONS_MAX}
        />
        {/* Always on the page, so a screen reader reads the notice when it appears. */}
        <p
          role="status"
          className={
            holds
              ? 'rounded-md bg-warning-soft p-3 text-sm font-medium text-warning-soft-foreground'
              : 'sr-only'
          }
        >
          {holds ? t('reaction.holdNotice') : ''}
        </p>
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}

/** A note on a reaction, and optionally a higher severity: it can never be lowered. */
export function ReactionUpdateDialog({
  reaction,
  onClose,
  onDone,
}: {
  reaction: TransfusionReaction;
  onClose: () => void;
  onDone: (reaction: TransfusionReaction) => void;
}) {
  const { t } = useTranslation('blood-bank');
  const update = useReactionUpdate();
  const form = useZodForm(reactionUpdateFormSchema, { note: '', severity: '' });
  const higher = REACTION_SEVERITIES.filter(
    (value) => severityRank(value) > severityRank(reaction.currentSeverity),
  );
  const failure = useFailure(update.error);

  const submit = async (values: ReactionUpdateFormValues) => {
    try {
      onDone(
        await update.mutateAsync({
          reactionId: reaction.id,
          note: values.note,
          ...(values.severity ? { severity: values.severity } : {}),
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
      title={t('update.title')}
      description={t('update.description', {
        severity: t(`severity.${reaction.currentSeverity}`),
      })}
      closeLabel={t('close')}
      busy={update.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="blood-update-form" aria-disabled={update.isPending}>
            {update.isPending ? t('update.saving') : t('update.submit')}
          </Button>
        </>
      }
    >
      <Form form={form} id="blood-update-form" onSubmit={submit}>
        <TextAreaField<ReactionUpdateFormValues>
          name="note"
          label={t('update.note')}
          required
          maxLength={ACTIONS_MAX}
          data-autofocus
        />
        {higher.length > 0 && (
          <SelectField<ReactionUpdateFormValues>
            name="severity"
            label={t('update.severity')}
            hint={t('update.severityHint')}
            placeholder={t('update.keep')}
            options={higher.map((value) => ({ value, label: t(`severity.${value}`) }))}
          />
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

/**
 * Where a unit came from and where it went: donor (a name only when the server sends one),
 * collection, screening, every move, cross-matches, the recipient and any reactions.
 */
export function TraceDialog({ unit, onClose }: { unit: BloodUnit; onClose: () => void }) {
  const { t } = useTranslation('blood-bank');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const trace = useTrace(unit.id);
  const [updating, setUpdating] = useState<TransfusionReaction | null>(null);
  const [saved, setSaved] = useState('');

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('trace.title', { number: unit.unitNumber })}
      description={t('trace.description')}
      closeLabel={t('close')}
      size="lg"
    >
      <p role="status" className="text-sm font-medium empty:sr-only">
        {saved}
      </p>
      {trace.isPending && <p role="status">{t('trace.loading')}</p>}
      {trace.isError && (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(trace.error))}
          </p>
          <Button variant="outline" onClick={() => void trace.refetch()}>
            {t('retry')}
          </Button>
        </div>
      )}
      {trace.data && (
        <div className="flex flex-col gap-5 text-sm">
          <section aria-labelledby="trace-origin" className="flex flex-col gap-1">
            <h3 id="trace-origin" className="font-semibold">
              {t('trace.origin')}
            </h3>
            {trace.data.donor ? (
              <p>
                {t('trace.donor', {
                  number: trace.data.donor.donorNumber,
                  group: trace.data.donor.bloodGroup,
                })}
                {trace.data.donor.fullName ? ` - ${trace.data.donor.fullName}` : ''}
              </p>
            ) : (
              <p className="text-muted-foreground">{t('trace.noDonor')}</p>
            )}
            {trace.data.collectedAt && (
              <p>{t('trace.collected', { date: format.dateTime(trace.data.collectedAt) })}</p>
            )}
            {trace.data.screeningOutcome ? (
              <p className="flex flex-wrap items-center gap-2">
                {t('trace.screening')}
                <StatusBadge
                  tone={trace.data.screeningOutcome === 'cleared' ? 'success' : 'danger'}
                  label={t(`trace.outcome.${trace.data.screeningOutcome}`)}
                />
              </p>
            ) : (
              <p className="text-muted-foreground">{t('trace.notScreened')}</p>
            )}
          </section>

          <section aria-labelledby="trace-moves" className="flex flex-col gap-2">
            <h3 id="trace-moves" className="font-semibold">
              {t('trace.moves')}
            </h3>
            <ol className="flex flex-col gap-2">
              {trace.data.history.map((entry, index) => (
                <li key={index} className="rounded-md border p-3">
                  <p className="font-medium">
                    {entry.fromStatus
                      ? t('history.move', {
                          from: t(`status.${entry.fromStatus}`),
                          to: t(`status.${entry.toStatus}`),
                        })
                      : t('history.first', { to: t(`status.${entry.toStatus}`) })}
                  </p>
                  <p className="text-muted-foreground">{format.dateTime(entry.occurredAt)}</p>
                  {entry.reason && (
                    <p>
                      {t('history.reason')}: {entry.reason}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="trace-crossmatches" className="flex flex-col gap-2">
            <h3 id="trace-crossmatches" className="font-semibold">
              {t('trace.crossmatches')}
            </h3>
            {trace.data.crossmatches.length === 0 ? (
              <p className="text-muted-foreground">{t('trace.noCrossmatches')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {trace.data.crossmatches.map((match) => (
                  <li key={match.id} className="rounded-md border p-3">
                    <p className="font-medium">
                      <PatientLabel id={match.patientId} />
                    </p>
                    <p>
                      {t(`crossmatch.results.${match.result}`)},{' '}
                      {format.dateTime(match.performedAt)}
                    </p>
                    <p className="text-muted-foreground">
                      {t('trace.validUntil', { date: format.dateTime(match.validUntil) })}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="trace-recipient" className="flex flex-col gap-1">
            <h3 id="trace-recipient" className="font-semibold">
              {t('trace.recipient')}
            </h3>
            {trace.data.recipientPatientId ? (
              <p>
                <PatientLabel id={trace.data.recipientPatientId} />
              </p>
            ) : (
              <p className="text-muted-foreground">{t('trace.noRecipient')}</p>
            )}
          </section>

          <section aria-labelledby="trace-reactions" className="flex flex-col gap-2">
            <h3 id="trace-reactions" className="font-semibold">
              {t('trace.reactions')}
            </h3>
            {trace.data.reactions.length === 0 ? (
              <p className="text-muted-foreground">{t('trace.noReactions')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {trace.data.reactions.map((reaction) => (
                  <li key={reaction.id} className="flex flex-col gap-1 rounded-md border p-3">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {t(`reaction.kinds.${reaction.kind}`)}
                      <SeverityBadge severity={reaction.currentSeverity} />
                    </p>
                    <p className="text-muted-foreground">
                      {t('trace.onset', { date: format.dateTime(reaction.onsetAt) })}
                    </p>
                    <p className="whitespace-pre-line">{reaction.actions}</p>
                    {reaction.updates.length > 0 && (
                      <ul className="flex flex-col gap-1 border-l-2 pl-3">
                        {reaction.updates.map((entry) => (
                          <li key={entry.id}>
                            <span className="text-muted-foreground">
                              {format.dateTime(entry.recordedAt)}
                              {entry.severity
                                ? ` - ${t('trace.raisedTo', { severity: t(`severity.${entry.severity}`) })}`
                                : ''}
                              :{' '}
                            </span>
                            {entry.note}
                          </li>
                        ))}
                      </ul>
                    )}
                    <Can permission="transfusionReaction:record">
                      <div>
                        <Button variant="outline" onClick={() => setUpdating(reaction)}>
                          {t('trace.addUpdate')}
                        </Button>
                      </div>
                    </Can>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
      {updating && (
        <ReactionUpdateDialog
          reaction={updating}
          onClose={() => setUpdating(null)}
          onDone={(next) => {
            setUpdating(null);
            setSaved(
              next.heldUnitIds && next.heldUnitIds.length > 0
                ? t('done.updatedHeld', { count: next.heldUnitIds.length })
                : t('done.updated'),
            );
          }}
        />
      )}
    </Dialog>
  );
}
