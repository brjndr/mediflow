import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useSession } from './session';

/** Who is signed in, as a link to their own account page. The sign-out button sits beside it. */
export function UserIdentity() {
  const { t } = useTranslation();
  const user = useSession()?.user;
  if (!user) return null;
  return (
    <Link
      to="/profile"
      aria-label={t('profile.open', { name: user.name })}
      className="flex min-w-0 flex-col justify-center rounded-md px-1 text-right leading-tight pointer-coarse:min-h-11 pointer-coarse:min-w-11 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="block truncate text-sm font-medium">{user.name}</span>
      <span className="hidden truncate text-xs text-muted-foreground sm:block">{user.email}</span>
    </Link>
  );
}
