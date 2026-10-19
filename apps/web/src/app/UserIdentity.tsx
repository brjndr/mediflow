import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useSession } from './session';

/**
 * Who is signed in, as a link to their own account page. The sign-out button sits beside it. The
 * link is named by the text it shows, after a prefix only a screen reader hears, so a voice
 * command that says what is on screen reaches it (WCAG 2.5.3, Label in Name).
 */
export function UserIdentity() {
  const { t } = useTranslation();
  const user = useSession()?.user;
  if (!user) return null;
  return (
    <Link
      to="/profile"
      className="flex min-w-0 flex-col justify-center rounded-md px-1 text-right leading-tight pointer-coarse:min-h-11 pointer-coarse:min-w-11 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="sr-only">{t('profile.open')} </span>
      <span className="block truncate text-sm font-medium">{user.name}</span>
      <span className="hidden truncate text-xs text-muted-foreground sm:block">{user.email}</span>
    </Link>
  );
}
