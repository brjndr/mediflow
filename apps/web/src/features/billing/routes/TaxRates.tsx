import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { errorMessageKey } from '@/shared/api';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useSetTaxRates, useTaxRates } from '../hooks/use-billing';
import { bpToPercent, percentToBp } from '../lib/tax';
import {
  createTaxRatesSchema,
  TAX_CLASSES,
  type TaxRatesInput,
  type TaxRatesValues,
} from '../schemas';
import type { TaxRates as Rates } from '../types';

const schema = createTaxRatesSchema(percentToBp);

/**
 * The hospital's tax rate for each tax class (`billing/tax-rates`, #119), for `taxRate:manage`.
 * Every service and drug has a class; a bill takes the rate of the class when a draft is saved,
 * and an issued invoice keeps the rates it was made with, so changing a rate never alters one.
 */
export default function TaxRates() {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const rates = useTaxRates();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('tax.heading')}</h1>
        <p className="text-muted-foreground">{t('tax.description')}</p>
        <Link
          to="/billing/invoices"
          className="inline-flex items-center rounded-sm text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11"
        >
          {t('tax.back')}
        </Link>
      </div>
      {rates.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : rates.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(rates.error))}
          </p>
          <Button type="button" variant="outline" onClick={() => void rates.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      ) : (
        <RatesForm rates={rates.data} />
      )}
    </div>
  );
}

function RatesForm({ rates }: { rates: Rates }) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const save = useSetTaxRates();
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const form = useZodForm<TaxRatesInput, TaxRatesValues>(
    schema,
    Object.fromEntries(
      TAX_CLASSES.map((taxClass) => [
        taxClass,
        bpToPercent(rates.items.find((item) => item.taxClass === taxClass)?.rateBp ?? 0),
      ]),
    ) as TaxRatesInput,
  );

  async function submit(values: TaxRatesValues) {
    setMessage(null);
    try {
      await save.mutateAsync(
        TAX_CLASSES.map((taxClass) => ({ taxClass, rateBp: percentToBp(values[taxClass]) ?? 0 })),
      );
      setMessage({ text: t('tax.saved'), failed: false });
    } catch (error) {
      setMessage({ text: tCommon(errorMessageKey(error)), failed: true });
    }
  }

  return (
    <Form form={form} onSubmit={submit}>
      {/* Always on the page, so a saved or refused change is announced. */}
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className={cn(
          'text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 empty:hidden',
          message?.failed && 'text-destructive',
        )}
      >
        {message?.text}
      </p>
      {TAX_CLASSES.map((taxClass) => (
        <TextField<TaxRatesInput>
          key={taxClass}
          name={taxClass}
          label={t(`tax.class.${taxClass}`)}
          hint={t('tax.rateHint')}
          required
          inputMode="decimal"
          autoComplete="off"
        />
      ))}
      <div>
        <SubmitButton pending={save.isPending}>
          {save.isPending ? t('tax.saving') : t('tax.submit')}
        </SubmitButton>
      </div>
    </Form>
  );
}
