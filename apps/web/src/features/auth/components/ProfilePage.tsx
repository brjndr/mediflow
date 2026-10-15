import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useFeatureFlag } from '@/access';
import { useSession } from '@/app/session';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useFormatters, useTenant } from '@/tenancy';
import type { AccountSession } from '../api';
import { passwordErrorKey } from '../hooks/use-account-links';
import { MFA_FEATURE } from '../hooks/use-mfa';
import { useAccountSessions, useChangePassword, useRevokeSession } from '../hooks/use-profile';
import { changePasswordSchema, type ChangePasswordValues } from '../schemas';
import { ErrorLine } from './AccountPage';
import { PasswordFields } from './PasswordFields';

const sectionTitle = 'text-lg font-semibold tracking-tight';

function changeErrorKey(error: unknown): string {
  if (isApiError(error) && error.serverCode === 'invalid_password') return 'security.wrongPassword';
  return passwordErrorKey(error);
}

function ChangePassword({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const change = useChangePassword(tenantId);
  const form = useZodForm(changePasswordSchema, {
    currentPassword: '',
    password: '',
    confirmPassword: '',
  });

  // What the last attempt came to: done, or the translation key of why not.
  const [outcome, setOutcome] = useState<{ ok: true } | { ok: false; messageKey: string } | null>(
    null,
  );

  const onSubmit = async ({ currentPassword, password }: ChangePasswordValues) => {
    setOutcome(null);
    try {
      await change.mutateAsync({ currentPassword, newPassword: password });
      setOutcome({ ok: true });
    } catch (error) {
      setOutcome({ ok: false, messageKey: changeErrorKey(error) });
    }
    // Neither password is kept, whether or not the change went through: not in the form, and
    // not in the mutation, which would otherwise hold them for as long as this page is open.
    form.reset();
    change.reset();
  };

  return (
    <section aria-labelledby="profile-password" className="flex max-w-md flex-col gap-4">
      <h2 id="profile-password" className={sectionTitle}>
        {t('profile.passwordTitle')}
      </h2>
      {outcome?.ok === false && <ErrorLine>{t(outcome.messageKey)}</ErrorLine>}
      {outcome?.ok && (
        <p role="status" className="text-sm">
          {t('profile.passwordChanged')}
        </p>
      )}
      <Form form={form} onSubmit={onSubmit}>
        <TextField<ChangePasswordValues>
          name="currentPassword"
          label={t('profile.currentPassword')}
          type="password"
          autoComplete="current-password"
          required
        />
        <PasswordFields />
        <SubmitButton pending={change.isPending}>{t('account.resetSubmit')}</SubmitButton>
      </Form>
    </section>
  );
}

function SessionRow({ session, tenantId }: { session: AccountSession; tenantId: string }) {
  const { t } = useTranslation();
  const format = useFormatters();
  const revoke = useRevokeSession(tenantId);
  return (
    <li className="flex items-start justify-between gap-4 rounded-md border p-3">
      <div className="min-w-0 text-sm">
        <p className="truncate font-medium">
          {session.userAgent ?? t('profile.unknownDevice')}
          {session.current && (
            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal">
              {t('profile.thisDevice')}
            </span>
          )}
        </p>
        <p className="text-muted-foreground">
          {t('profile.sessionTimes', {
            signedIn: format.dateTime(session.createdAt),
            lastActive: format.dateTime(session.lastSeenAt),
          })}
        </p>
        {revoke.isError && (
          <p role="alert" className="text-destructive">
            {t(errorMessageKey(revoke.error))}
          </p>
        )}
      </div>
      {!session.current && (
        <Button
          type="button"
          variant="outline"
          aria-disabled={revoke.isPending || undefined}
          onClick={() => revoke.mutate(session.id)}
        >
          {t('profile.revoke')}
        </Button>
      )}
    </li>
  );
}

function Sessions({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const sessions = useAccountSessions(tenantId);

  let body;
  if (sessions.isPending) {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        {t('profile.sessionsLoading')}
      </p>
    );
  } else if (sessions.isError) {
    body = (
      <>
        <ErrorLine>{t(errorMessageKey(sessions.error))}</ErrorLine>
        <Button type="button" variant="outline" onClick={() => void sessions.refetch()}>
          {t('session.retry')}
        </Button>
      </>
    );
  } else if (sessions.data.length === 0) {
    body = <p className="text-sm text-muted-foreground">{t('profile.sessionsEmpty')}</p>;
  } else {
    body = (
      <ul aria-labelledby="profile-sessions" className="flex flex-col gap-2">
        {sessions.data.map((session) => (
          <SessionRow key={session.id} session={session} tenantId={tenantId} />
        ))}
      </ul>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 id="profile-sessions" className={sectionTitle}>
        {t('profile.sessionsTitle')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('profile.sessionsIntro')}</p>
      {body}
    </section>
  );
}

/**
 * The signed-in person's own account: who they are, their authenticator, their password and the
 * browsers they are signed in on. Everything here is about the user, never about a hospital's
 * data, so it needs no permission beyond being signed in.
 */
export function ProfilePage() {
  const { t } = useTranslation();
  const session = useSession();
  const tenant = useTenant();
  const mfaAvailable = useFeatureFlag(MFA_FEATURE);
  if (!session || !tenant) return null;
  const { user } = session;

  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <h1 className="text-2xl font-semibold tracking-tight">{t('profile.title')}</h1>

      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t('profile.name')}</dt>
        <dd>{user.name}</dd>
        <dt className="text-muted-foreground">{t('login.email')}</dt>
        <dd>{user.email}</dd>
      </dl>

      {/* Nothing about an authenticator where the hospital has it switched off, unless the person
          already has one (set up at another hospital): sign-in still asks them for a code. */}
      {(mfaAvailable || user.mfaEnabled) && (
        <section aria-labelledby="profile-security" className="flex flex-col gap-2">
          <h2 id="profile-security" className={sectionTitle}>
            {t('security.title')}
          </h2>
          <p className="text-sm">
            {t(user.mfaEnabled ? 'security.enabled' : 'profile.authenticatorOff')}
          </p>
          {!user.mfaEnabled && (
            <Link to="/security" className="text-sm font-medium text-primary hover:underline">
              {t('security.setUp')}
            </Link>
          )}
        </section>
      )}

      <ChangePassword tenantId={tenant.id} />
      <Sessions tenantId={tenant.id} />
    </div>
  );
}
