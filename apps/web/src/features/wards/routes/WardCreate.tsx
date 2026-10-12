import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessageKey } from '@/shared/api';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { Form, SubmitButton, useZodForm } from '@/shared/ui/form';
import { refusalKey } from '../components/refusal';
import { WardFields } from '../components/WardFields';
import { useCreateWard } from '../hooks/use-wards';
import {
  toWardCreate,
  toWardFormValues,
  wardCreateFormSchema,
  type WardCreateFormValues,
} from '../schemas';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

function NewWard() {
  const { t } = useTranslation('wards');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const create = useCreateWard();
  const form = useZodForm(wardCreateFormSchema, { ...toWardFormValues(), code: '' });
  // Leaving the screen while the answer is on its way does not bring the person back to it.
  const here = useRef(true);
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);

  const submit = async (values: WardCreateFormValues) => {
    try {
      const { ward } = await create.mutateAsync(toWardCreate(values));
      if (!here.current) return;
      await navigate(`/wards/${ward.id}`, { replace: true });
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
        <WardFields adding />
        <div className="flex flex-wrap gap-3">
          <SubmitButton pending={create.isPending}>{t('create.submit')}</SubmitButton>
          <Link to="/wards" className={link}>
            {t('form.cancel')}
          </Link>
        </div>
      </Form>
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function WardCreate() {
  return (
    <DesktopOnly>
      <NewWard />
    </DesktopOnly>
  );
}
