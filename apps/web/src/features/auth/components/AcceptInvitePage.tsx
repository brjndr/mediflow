import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { isApiError } from '@/shared/api';
import { Form, SubmitButton, useZodForm } from '@/shared/ui/form';
import {
  isInvalidLink,
  passwordErrorKey,
  useAcceptInvite,
  useInvitePreview,
} from '../hooks/use-account-links';
import { useLinkToken } from '../hooks/use-link-token';
import { confirmSchema, setPasswordSchema, type SetPasswordValues } from '../schemas';
import { AccountPage, BackToSignIn, ErrorLine, InvalidLinkNotice } from './AccountPage';
import { PasswordFields } from './PasswordFields';
import { SignedOutGate } from './SignedOutGate';

type Accept = ReturnType<typeof useAcceptInvite>;

function SetPasswordForm({ token, accept }: { token: string; accept: Accept }) {
  const { t } = useTranslation();
  const form = useZodForm(setPasswordSchema, { password: '', confirmPassword: '' });
  const onSubmit = async ({ password }: SetPasswordValues) => {
    try {
      await accept.mutateAsync({ token, password });
    } catch {
      // A refused password is not kept.
      form.reset();
    }
  };
  return (
    <Form form={form} onSubmit={onSubmit}>
      <PasswordFields />
      <SubmitButton pending={accept.isPending}>{t('account.inviteSubmit')}</SubmitButton>
    </Form>
  );
}

function ConfirmForm({ token, accept }: { token: string; accept: Accept }) {
  const { t } = useTranslation();
  const form = useZodForm(confirmSchema, {});
  const onSubmit = async () => {
    try {
      await accept.mutateAsync({ token });
    } catch {
      // The error shows from the mutation.
    }
  };
  return (
    <Form form={form} onSubmit={onSubmit}>
      <SubmitButton pending={accept.isPending}>{t('account.inviteSubmit')}</SubmitButton>
    </Form>
  );
}

/**
 * Accepting an invite from an email. Someone new chooses a password; someone who already has an
 * account only confirms. Afterwards they sign in (the server starts no session here). Setting up
 * an authenticator is a separate step (A-02).
 */
export function AcceptInvitePage() {
  return (
    <SignedOutGate>
      <AcceptInvite />
    </SignedOutGate>
  );
}

function AcceptInvite() {
  const { t } = useTranslation();
  const token = useLinkToken();
  const preview = useInvitePreview(token);
  const accept = useAcceptInvite();

  if (token === null || (preview.isError && isInvalidLink(preview.error))) {
    return <InvalidLinkNotice />;
  }
  if (accept.isError && isInvalidLink(accept.error)) return <InvalidLinkNotice />;
  if (preview.isPending) {
    return (
      <AccountPage title={t('account.inviteTitle')}>
        <p role="status" className="text-sm">
          {t('account.loading')}
        </p>
      </AccountPage>
    );
  }
  if (preview.isError) {
    return (
      <AccountPage title={t('account.inviteTitle')}>
        <ErrorLine>
          {t(isApiError(preview.error) ? preview.error.messageKey : 'errors.unknown')}
        </ErrorLine>
        <button
          type="button"
          className="text-left text-sm text-primary hover:underline"
          onClick={() => void preview.refetch()}
        >
          {t('session.retry')}
        </button>
      </AccountPage>
    );
  }

  const { needsPassword, hospitalName, email } = preview.data;
  if (accept.isSuccess) {
    return (
      <AccountPage title={t('account.inviteDoneTitle')}>
        <p role="status" className="text-sm">
          {t('account.inviteDoneBody', { hospital: hospitalName })}
        </p>
        <Link to="/login" className="text-sm font-medium text-primary hover:underline">
          {t('login.submit')}
        </Link>
      </AccountPage>
    );
  }

  return (
    <AccountPage title={t('account.inviteTitle')}>
      <p className="text-sm">{t('account.inviteIntro', { hospital: hospitalName, email })}</p>
      {accept.isError && <ErrorLine>{t(passwordErrorKey(accept.error))}</ErrorLine>}
      {needsPassword ? (
        <SetPasswordForm token={token} accept={accept} />
      ) : (
        <ConfirmForm token={token} accept={accept} />
      )}
      <BackToSignIn />
    </AccountPage>
  );
}
