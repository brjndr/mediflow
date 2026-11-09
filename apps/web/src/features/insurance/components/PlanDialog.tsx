import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { currencyDigits } from '@/features/services';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { CheckboxField, Form, SelectField, TextField, useZodForm } from '@/shared/ui/form';
import { useTenant } from '@/tenancy';
import { useCreatePlan, useUpdatePlan } from '../hooks/use-payers';
import {
  COVERAGE_MODES,
  planFormSchema,
  toPlanFormValues,
  toPlanTerms,
  type PlanFormValues,
} from '../schemas';
import type { PayerPlan } from '../types';
import { refusalKey } from './refusal';
import { ServiceRows } from './ServiceRows';

/** Adds a plan to a payer, or changes the terms of one. The code is chosen once. */
export function PlanDialog({
  payerId,
  plan,
  onClose,
  onSaved,
}: {
  payerId: string;
  /** The plan being changed; absent when adding. */
  plan?: PayerPlan;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const digits = currencyDigits(useTenant()?.currency);
  const adding = plan === undefined;
  const schema = useMemo(() => planFormSchema(digits, adding), [digits, adding]);
  const form = useZodForm(schema, toPlanFormValues(plan, digits));
  const create = useCreatePlan(payerId);
  const update = useUpdatePlan();
  const failure = create.error ?? update.error;
  const pending = create.isPending || update.isPending;
  const refused = refusalKey(failure);

  const submit = async (values: PlanFormValues) => {
    const terms = toPlanTerms(values, digits);
    try {
      if (plan) {
        await update.mutateAsync({ planId: plan.id, body: { ...terms, version: plan.version } });
      } else {
        await create.mutateAsync({ code: values.code, ...terms });
      }
      onSaved(values.name);
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={adding ? t('plan.add.title') : t('plan.edit.title', { name: plan.name })}
      description={t('plan.description')}
      closeLabel={t('close')}
      busy={pending}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="plan-form" aria-busy={pending}>
            {pending ? t('saving') : t('save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="plan-form" onSubmit={submit} className="flex flex-col gap-4">
        {adding && (
          <TextField<PlanFormValues>
            name="code"
            label={t('plan.code')}
            hint={t('plan.codeHint')}
            required
            maxLength={20}
            autoComplete="off"
          />
        )}
        <TextField<PlanFormValues>
          name="name"
          label={t('plan.name')}
          required
          maxLength={100}
          autoComplete="off"
        />
        <TextField<PlanFormValues>
          name="copayPercent"
          label={t('plan.copayPercent')}
          hint={t('plan.copayHint')}
          required
          inputMode="numeric"
          maxLength={3}
          autoComplete="off"
        />
        <TextField<PlanFormValues>
          name="sumInsured"
          label={t('plan.sumInsured')}
          hint={t('plan.noLimitHint')}
          inputMode="decimal"
          autoComplete="off"
        />
        <TextField<PlanFormValues>
          name="roomRentLimit"
          label={t('plan.roomRentLimit')}
          hint={t('plan.noLimitHint')}
          inputMode="decimal"
          autoComplete="off"
        />
        <CheckboxField<PlanFormValues>
          name="preAuthRequired"
          label={t('plan.preAuthRequired')}
          hint={t('plan.preAuthHint')}
        />
        <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
          <legend className="px-1 text-sm font-medium">{t('plan.eligibility')}</legend>
          <TextField<PlanFormValues>
            name="minAge"
            label={t('plan.minAge')}
            inputMode="numeric"
            maxLength={3}
            autoComplete="off"
          />
          <TextField<PlanFormValues>
            name="maxAge"
            label={t('plan.maxAge')}
            inputMode="numeric"
            maxLength={3}
            autoComplete="off"
          />
          <TextField<PlanFormValues>
            name="waitingPeriodDays"
            label={t('plan.waitingPeriodDays')}
            hint={t('plan.waitingHint')}
            inputMode="numeric"
            maxLength={4}
            autoComplete="off"
          />
        </fieldset>
        <SelectField<PlanFormValues>
          name="coverageMode"
          label={t('plan.coverageMode')}
          hint={t('plan.coverageHint')}
          required
          options={COVERAGE_MODES.map((value) => ({ value, label: t(`coverage.${value}`) }))}
        />
        <ServiceRows
          name="services"
          label={t('plan.services')}
          amountLabel={t('plan.serviceLimit')}
          amountHint={t('plan.noLimitHint')}
          emptyText={t('plan.noServices')}
        />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {refused ? t(refused) : tCommon(errorMessageKey(failure))}
          </p>
        )}
      </Form>
    </Dialog>
  );
}
