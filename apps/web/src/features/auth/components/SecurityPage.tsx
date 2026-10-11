import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useSession } from '@/app/session';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
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

/** Saves the codes as a text file the person chooses where to keep. Nothing is stored here. */
function downloadCodes(codes: string[]) {
  const url = URL.createObjectURL(new Blob([codes.join('\n') + '\n'], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'recovery-codes.txt';
  link.click();
  // After the browser has taken the file, not in the same breath as the click.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopy('copied');
    } catch {
      // No clipboard access (an insecure page, or refused): the codes are still on screen.
      setCopy('failed');
    }
  };
  return (
    <>
      <p className="text-sm">{t('security.codesIntro')}</p>
      <ul
        aria-label={t('security.codesLabel')}
        className="grid grid-cols-2 gap-2 rounded-md border bg-muted p-3 font-mono text-sm"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={() => void copyCodes()}>
          {t('security.copy')}
        </Button>
        <Button type="button" variant="outline" onClick={() => downloadCodes(codes)}>
          {t('security.download')}
        </Button>
      </div>
      <p role="status" className="min-h-5 text-sm">
        {copy === 'copied' && t('security.copied')}
        {copy === 'failed' && t('security.copyFailed')}
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        {t('security.codesSaved')}
      </label>
      <Button type="button" disabled={!saved} onClick={onDone}>
        {t('security.done')}
      </Button>
    </>
  );
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
      <p role="status" className="text-sm">
        {t('security.enabled')}
      </p>
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
      {body}
    </div>
  );
}
