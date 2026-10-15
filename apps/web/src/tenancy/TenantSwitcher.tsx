import { useId, useRef } from 'react';
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
  // Set at once, not on the next render: two quick changes must not send two switches.
  const switching = useRef(false);
  const memberships = session?.user.memberships ?? [];

  if (!tenant) return null;
  if (memberships.length < 2) {
    return <span className="text-base md:text-sm text-muted-foreground">{tenant.name}</span>;
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="sr-only">
        {t('tenancy.switcherLabel')}
      </label>
      <select
        id={id}
        className="h-8 max-w-[45vw] rounded-md border pointer-coarse:h-11 bg-background px-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-disabled:opacity-50"
        value={tenant.id}
        // Not `disabled` while switching: that would drop keyboard focus to the page.
        aria-disabled={switchTenant.isPending || undefined}
        onChange={(event) => {
          if (switching.current) return;
          switching.current = true;
          switchTenant.mutate(event.target.value, {
            onSettled: () => {
              switching.current = false;
            },
          });
        }}
      >
        {memberships.map((membership) => (
          <option key={membership.tenantId} value={membership.tenantId}>
            {membership.tenantName}
          </option>
        ))}
      </select>
      {/* Always there, so a screen reader reads what is put in it; empty, it takes no room. */}
      <span role="status" className="text-sm text-muted-foreground empty:-ml-2">
        {switchTenant.isPending ? (
          t('tenancy.switching')
        ) : switchTenant.isSuccess ? (
          // Said, not shown: the select already shows the hospital.
          <span className="sr-only">{t('tenancy.switched', { name: tenant.name })}</span>
        ) : null}
      </span>
      {switchTenant.isError && (
        <span role="alert" className="text-sm text-destructive">
          {t(errorMessageKey(switchTenant.error))}
        </span>
      )}
    </div>
  );
}
