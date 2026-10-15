import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession, useSignOut } from '@/app/session';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { AccountPage, ErrorLine } from './AccountPage';

/**
 * Keeps the emailed-link pages for someone who is not signed in. If a session is open here (a
 * shared PC where the last person did not sign out), the link's owner must not end up inside it,
 * so the page first asks to sign that session out, and stays on the same address afterwards.
 */
export function SignedOutGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const session = useSession();
  const signOut = useSignOut({ stayOnPage: true });
  if (!session) return children;
  return (
    <AccountPage title={t('account.signedInTitle')}>
      <p className="text-sm">{t('account.signedInBody', { name: session.user.name })}</p>
      {signOut.isError && (
        <ErrorLine>
          {t('session.signOutFailed', { reason: t(errorMessageKey(signOut.error)) })}
        </ErrorLine>
      )}
      <Button
        type="button"
        aria-disabled={signOut.isPending || undefined}
        onClick={() => signOut.mutate()}
      >
        {t('account.signedInAction')}
      </Button>
    </AccountPage>
  );
}
