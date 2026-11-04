import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { errorMessageKey } from '@/shared/api';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useDiscountSettings, useSetDiscountSettings } from '../hooks/use-billing';
import { bpToPercent, percentToBp } from '../lib/tax';
import {
  createDiscountLimitSchema,
  type DiscountLimitInput,
  type DiscountLimitValues,
} from '../schemas';

const schema = createDiscountLimitSchema(percentToBp);

/**
 * The most a bill may be discounted without approval (`billing/discount-limit`, #116), for
 * `discount:manage`: a share of the bill before tax. A discount above it waits for someone other
 * than the person who gave it; the limit applies when a draft is next saved.
 */
export default function DiscountLimit() {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const settings = useDiscountSettings();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('discount.limit.heading')}</h1>
        <p className="text-muted-foreground">{t('discount.limit.description')}</p>
        <Link
          to="/billing/invoices"
          className="inline-flex items-center rounded-sm text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11"
        >
          {t('discount.limit.back')}
        </Link>
      </div>
      {settings.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : settings.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(settings.error))}
          </p>
          <Button type="button" variant="outline" onClick={() => void settings.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      ) : (
        <LimitForm limitBp={settings.data.limitBp} />
      )}
    </div>
  );
}

function LimitForm({ limitBp }: { limitBp: number }) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const save = useSetDiscountSettings();
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const form = useZodForm<DiscountLimitInput, DiscountLimitValues>(schema, {
    limit: bpToPercent(limitBp),
  });

  async function submit(values: DiscountLimitValues) {
    setMessage(null);
    try {
      await save.mutateAsync(percentToBp(values.limit) ?? 0);
      setMessage({ text: t('discount.limit.saved'), failed: false });
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
      <TextField<DiscountLimitInput>
        name="limit"
        label={t('discount.limit.label')}
        hint={t('discount.limit.hint')}
        required
        inputMode="decimal"
        autoComplete="off"
      />
      <div>
        <SubmitButton pending={save.isPending}>
          {save.isPending ? t('discount.limit.saving') : t('discount.limit.submit')}
        </SubmitButton>
      </div>
    </Form>
  );
}
