import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessageKey, isApiError } from '@/shared/api';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { Form, SubmitButton, useZodForm } from '@/shared/ui/form';
import { LabTestFields } from '../components/LabTestFields';
import { useCreateLabTest } from '../hooks/use-lab-tests';
import {
  labTestCreateFormSchema,
  toCreate,
  toFormValues,
  type LabTestCreateFormValues,
} from '../schemas';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

function NewLabTest() {
  const { t } = useTranslation('lab_tests');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const create = useCreateLabTest();
  const form = useZodForm(labTestCreateFormSchema, { ...toFormValues(), code: '' });
  // Leaving the screen while the answer is on its way does not bring the person back to it.
  const here = useRef(true);
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);

  const submit = async (values: LabTestCreateFormValues) => {
    try {
      const test = await create.mutateAsync(toCreate(values));
      if (!here.current) return;
      await navigate(`/lab-tests/${test.id}`, { replace: true });
    } catch {
      // Shown from the mutation state below.
    }
  };

  const taken = isApiError(create.error) && create.error.serverCode === 'lab_test_code_taken';

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('create.heading')}</h1>
        <p className="text-muted-foreground">{t('create.description')}</p>
      </div>

      {create.isError && (
        <p role="alert" className="text-sm text-destructive">
          {taken ? t('create.codeTaken') : tCommon(errorMessageKey(create.error))}
        </p>
      )}

      <Form form={form} onSubmit={submit} className="flex max-w-xl flex-col gap-4">
        <LabTestFields adding />
        <div className="flex flex-wrap gap-3">
          <SubmitButton pending={create.isPending}>{t('create.submit')}</SubmitButton>
          <Link to="/lab-tests" className={link}>
            {t('form.cancel')}
          </Link>
        </div>
      </Form>
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function LabTestCreate() {
  return (
    <DesktopOnly>
      <NewLabTest />
    </DesktopOnly>
  );
}
