import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessageKey, isApiError } from '@/shared/api';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useTenant } from '@/tenancy';
import { ServiceFields } from '../components/ServiceFields';
import { useCreateService } from '../hooks/use-services';
import {
  CODE_MAX,
  createServiceFormSchema,
  currencyDigits,
  toMinor,
  type CreateServiceFormValues,
} from '../schemas';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

const EMPTY = { code: '', name: '', category: '', taxClass: '', description: '', price: '' };

function NewService() {
  const { t } = useTranslation('services');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const tenant = useTenant();
  const create = useCreateService();
  const digits = currencyDigits(tenant?.currency);
  const schema = useMemo(() => createServiceFormSchema(digits), [digits]);
  const form = useZodForm(schema, EMPTY);

  const submit = async (values: CreateServiceFormValues) => {
    const priceMinor = values.price === '' ? null : toMinor(values.price, digits);
    try {
      const service = await create.mutateAsync({
        code: values.code,
        name: values.name,
        category: values.category,
        taxClass: values.taxClass,
        description: values.description || undefined,
        ...(priceMinor === null ? {} : { priceMinor }),
      });
      // Straight to the new service, where its prices are kept.
      await navigate(`/services/${service.id}`, { replace: true });
    } catch {
      // Shown from the mutation state below.
    }
  };

  const codeTaken = isApiError(create.error) && create.error.serverCode === 'service_code_taken';

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('create.heading')}</h1>
        <p className="text-muted-foreground">{t('create.description')}</p>
      </div>

      {create.isError && (
        <p role="alert" className="text-sm text-destructive">
          {codeTaken ? t('create.codeTaken') : tCommon(errorMessageKey(create.error))}
        </p>
      )}

      <Form form={form} onSubmit={submit} className="flex max-w-xl flex-col gap-4">
        <TextField
          name="code"
          label={t('form.code')}
          hint={t('form.codeHint')}
          required
          maxLength={CODE_MAX}
          autoComplete="off"
        />
        <ServiceFields />
        <TextField
          name="price"
          label={t('form.price', { currency: tenant?.currency ?? '' })}
          hint={t('form.priceHint')}
          inputMode="decimal"
          autoComplete="off"
          maxLength={20}
        />
        <div className="flex flex-wrap gap-3">
          <SubmitButton pending={create.isPending}>{t('create.submit')}</SubmitButton>
          <Link to="/services" className={link}>
            {t('form.cancel')}
          </Link>
        </div>
      </Form>
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function ServiceCreate() {
  return (
    <DesktopOnly>
      <NewService />
    </DesktopOnly>
  );
}
