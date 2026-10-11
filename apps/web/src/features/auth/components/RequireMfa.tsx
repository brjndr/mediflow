import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '@/app/session';
import { PageSkeleton } from '@/shared/ui/page-skeleton';
import { useTenant } from '@/tenancy';
import { useMfaRequirement } from '../hooks/use-mfa';

export const SECURITY_PATH = '/security';

/**
 * Where a hospital requires an authenticator, someone without one reaches only the security
 * screen until they have set it up. This steers the screens; the server enforces the rule.
 */
export function RequireMfa({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const session = useSession();
  const tenant = useTenant();
  const { pathname } = useLocation();
  const enrolled = session?.user.mfaEnabled ?? true;
  const requirement = useMfaRequirement(tenant?.id ?? '', !enrolled && tenant !== null);

  if (enrolled || tenant === null) return children;
  // Nothing of the app shows while the answer is not known.
  if (requirement.isPending) return <PageSkeleton label={t('app.loading')} />;
  if (requirement.data === true && pathname !== SECURITY_PATH) {
    return <Navigate to={SECURITY_PATH} replace />;
  }
  return children;
}
