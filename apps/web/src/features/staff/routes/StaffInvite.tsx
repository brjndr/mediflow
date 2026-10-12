import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { BulkInvite } from '../components/BulkInvite';
import { InviteForm } from '../components/InviteForm';
import { useStaffRoles } from '../hooks/use-staff';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function StaffInvite() {
  const { t } = useTranslation('staff');
  const { t: tCommon } = useTranslation();
  const roles = useStaffRoles();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6">
      <div className="space-y-1">
        <Link to="/staff" className={link}>
          {t('backToList')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{t('inviteOne.pageHeading')}</h1>
        <p className="text-muted-foreground">{t('inviteOne.pageDescription')}</p>
      </div>

      {roles.isPending && (
        <div role="status">
          <span className="sr-only">{tCommon('app.loading')}</span>
          <Skeleton className="h-40 w-full" />
        </div>
      )}
      {roles.isError && roles.data === undefined && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border p-4 text-sm">
          <span className="flex-1">{t('inviteOne.rolesFailed')}</span>
          <Button size="sm" variant="outline" onClick={() => void roles.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      )}
      {roles.data && (
        <>
          <InviteForm roles={roles.data} />
          <BulkInvite roles={roles.data} />
        </>
      )}
    </div>
  );
}
