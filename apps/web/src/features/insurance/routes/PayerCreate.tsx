import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessageKey } from '@/shared/api';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { PayerFields } from '../components/PayerFields';
import { refusalKey } from '../components/refusal';
import { useCreatePayer } from '../hooks/use-payers';
import {
  PAYER_KINDS,
  payerCreateFormSchema,
  toPayerCreate,
  toPayerFormValues,
  type PayerCreateFormValues,
} from '../schemas';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

function NewPayer() {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const create = useCreatePayer();
  const form = useZodForm(payerCreateFormSchema, {
    ...toPayerFormValues(),
    kind: 'insurer',
    code: '',
  });
  // Leaving the screen while the answer is on its way does not bring the person back to it.
  const here = useRef(true);
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);

  const submit = async (values: PayerCreateFormValues) => {
    try {
      const payer = await create.mutateAsync(toPayerCreate(values));
      if (!here.current) return;
      await navigate(`/insurance/${payer.id}`, { replace: true });
    } catch {
      // Shown from the mutation state below.
    }
  };

  const refused = refusalKey(create.error);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('create.heading')}</h1>
        <p className="text-muted-foreground">{t('create.description')}</p>
      </div>

      {create.isError && (
        <p role="alert" className="text-sm text-destructive">
          {refused ? t(refused) : tCommon(errorMessageKey(create.error))}
        </p>
      )}

      <Form form={form} onSubmit={submit} className="flex max-w-xl flex-col gap-4">
        <SelectField<PayerCreateFormValues>
          name="kind"
          label={t('form.kind')}
          required
          options={PAYER_KINDS.map((value) => ({ value, label: t(`kind.${value}`) }))}
        />
        <TextField<PayerCreateFormValues>
          name="code"
          label={t('form.code')}
          hint={t('form.codeHint')}
          required
          maxLength={20}
          autoComplete="off"
        />
        <PayerFields />
        <div className="flex flex-wrap gap-3">
          <SubmitButton pending={create.isPending}>{t('create.submit')}</SubmitButton>
          <Link to="/insurance" className={link}>
            {t('cancel')}
          </Link>
        </div>
      </Form>
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function PayerCreate() {
  return (
    <DesktopOnly>
      <NewPayer />
    </DesktopOnly>
  );
}
