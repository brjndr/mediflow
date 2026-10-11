import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useSessionEndReason } from '@/app/session';
import { isApiError } from '@/shared/api';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { signInErrorKey, useSignIn } from '../hooks/use-sign-in';
import { loginSchema, type LoginValues } from '../schemas';
import { MfaChallenge } from './MfaChallenge';

/**
 * The one sign-in page for every hospital. Generic and unbranded: which hospital someone belongs
 * to is known only after they sign in.
 */
export function LoginPage() {
  const { t } = useTranslation();
  const form = useZodForm(loginSchema, { email: '', password: '' });
  const signIn = useSignIn();
  // Why the last session here ended, when that is worth saying.
  const ended = useSessionEndReason();
  const endedKey = ended && ended !== 'signed_out' ? `login.ended.${ended}` : null;

  // The email and password wait here, in memory only, while the code is asked for.
  const credentials = useRef<LoginValues | null>(null);
  const [asksForCode, setAsksForCode] = useState(false);
  useEffect(() => () => void (credentials.current = null), []);

  const onSubmit = async (values: LoginValues) => {
    try {
      await signIn.mutateAsync(values);
    } catch (error) {
      // A refused password is not kept.
      form.resetField('password');
      if (isApiError(error) && error.serverCode === 'mfa_required') {
        credentials.current = values;
        signIn.reset();
        setAsksForCode(true);
        return;
      }
      // The message comes from the mutation's error below.
      form.setFocus('password');
    }
  };

  const onCode = async (code: string) => {
    if (!credentials.current) return;
    try {
      await signIn.mutateAsync({ ...credentials.current, code });
      credentials.current = null;
    } catch (error) {
      // A wrong code, or a connection problem, can be tried again from this step. Anything else
      // (too many attempts, a locked or changed account) ends it: the held password is dropped
      // and the first step shows why. The message comes from the mutation's error either way.
      const retryable =
        isApiError(error) &&
        (error.serverCode === 'invalid_mfa_code' ||
          error.code === 'network' ||
          error.code === 'timeout' ||
          error.code === 'server');
      if (!retryable) {
        credentials.current = null;
        setAsksForCode(false);
      }
    }
  };

  const cancelCode = () => {
    credentials.current = null;
    signIn.reset();
    setAsksForCode(false);
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-primary">{t('app.name')}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{t('login.title')}</h1>
      </div>
      {endedKey && !signIn.isError && (
        <p role="status" className="rounded-md border bg-accent px-3 py-2 text-sm">
          {t(endedKey)}
        </p>
      )}
      {asksForCode ? (
        <MfaChallenge
          pending={signIn.isPending}
          errorKey={signIn.isError ? signInErrorKey(signIn.error) : null}
          onSubmit={onCode}
          onCancel={cancelCode}
        />
      ) : (
        <>
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
          <Link to="/forgot-password" className="text-sm font-medium text-primary hover:underline">
            {t('login.forgot')}
          </Link>
        </>
      )}
    </main>
  );
}
