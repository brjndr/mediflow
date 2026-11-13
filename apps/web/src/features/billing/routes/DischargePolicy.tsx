import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { errorMessageKey } from '@/shared/api';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { Form, SelectField, SubmitButton, useZodForm } from '@/shared/ui/form';
import { useDischargePolicy, useSetDischargePolicy } from '../hooks/use-stay-bill';
import { DISCHARGE_POLICY_MODES, type DischargePolicyMode } from '../stay-bill';

const schema = z.object({ mode: z.enum(DISCHARGE_POLICY_MODES) });
type PolicyInput = z.input<typeof schema>;
type PolicyValues = z.output<typeof schema>;

/**
 * How discharge waits for the bill (`billing/discharge-policy`, DS-04, #167), for `dischargePolicy:manage`:
 * not at all, with a confirmation from the person discharging, or not until it is settled. The
 * admissions screen reads it with the stay's settlement; the server will enforce it (#169).
 */
export default function DischargePolicy() {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const policy = useDischargePolicy();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('dischargePolicy.heading')}</h1>
        <p className="text-muted-foreground">{t('dischargePolicy.description')}</p>
        <Link
          to="/billing/invoices"
          className="inline-flex items-center rounded-sm text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11"
        >
          {t('dischargePolicy.back')}
        </Link>
      </div>
      {policy.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : policy.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(policy.error))}
          </p>
          <Button type="button" variant="outline" onClick={() => void policy.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      ) : (
        <PolicyForm mode={policy.data.mode} />
      )}
    </div>
  );
}

function PolicyForm({ mode }: { mode: DischargePolicyMode }) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const save = useSetDischargePolicy();
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const form = useZodForm<PolicyInput, PolicyValues>(schema, { mode });

  async function submit(values: PolicyValues) {
    setMessage(null);
    try {
      await save.mutateAsync(values.mode);
      setMessage({ text: t('dischargePolicy.saved'), failed: false });
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
      <SelectField<PolicyInput>
        name="mode"
        label={t('dischargePolicy.mode')}
        required
        options={DISCHARGE_POLICY_MODES.map((value) => ({
          value,
          label: t(`dischargePolicy.modes.${value}`),
        }))}
      />
      <div>
        <SubmitButton pending={save.isPending}>
          {save.isPending ? t('dischargePolicy.saving') : t('dischargePolicy.submit')}
        </SubmitButton>
      </div>
    </Form>
  );
}
