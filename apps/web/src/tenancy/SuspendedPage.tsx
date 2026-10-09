import { useTranslation } from 'react-i18next';
import { SystemPage } from '@/shared/ui/system-page';
import { useTenant } from './tenant-context';
import { TenantSwitcher } from './TenantSwitcher';

/**
 * Replaces the whole app while the active hospital is suspended: no screen of a suspended
 * hospital is reachable. A user who also works elsewhere can switch from here.
 */
export function SuspendedPage() {
  const { t } = useTranslation();
  const tenant = useTenant();
  return (
    <SystemPage
      fullScreen
      title={t('tenancy.suspendedTitle', { name: tenant?.name })}
      description={t('tenancy.suspendedDescription')}
      actions={<TenantSwitcher />}
    />
  );
}
