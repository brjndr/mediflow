import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { currencyDigits } from '@/features/services';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import {
  Form,
  SelectField,
  TextAreaField,
  TextField,
  useFieldValue,
  useZodForm,
} from '@/shared/ui/form';
import { useTenant } from '@/tenancy';
import {
  decisionFormSchema,
  preAuthFormSchema,
  toDecision,
  toPreAuthCreate,
  type DecisionFormValues,
  type PreAuthFormValues,
} from '../coverage-schemas';
import { useCreatePreAuth, useDecidePreAuth } from '../hooks/use-coverage';
import type { PatientPolicy, PreAuth } from '../types';
import { refusalKey } from './refusal';

/**
 * Asks the payer of one of the patient's active policies to approve the cost of a treatment.
 * What is enclosed is written by name, one to a line: the files themselves are on the patient's
 * record (documents). From a visit's bill the request is tied to that visit (`encounterId`).
 */
export function PreAuthDialog({
  patientId,
  policies,
  encounterId,
  onClose,
  onSaved,
}: {
  patientId: string;
  /** The patient's active policies. */
  policies: PatientPolicy[];
  encounterId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const digits = currencyDigits(useTenant()?.currency);
  const schema = useMemo(() => preAuthFormSchema(digits), [digits]);
  const form = useZodForm(schema, {
    policyId: policies.length === 1 ? (policies[0]?.id ?? '') : '',
    treatment: '',
    requested: '',
    documents: '',
  });
  const create = useCreatePreAuth(patientId);
  const refused = refusalKey(create.error);

  const submit = async (values: PreAuthFormValues) => {
    try {
      await create.mutateAsync(toPreAuthCreate(values, digits, encounterId));
      onSaved();
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('preauth.add.title')}
      description={t('preauth.add.description')}
      closeLabel={t('close')}
      busy={create.isPending}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="preauth-form" aria-busy={create.isPending}>
            {create.isPending ? t('saving') : t('preauth.add.submit')}
          </Button>
        </>
      }
    >
      <Form form={form} id="preauth-form" onSubmit={submit} className="flex flex-col gap-4">
        <SelectField<PreAuthFormValues>
          name="policyId"
          label={t('preauth.policy')}
          required
          placeholder={t('preauth.choosePolicy')}
          options={policies.map((policy) => ({
            value: policy.id,
            label: `${policy.payerName}, ${policy.policyNumber}`,
          }))}
        />
        <TextAreaField<PreAuthFormValues>
          name="treatment"
          label={t('preauth.treatment')}
          hint={t('preauth.treatmentHint')}
          required
          rows={3}
          maxLength={300}
        />
        <TextField<PreAuthFormValues>
          name="requested"
          label={t('preauth.requested')}
          hint={t('preauth.requestedHint')}
          required
          inputMode="decimal"
          autoComplete="off"
        />
        <TextAreaField<PreAuthFormValues>
          name="documents"
          label={t('preauth.documents')}
          hint={t('preauth.documentsHint')}
          rows={3}
        />
        {create.error && (
          <p role="alert" className="text-sm text-destructive">
            {refused ? t(refused) : tCommon(errorMessageKey(create.error))}
          </p>
        )}
      </Form>
    </Dialog>
  );
}

/** The amount field only matters when the payer approved. */
function ApprovedField() {
  const { t } = useTranslation('insurance');
  const outcome = useFieldValue('outcome');
  if (outcome !== 'approved') return null;
  return (
    <TextField<DecisionFormValues>
      name="approved"
      label={t('preauth.approved')}
      hint={t('preauth.approvedHint')}
      required
      inputMode="decimal"
      autoComplete="off"
    />
  );
}

/** Records what the payer answered: approved up to an amount, or turned down. */
export function DecisionDialog({
  preAuth,
  onClose,
  onSaved,
}: {
  preAuth: PreAuth;
  onClose: () => void;
  onSaved: (outcome: 'approved' | 'rejected') => void;
}) {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const digits = currencyDigits(useTenant()?.currency);
  const schema = useMemo(() => decisionFormSchema(digits), [digits]);
  const form = useZodForm(schema, {
    outcome: 'approved',
    approved: '',
    referenceNumber: '',
    note: '',
  });
  const decide = useDecidePreAuth(preAuth.id);
  const refused = refusalKey(decide.error);

  const submit = async (values: DecisionFormValues) => {
    try {
      await decide.mutateAsync(toDecision(values, digits, preAuth.version));
      onSaved(values.outcome);
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('preauth.decide.title')}
      description={t('preauth.decide.description', { payer: preAuth.payerName })}
      closeLabel={t('close')}
      busy={decide.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="decision-form" aria-busy={decide.isPending}>
            {decide.isPending ? t('saving') : t('save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="decision-form" onSubmit={submit} className="flex flex-col gap-4">
        <SelectField<DecisionFormValues>
          name="outcome"
          label={t('preauth.outcome')}
          required
          options={[
            { value: 'approved', label: t('preauth.status.approved') },
            { value: 'rejected', label: t('preauth.status.rejected') },
          ]}
        />
        <ApprovedField />
        <TextField<DecisionFormValues>
          name="referenceNumber"
          label={t('preauth.reference')}
          maxLength={60}
          autoComplete="off"
        />
        <TextAreaField<DecisionFormValues>
          name="note"
          label={t('preauth.note')}
          rows={2}
          maxLength={300}
        />
        {decide.error && (
          <p role="alert" className="text-sm text-destructive">
            {refused ? t(refused) : tCommon(errorMessageKey(decide.error))}
          </p>
        )}
      </Form>
    </Dialog>
  );
}
