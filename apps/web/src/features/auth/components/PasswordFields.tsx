import { useTranslation } from 'react-i18next';
import { TextField } from '@/shared/ui/form';
import { MIN_PASSWORD_LENGTH, type SetPasswordValues } from '../schemas';

export function PasswordFields() {
  const { t } = useTranslation();
  return (
    <>
      <TextField<SetPasswordValues>
        name="password"
        label={t('account.newPassword')}
        hint={t('account.passwordHint', { count: MIN_PASSWORD_LENGTH })}
        type="password"
        autoComplete="new-password"
        required
      />
      <TextField<SetPasswordValues>
        name="confirmPassword"
        label={t('account.confirmPassword')}
        type="password"
        autoComplete="new-password"
        required
      />
    </>
  );
}
