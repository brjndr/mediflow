import { useTranslation } from 'react-i18next';
import { useSession } from '@/app/session';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { useSwitchTenant } from './use-switch-tenant';

/** Shown instead of the app when a user who works at several hospitals has not picked one yet. */
export function HospitalPicker() {
  const { t } = useTranslation();
  const session = useSession();
  // No hospital was open before, so the address the user asked for is still the right one.
  const switchTenant = useSwitchTenant({ returnHome: false });
  const memberships = session?.user.memberships ?? [];

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-4">
      <div className="space-y-2">
        <p className="text-sm font-semibold text-primary">{t('app.name')}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{t('tenancy.pickerTitle')}</h1>
        <p className="text-muted-foreground">{t('tenancy.pickerDescription')}</p>
      </div>
      <ul className="flex flex-col gap-2">
        {memberships.map((membership) => (
          <li key={membership.tenantId}>
            <Button
              className="w-full justify-start"
              variant="outline"
              size="lg"
              disabled={switchTenant.isPending}
              onClick={() => switchTenant.mutate(membership.tenantId)}
            >
              {membership.tenantName}
            </Button>
          </li>
        ))}
      </ul>
      {switchTenant.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t(errorMessageKey(switchTenant.error))}
        </p>
      )}
    </main>
  );
}
