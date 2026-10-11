import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { mfaCodeSchema, type MfaCodeValues } from '../schemas';

/**
 * The second step of sign-in, for an account with an authenticator. The code is sent with the
 * email and password the first step already collected, which the page keeps in memory only until
 * this step ends.
 */
export function MfaChallenge({
  pending,
  errorKey,
  onSubmit,
  onCancel,
}: {
  pending: boolean;
  errorKey: string | null;
  onSubmit: (code: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const form = useZodForm(mfaCodeSchema, { code: '' });
  // The page just swapped to this step, so the cursor goes to the field.
  useEffect(() => form.setFocus('code'), [form]);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const submit = async ({ code }: MfaCodeValues) => {
    await onSubmit(code);
    // This step may be gone by now (signed in, or sent back to the first step).
    if (!mounted.current) return;
    // A refused code is not kept.
    form.resetField('code');
    form.setFocus('code');
  };

  return (
    <>
      <p className="text-sm">{t('login.mfaIntro')}</p>
      {errorKey && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {t(errorKey)}
        </p>
      )}
      <Form form={form} onSubmit={submit}>
        <TextField<MfaCodeValues>
          name="code"
          label={t('login.mfaCode')}
          hint={t('login.mfaHint')}
          inputMode="text"
          autoComplete="one-time-code"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
        <SubmitButton pending={pending}>
          {pending ? t('login.submitting') : t('login.mfaSubmit')}
        </SubmitButton>
      </Form>
      <Button type="button" variant="ghost" onClick={onCancel}>
        {t('login.mfaCancel')}
      </Button>
    </>
  );
}
