import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { currencyDigits } from '@/features/services';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, TextField, useZodForm } from '@/shared/ui/form';
import { useTenant } from '@/tenancy';
import { useCreateAgreement } from '../hooks/use-payers';
import { agreementFormSchema, toAgreementCreate, type AgreementFormValues } from '../schemas';
import { refusalKey } from './refusal';
import { ServiceRows } from './ServiceRows';

/**
 * Adds a rate agreement: a name, the period it applies to, a discount on the price list and a
 * rate for named services. An agreement is never edited afterwards, only ended (see the notes of
 * the module), so a bill priced under it can always be explained.
 */
export function AgreementDialog({
  payerId,
  onClose,
  onSaved,
}: {
  payerId: string;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const digits = currencyDigits(useTenant()?.currency);
  const schema = useMemo(() => agreementFormSchema(digits), [digits]);
  const form = useZodForm(schema, {
    name: '',
    effectiveFrom: '',
    effectiveTo: '',
    discountPercent: '0',
    rates: [],
  });
  const create = useCreateAgreement(payerId);
  const refused = refusalKey(create.error);

  const submit = async (values: AgreementFormValues) => {
    try {
      await create.mutateAsync(toAgreementCreate(values, digits));
      onSaved(values.name);
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('agreement.add.title')}
      description={t('agreement.description')}
      closeLabel={t('close')}
      busy={create.isPending}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="agreement-form" aria-busy={create.isPending}>
            {create.isPending ? t('saving') : t('save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="agreement-form" onSubmit={submit} className="flex flex-col gap-4">
        <TextField<AgreementFormValues>
          name="name"
          label={t('agreement.name')}
          required
          maxLength={100}
          autoComplete="off"
        />
        <TextField<AgreementFormValues>
          name="effectiveFrom"
          type="date"
          label={t('agreement.effectiveFrom')}
          hint={t('agreement.fromHint')}
          required
        />
        <TextField<AgreementFormValues>
          name="effectiveTo"
          type="date"
          label={t('agreement.effectiveTo')}
          hint={t('agreement.toHint')}
        />
        <TextField<AgreementFormValues>
          name="discountPercent"
          label={t('agreement.discountPercent')}
          hint={t('agreement.discountHint')}
          required
          inputMode="decimal"
          maxLength={6}
          autoComplete="off"
        />
        <ServiceRows
          name="rates"
          label={t('agreement.rates')}
          amountLabel={t('agreement.rate')}
          required
          emptyText={t('agreement.noRates')}
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
