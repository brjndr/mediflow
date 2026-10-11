import { useTranslation } from 'react-i18next';
import { isApiError } from '@/shared/api';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useForgotPassword } from '../hooks/use-account-links';
import { forgotPasswordSchema, type ForgotPasswordValues } from '../schemas';
import { AccountPage, BackToSignIn, ErrorLine } from './AccountPage';
import { SignedOutGate } from './SignedOutGate';

/**
 * Asks for a reset link. The answer is the same whether or not the address has an account, and
 * so are the words here: the page never says whether an email was sent.
 */
export function ForgotPasswordPage() {
  return (
    <SignedOutGate>
      <ForgotPassword />
    </SignedOutGate>
  );
}

function ForgotPassword() {
  const { t } = useTranslation();
  const forgot = useForgotPassword();
  const form = useZodForm(forgotPasswordSchema, { email: '' });

  const onSubmit = async ({ email }: ForgotPasswordValues) => {
    try {
      await forgot.mutateAsync(email);
    } catch {
      // The message comes from the mutation's error below.
    }
  };

  if (forgot.isSuccess) {
    return (
      <AccountPage title={t('account.forgotDoneTitle')}>
        <p role="status" className="text-sm">
          {t('account.forgotDoneBody')}
        </p>
        <BackToSignIn />
      </AccountPage>
    );
  }

  return (
    <AccountPage title={t('account.forgotTitle')}>
      <p className="text-sm">{t('account.forgotIntro')}</p>
      {forgot.isError && (
        <ErrorLine>
          {t(isApiError(forgot.error) ? forgot.error.messageKey : 'errors.unknown')}
        </ErrorLine>
      )}
      <Form form={form} onSubmit={onSubmit}>
        <TextField<ForgotPasswordValues>
          name="email"
          label={t('login.email')}
          type="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
        <SubmitButton pending={forgot.isPending}>{t('account.forgotSubmit')}</SubmitButton>
      </Form>
      <BackToSignIn />
    </AccountPage>
  );
}
