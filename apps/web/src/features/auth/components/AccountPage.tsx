import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

/** The frame of the pages people reach from an email: generic and unbranded, like sign-in. */
export function AccountPage({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-primary">{t('app.name')}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      </div>
      {children}
    </main>
  );
}

export function BackToSignIn() {
  const { t } = useTranslation();
  return (
    <Link
      to="/login"
      className="text-sm font-medium text-primary underline-offset-4 hover:underline"
    >
      {t('account.backToSignIn')}
    </Link>
  );
}

export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
    >
      {children}
    </p>
  );
}

/** Missing, expired, used or wrong: the same words, so the page reveals nothing about the link. */
export function InvalidLinkNotice({ requestNewTo }: { requestNewTo?: string }) {
  const { t } = useTranslation();
  return (
    <AccountPage title={t('account.invalidLinkTitle')}>
      <p className="text-sm">{t('account.invalidLinkBody')}</p>
      <div className="flex flex-col gap-2">
        {requestNewTo && (
          <Link to={requestNewTo} className="text-sm font-medium text-primary hover:underline">
            {t('account.requestNewLink')}
          </Link>
        )}
        <BackToSignIn />
      </div>
    </AccountPage>
  );
}
