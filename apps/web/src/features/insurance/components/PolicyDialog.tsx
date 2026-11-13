import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import {
  Form,
  SelectField,
  TextField,
  useFieldValue,
  useSetFieldValue,
  useZodForm,
} from '@/shared/ui/form';
import { useCreatePolicy } from '../hooks/use-coverage';
import { usePayer, usePayers } from '../hooks/use-payers';
import {
  policyFormSchema,
  RELATIONSHIPS,
  toPolicyCreate,
  type PolicyFormValues,
} from '../coverage-schemas';
import { refusalKey } from './refusal';

const NO_FILTERS = { q: '', kind: '', archived: false } as const;

/** The plan choice follows the organisation chosen above it. */
function PlanSelect() {
  const { t } = useTranslation('insurance');
  const payerId = String(useFieldValue('payerId') ?? '');
  const payer = usePayer(payerId);
  const options = (payer.data?.plans ?? [])
    .filter((plan) => !plan.archived)
    .map((plan) => ({ value: plan.id, label: `${plan.name} (${plan.code})` }));
  // Choosing another organisation lets go of the plan chosen under the last one.
  const planId = String(useFieldValue('planId') ?? '');
  const setValue = useSetFieldValue();
  const known = payerId === '' || payer.data?.payer.id === payerId;
  const stale = planId !== '' && known && !options.some((option) => option.value === planId);
  useEffect(() => {
    if (stale) setValue('planId', '');
  }, [stale, setValue]);
  return (
    <SelectField<PolicyFormValues>
      name="planId"
      label={t('policy.plan')}
      required
      placeholder={payerId === '' ? t('policy.choosePayerFirst') : t('policy.choosePlan')}
      options={options}
    />
  );
}

/**
 * Records an insurance policy on the patient: the organisation and plan it is with, the number
 * on the card, whose policy it is and the dates it runs. Reads the organisations (`payer:read`).
 */
export function PolicyDialog({
  patientId,
  onClose,
  onSaved,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const payers = usePayers(NO_FILTERS);
  const form = useZodForm(policyFormSchema, {
    payerId: '',
    planId: '',
    policyNumber: '',
    memberId: '',
    holderName: '',
    relationship: 'self',
    validFrom: '',
    validTo: '',
  });
  const create = useCreatePolicy(patientId);
  const refused = refusalKey(create.error);
  const payerOptions = (payers.data?.pages.flatMap((page) => page.items) ?? []).map((payer) => ({
    value: payer.id,
    label: payer.name,
  }));

  const submit = async (values: PolicyFormValues) => {
    try {
      await create.mutateAsync(toPolicyCreate(values));
      onSaved();
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('policy.add.title')}
      description={t('policy.add.description')}
      closeLabel={t('close')}
      busy={create.isPending}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="policy-form" aria-busy={create.isPending}>
            {create.isPending ? t('saving') : t('save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="policy-form" onSubmit={submit} className="flex flex-col gap-4">
        <SelectField<PolicyFormValues>
          name="payerId"
          label={t('policy.payer')}
          required
          placeholder={t('policy.choosePayer')}
          options={payerOptions}
        />
        <PlanSelect />
        <TextField<PolicyFormValues>
          name="policyNumber"
          label={t('policy.number')}
          required
          maxLength={40}
          autoComplete="off"
        />
        <TextField<PolicyFormValues>
          name="memberId"
          label={t('policy.memberId')}
          maxLength={40}
          autoComplete="off"
        />
        <TextField<PolicyFormValues>
          name="holderName"
          label={t('policy.holder')}
          required
          maxLength={100}
          autoComplete="off"
        />
        <SelectField<PolicyFormValues>
          name="relationship"
          label={t('policy.relationship')}
          required
          options={RELATIONSHIPS.map((value) => ({
            value,
            label: t(`policy.relation.${value}`),
          }))}
        />
        <TextField<PolicyFormValues>
          name="validFrom"
          type="date"
          label={t('policy.validFrom')}
          required
        />
        <TextField<PolicyFormValues>
          name="validTo"
          type="date"
          label={t('policy.validTo')}
          hint={t('policy.validToHint')}
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
