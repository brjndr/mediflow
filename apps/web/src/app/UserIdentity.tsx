import { useSession } from './session';

/**
 * Who is signed in. Plain text with the sign-out button beside it for now: it becomes the
 * trigger of a user menu when there is more to put in one (profile arrives with A-06).
 */
export function UserIdentity() {
  const user = useSession()?.user;
  if (!user) return null;
  return (
    <div className="min-w-0 text-right leading-tight">
      <p className="truncate text-sm font-medium">{user.name}</p>
      <p className="hidden truncate text-xs text-muted-foreground sm:block">{user.email}</p>
    </div>
  );
}
