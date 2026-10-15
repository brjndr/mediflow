import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useRegistry } from '@/registry';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { SystemPage } from '@/shared/ui/system-page';
import { useOpenLink } from './use-open-link';

const KIND = /^[a-z][a-z0-9_]{0,63}$/;
const ID = /^[\w-]{1,128}$/;

/**
 * One page for every link that cannot be opened. It says the same thing whether the record does
 * not exist, belongs to a hospital the user does not work at, or is of a kind the app does not
 * know, so a link cannot be used to find out what exists elsewhere.
 */
function LinkUnavailable() {
  const { t } = useTranslation();
  return (
    <SystemPage
      fullScreen
      title={t('link.unavailableTitle')}
      description={t('link.unavailableDescription')}
      actions={
        <Button asChild variant="outline">
          <Link to="/">{t('nav.backHome')}</Link>
        </Button>
      }
    />
  );
}

/** Anything but a connection or server problem is the server saying no. */
function isRefusal(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.code !== 'network' &&
    error.code !== 'timeout' &&
    error.code !== 'server' &&
    error.code !== 'rate_limited'
  );
}

/**
 * The landing page of a deep link, `/open/<kind>/<id>` (from an email or a notification). It
 * shows nothing of the record: it asks the server to open the link, and only then goes to the
 * record's own screen, at the hospital the server chose.
 */
export function OpenLinkPage() {
  const { t } = useTranslation();
  const { kind = '', id = '' } = useParams();
  const registry = useRegistry();
  const path = KIND.test(kind) && ID.test(id) ? registry.linkPath(kind, id) : null;
  const open = useOpenLink();
  const { mutate } = open;
  const started = useRef(false);

  useEffect(() => {
    // Once per visit, also when effects run twice in development.
    if (path === null || started.current) return;
    started.current = true;
    mutate({ kind, id, path });
  }, [mutate, kind, id, path]);

  if (path === null || (open.isError && isRefusal(open.error))) return <LinkUnavailable />;

  if (open.isError) {
    return (
      <SystemPage
        fullScreen
        alert
        title={t('link.errorTitle')}
        description={t(errorMessageKey(open.error))}
        actions={
          <Button
            onClick={() => mutate({ kind, id, path })}
            aria-disabled={open.isPending || undefined}
          >
            {t('link.retry')}
          </Button>
        }
      />
    );
  }

  return (
    <p
      role="status"
      className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground"
    >
      {t('link.opening')}
    </p>
  );
}
