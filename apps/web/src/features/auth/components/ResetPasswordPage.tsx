import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Form, SubmitButton, useZodForm } from '@/shared/ui/form';
import { isInvalidLink, passwordErrorKey, useResetPassword } from '../hooks/use-account-links';
import { useLinkToken } from '../hooks/use-link-token';
import { setPasswordSchema, type SetPasswordValues } from '../schemas';
import { AccountPage, BackToSignIn, ErrorLine, InvalidLinkNotice } from './AccountPage';
import { PasswordFields } from './PasswordFields';
import { SignedOutGate } from './SignedOutGate';

/**
 * Sets a new password with the link from a reset email. The link can only be judged by sending
 * it, so a spent or expired link shows up on submit and replaces the form with one notice.
 */
export function ResetPasswordPage() {
  return (
    <SignedOutGate>
      <ResetPassword />
    </SignedOutGate>
  );
}

function ResetPassword() {
  const { t } = useTranslation();
  const token = useLinkToken();
  const reset = useResetPassword();
  const form = useZodForm(setPasswordSchema, { password: '', confirmPassword: '' });

  if (token === null || (reset.isError && isInvalidLink(reset.error))) {
    return <InvalidLinkNotice requestNewTo="/forgot-password" />;
  }

  if (reset.isSuccess) {
    return (
      <AccountPage title={t('account.resetDoneTitle')}>
        <p role="status" className="text-sm">
          {t('account.resetDoneBody')}
        </p>
        <Link to="/login" className="text-sm font-medium text-primary hover:underline">
          {t('login.submit')}
        </Link>
      </AccountPage>
    );
  }

  const onSubmit = async ({ password }: SetPasswordValues) => {
    try {
      await reset.mutateAsync({ token, password });
    } catch {
      // A refused password is not kept.
      form.reset();
    }
  };

  return (
    <AccountPage title={t('account.resetTitle')}>
      {reset.isError && <ErrorLine>{t(passwordErrorKey(reset.error))}</ErrorLine>}
      <Form form={form} onSubmit={onSubmit}>
        <PasswordFields />
        <SubmitButton pending={reset.isPending}>{t('account.resetSubmit')}</SubmitButton>
      </Form>
      <BackToSignIn />
    </AccountPage>
  );
}
