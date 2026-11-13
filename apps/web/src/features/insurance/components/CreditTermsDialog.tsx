import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { currencyDigits } from '@/features/services';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, TextField, useZodForm } from '@/shared/ui/form';
import { useTenant } from '@/tenancy';
import { termsFormSchema, toTermsWrite, type TermsFormValues } from '../credit';
import { useSaveCreditAccount } from '../hooks/use-credit';
import type { CreditAccount } from '../types';
import { refusalKey } from './refusal';

/** An amount in minor units as it is typed back into the field. */
function typed(minor: number, digits: number): string {
  return (minor / 10 ** digits).toFixed(digits);
}

/** Opens a corporate's credit account, or changes its limit and the days it has to pay. */
export function CreditTermsDialog({
  payerId,
  account,
  onClose,
  onSaved,
}: {
  payerId: string;
  /** Absent when the corporate has no account yet. */
  account?: CreditAccount;
  onClose: () => void;
  onSaved: (account: CreditAccount) => void;
}) {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const digits = currencyDigits(useTenant()?.currency);
  const schema = useMemo(() => termsFormSchema(digits), [digits]);
  const form = useZodForm(schema, {
    limit: account ? typed(account.creditLimitMinor, digits) : '',
    termsDays: account ? String(account.termsDays) : '30',
  });
  const save = useSaveCreditAccount(payerId);
  const refused = refusalKey(save.error);

  const submit = async (values: TermsFormValues) => {
    try {
      onSaved(await save.mutateAsync(toTermsWrite(values, digits, account?.version)));
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={account ? t('credit.terms.editTitle') : t('credit.terms.openTitle')}
      description={t('credit.terms.description')}
      closeLabel={t('close')}
      busy={save.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="credit-terms-form" aria-busy={save.isPending}>
            {save.isPending ? t('saving') : t('save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="credit-terms-form" onSubmit={submit} className="flex flex-col gap-4">
        <TextField<TermsFormValues>
          name="limit"
          label={t('credit.terms.limit')}
          hint={t('credit.terms.limitHint')}
          required
          inputMode="decimal"
          autoComplete="off"
        />
        <TextField<TermsFormValues>
          name="termsDays"
          label={t('credit.terms.days')}
          hint={t('credit.terms.daysHint')}
          required
          inputMode="numeric"
          autoComplete="off"
        />
        {save.error && (
          <p role="alert" className="text-sm text-destructive">
            {refused ? t(refused) : tCommon(errorMessageKey(save.error))}
          </p>
        )}
      </Form>
    </Dialog>
  );
}
