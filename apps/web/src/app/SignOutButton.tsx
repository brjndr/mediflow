import { LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { useSignOut } from './session';

/** Ends the session. If the server cannot be reached the user stays signed in and is told so. */
export function SignOutButton() {
  const { t } = useTranslation();
  const signOut = useSignOut();
  return (
    <div className="flex items-center gap-2">
      {signOut.isError && (
        <p role="alert" className="max-w-48 text-xs text-destructive">
          {t('session.signOutFailed', { reason: t(errorMessageKey(signOut.error)) })}
        </p>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => signOut.mutate()}
        disabled={signOut.isPending}
        aria-busy={signOut.isPending}
      >
        <LogOut aria-hidden="true" className="size-4" />
        <span className="sr-only sm:not-sr-only">{t('session.signOut')}</span>
      </Button>
    </div>
  );
}
