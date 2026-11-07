import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '@/app/session';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { ManageAuthenticator } from './ManageAuthenticator';
import { RecoveryCodes } from './RecoveryCodes';
import { useConfirmMfa, useEnrollMfa, useRefreshSession } from '../hooks/use-mfa';
import {
  mfaCodeSchema,
  mfaPasswordSchema,
  type MfaCodeValues,
  type MfaPasswordValues,
} from '../schemas';

// The QR code library loads with this screen only.
const QrCode = lazy(() => import('./QrCode'));

function ErrorLine({ messageKey }: { messageKey: string }) {
  const { t } = useTranslation();
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
    >
      {t(messageKey)}
    </p>
  );
}

function enrollErrorKey(error: unknown): string {
  if (isApiError(error)) {
    if (error.serverCode === 'invalid_password') return 'security.wrongPassword';
    if (error.serverCode === 'mfa_already_enabled') return 'security.alreadyOn';
  }
  return errorMessageKey(error);
}

/**
 * Setting up an authenticator for the signed-in user: scan the code (or type the secret), prove
 * it works with a code, then keep the recovery codes. The secret and the recovery codes live only
 * in this screen's mutation results (`gcTime: 0`): never in storage, the address or any log, and
 * gone when the screen closes.
 */
export function SecurityPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const session = useSession();
  const refreshSession = useRefreshSession();
  const enroll = useEnrollMfa();
  const confirm = useConfirmMfa();
  const form = useZodForm(mfaCodeSchema, { code: '' });
  const passwordForm = useZodForm(mfaPasswordSchema, { password: '' });
  // Kept in the router's state, not here: the page may be rebuilt while the session reloads.
  const location = useLocation();
  const removed =
    (location.state as { authenticatorOff?: boolean } | null)?.authenticatorOff === true;

  const onStart = async ({ password }: MfaPasswordValues) => {
    try {
      await enroll.mutateAsync(password);
    } catch {
      // The message comes from the mutation's error below.
    }
    // The password is not kept, whether or not it was right.
    passwordForm.resetField('password');
  };

  const onConfirm = async ({ code }: MfaCodeValues) => {
    try {
      await confirm.mutateAsync(code);
    } catch {
      // The message comes from the mutation's error below. A refused code is not kept.
      form.resetField('code');
      form.setFocus('code');
      return;
    }
    // The secret has done its job: drop it while the recovery codes are on screen. The session is
    // reloaded now, so it shows the authenticator as on before anyone leaves this screen.
    enroll.reset();
    await refreshSession();
  };

  const onDone = () => {
    confirm.reset();
    void navigate('/');
  };

  let body;
  if (confirm.isSuccess) {
    body = <RecoveryCodes codes={confirm.data} onDone={onDone} />;
  } else if (enroll.isSuccess) {
    const { secret, otpauthUri } = enroll.data;
    body = (
      <>
        <p className="text-sm">{t('security.scan')}</p>
        <Suspense fallback={<div className="size-48" aria-hidden />}>
          <QrCode value={otpauthUri} label={t('security.qrLabel')} />
        </Suspense>
        <p className="text-sm">
          {t('security.manual')} <code className="font-mono">{secret}</code>
        </p>
        {confirm.isError && (
          <ErrorLine
            messageKey={
              isApiError(confirm.error) && confirm.error.serverCode === 'invalid_mfa_code'
                ? 'security.invalidCode'
                : errorMessageKey(confirm.error)
            }
          />
        )}
        <Form form={form} onSubmit={onConfirm}>
          <TextField<MfaCodeValues>
            name="code"
            label={t('security.codeLabel')}
            inputMode="numeric"
            autoComplete="one-time-code"
            spellCheck={false}
            required
          />
          <SubmitButton pending={confirm.isPending}>{t('security.confirm')}</SubmitButton>
        </Form>
      </>
    );
  } else if (session?.user.mfaEnabled) {
    body = (
      <ManageAuthenticator
        onDisabled={() => void navigate('.', { replace: true, state: { authenticatorOff: true } })}
      />
    );
  } else {
    body = (
      <>
        <p className="text-sm">{t('security.intro')}</p>
        {enroll.isError && <ErrorLine messageKey={enrollErrorKey(enroll.error)} />}
        <Form form={passwordForm} onSubmit={onStart}>
          <TextField<MfaPasswordValues>
            name="password"
            label={t('login.password')}
            hint={t('security.passwordHint')}
            type="password"
            autoComplete="current-password"
            required
          />
          <SubmitButton pending={enroll.isPending}>{t('security.setUp')}</SubmitButton>
        </Form>
      </>
    );
  }

  return (
    <div className="flex max-w-md flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t('security.title')}</h1>
      {/* Always on the page, so turning the authenticator off is announced. */}
      <p role="status" className="min-h-5 text-sm">
        {removed && !session?.user.mfaEnabled && t('security.turnedOff')}
      </p>
      {body}
    </div>
  );
}
