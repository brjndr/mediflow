import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useSession } from './session';

/** Up to two initials, from the first and last words of a name. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/**
 * Who is signed in, as a link to their own account page. The sign-out button sits beside it. The
 * link is named by the text it shows, after a prefix only a screen reader hears, so a voice
 * command that says what is on screen reaches it (WCAG 2.5.3, Label in Name).
 */
export function UserIdentity({ to = '/profile' }: { to?: string }) {
  const { t } = useTranslation();
  const user = useSession()?.user;
  if (!user) return null;
  return (
    <Link
      to={to}
      className="group flex min-w-0 items-center gap-2 rounded-lg px-1 leading-tight pointer-coarse:min-h-11 pointer-coarse:min-w-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="sr-only">{t('profile.open')} </span>
      <span className="flex min-w-0 flex-col text-right">
        <span className="block truncate text-sm font-medium group-hover:underline">
          {user.name}
        </span>
        <span className="hidden truncate text-xs text-muted-foreground sm:block">{user.email}</span>
      </span>
      {/* Initials in the hospital's colour (#1119); the name beside it is what is read out. */}
      <span
        aria-hidden
        className="hidden size-9 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-xs font-bold text-primary-foreground shadow-button sm:flex"
      >
        {initials(user.name)}
      </span>
    </Link>
  );
}
