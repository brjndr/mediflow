import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, TextAreaField, useZodForm } from '@/shared/ui/form';
import { useDecideCorrection, useRequestCorrection } from '../hooks/use-records';
import {
  correctionFormSchema,
  decisionFormSchema,
  type CorrectionFormValues,
  type DecisionFormValues,
} from '../schemas';
import type { CorrectionRequest } from '../types';

/** The refusals the server gives, each said in words. */
const REFUSED: Record<string, string> = {
  second_person_required: 'corrections.errors.secondPerson',
  already_decided: 'corrections.errors.decided',
  conflict: 'corrections.errors.conflict',
  patient_merged: 'corrections.errors.merged',
  target_mismatch: 'corrections.errors.target',
};

function useFailure(error: unknown) {
  const { t } = useTranslation('records');
  const { t: tCommon } = useTranslation();
  if (!error) return undefined;
  const code = isApiError(error) ? error.serverCode : undefined;
  return code !== undefined && REFUSED[code] ? t(REFUSED[code]) : tCommon(errorMessageKey(error));
}

/**
 * Asks for a correction to a patient's record: what should change and why. Nothing is edited;
 * a second person decides, and the module that owns the record applies it.
 */
export function RequestCorrectionDialog({
  patientId,
  onClose,
  onRequested,
}: {
  patientId: string;
  onClose: () => void;
  onRequested: () => void;
}) {
  const { t } = useTranslation('records');
  const create = useRequestCorrection(patientId);
  const form = useZodForm(correctionFormSchema, { proposed: '', reason: '' });
  const failure = useFailure(create.error);

  const submit = async (values: CorrectionFormValues) => {
    try {
      await create.mutateAsync({ targetKind: 'patient', ...values });
      onRequested();
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('corrections.requestTitle')}
      description={t('corrections.requestDescription')}
      closeLabel={t('close')}
      busy={create.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="correction-request-form" aria-busy={create.isPending}>
            {create.isPending ? t('corrections.sending') : t('corrections.send')}
          </Button>
        </>
      }
    >
      <Form form={form} id="correction-request-form" onSubmit={submit}>
        <TextAreaField<CorrectionFormValues>
          name="proposed"
          label={t('corrections.proposed')}
          hint={t('corrections.proposedHint')}
          required
        />
        <TextAreaField<CorrectionFormValues>
          name="reason"
          label={t('corrections.reason')}
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

/** Approves or rejects a pending request, with a reason, at the version read. */
export function DecideCorrectionDialog({
  request,
  decision,
  onClose,
  onDecided,
}: {
  request: CorrectionRequest;
  decision: 'approve' | 'reject';
  onClose: () => void;
  onDecided: (decided: CorrectionRequest) => void;
}) {
  const { t } = useTranslation('records');
  const decide = useDecideCorrection(request.id, decision);
  const form = useZodForm(decisionFormSchema, { reason: '' });
  const failure = useFailure(decide.error);

  const submit = async (values: DecisionFormValues) => {
    try {
      onDecided(await decide.mutateAsync({ ...values, expectedVersion: request.version }));
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t(`corrections.${decision}Title`)}
      description={t('corrections.decideDescription', { proposed: request.proposed })}
      closeLabel={t('close')}
      busy={decide.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="correction-decide-form" aria-busy={decide.isPending}>
            {t(`corrections.${decision}Submit`)}
          </Button>
        </>
      }
    >
      <Form form={form} id="correction-decide-form" onSubmit={submit}>
        <TextAreaField<DecisionFormValues>
          name="reason"
          label={t('corrections.decisionReason')}
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
