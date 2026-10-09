import { useSession } from './session';

/**
 * Who is signed in. Shown as plain text for now: it becomes the trigger of the user menu when
 * there is something to put in it (sign-out arrives with the session-lifecycle work, profile
 * with A-06). An empty menu would be invalid for assistive technology.
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
