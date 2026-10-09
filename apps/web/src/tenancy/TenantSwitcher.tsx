import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/app/session';
import { errorMessageKey } from '@/shared/api';
import { useTenant } from './tenant-context';
import { useSwitchTenant } from './use-switch-tenant';

/**
 * Header control for the active hospital. Users with one hospital just see its name. A native
 * select keeps it accessible with no extra dependency; F-10 restyles the header.
 */
export function TenantSwitcher() {
  const { t } = useTranslation();
  const id = useId();
  const session = useSession();
  const tenant = useTenant();
  const switchTenant = useSwitchTenant();
  const memberships = session?.user.memberships ?? [];

  if (!tenant) return null;
  if (memberships.length < 2) {
    return <span className="text-sm text-muted-foreground">{tenant.name}</span>;
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="sr-only">
        {t('tenancy.switcherLabel')}
      </label>
      <select
        id={id}
        className="h-8 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        value={tenant.id}
        disabled={switchTenant.isPending}
        onChange={(event) => switchTenant.mutate(event.target.value)}
      >
        {memberships.map((membership) => (
          <option key={membership.tenantId} value={membership.tenantId}>
            {membership.tenantName}
          </option>
        ))}
      </select>
      {switchTenant.isPending && (
        <span role="status" className="text-sm text-muted-foreground">
          {t('tenancy.switching')}
        </span>
      )}
      {switchTenant.isError && (
        <span role="alert" className="text-sm text-destructive">
          {t(errorMessageKey(switchTenant.error))}
        </span>
      )}
    </div>
  );
}
