import { useTranslation } from 'react-i18next';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { signInErrorKey, useSignIn } from '../hooks/use-sign-in';
import { loginSchema, type LoginValues } from '../schemas';

/**
 * The one sign-in page for every hospital. Generic and unbranded: which hospital someone belongs
 * to is known only after they sign in.
 */
export function LoginPage() {
  const { t } = useTranslation();
  const form = useZodForm(loginSchema, { email: '', password: '' });
  const signIn = useSignIn();

  const onSubmit = async (values: LoginValues) => {
    try {
      await signIn.mutateAsync(values);
    } catch {
      // The message comes from the mutation's error below. A refused password is not kept.
      form.resetField('password');
      form.setFocus('password');
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-primary">{t('app.name')}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{t('login.title')}</h1>
      </div>
      {signIn.isError && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {t(signInErrorKey(signIn.error))}
        </p>
      )}
      <Form form={form} onSubmit={onSubmit}>
        <TextField<LoginValues>
          name="email"
          label={t('login.email')}
          type="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
        <TextField<LoginValues>
          name="password"
          label={t('login.password')}
          type="password"
          autoComplete="current-password"
          required
        />
        <SubmitButton pending={signIn.isPending}>
          {signIn.isPending ? t('login.submitting') : t('login.submit')}
        </SubmitButton>
      </Form>
    </main>
  );
}
