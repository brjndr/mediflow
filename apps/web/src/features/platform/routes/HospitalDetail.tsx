import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { PageSkeleton } from '@/shared/ui/page-skeleton';
import { SystemPage } from '@/shared/ui/system-page';
import { HospitalAdminInvites } from '../components/HospitalAdminInvites';
import { HospitalLimits } from '../components/HospitalLimits';
import { HospitalModules } from '../components/HospitalModules';
import { useHospital } from '../hooks/use-hospitals';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

// Default export: route modules are loaded with a dynamic import.
export default function HospitalDetail() {
  const { t } = useTranslation();
  const { hospitalId = '' } = useParams();
  const hospital = useHospital(hospitalId);
  const back = (
    <Link to="/platform/hospitals" className={link}>
      {t('platform.detail.back')}
    </Link>
  );

  if (hospital.isPending) return <PageSkeleton label={t('platform.detail.loading')} />;
  if (hospital.data === undefined) {
    if (isApiError(hospital.error) && hospital.error.code === 'not_found') {
      return (
        <SystemPage
          title={t('platform.detail.notFoundTitle')}
          description={t('platform.detail.notFoundBody')}
          actions={back}
        />
      );
    }
    return (
      <SystemPage
        alert
        title={t('platform.detail.errorTitle')}
        description={t(errorMessageKey(hospital.error))}
        actions={
          <Button variant="outline" onClick={() => void hospital.refetch()}>
            {t('grid.retry')}
          </Button>
        }
      />
    );
  }

  const record = hospital.data;
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
      <div className="space-y-1">
        {back}
        <h1 className="text-2xl font-semibold tracking-tight break-words">{record.name}</h1>
        <p className="text-muted-foreground">
          {record.slug} · {t(`platform.hospitals.status.${record.status}`)}
        </p>
      </div>
      <HospitalModules key={record.id} hospital={record} />
      <HospitalLimits key={record.id} hospital={record} />
      {record.status === 'active' && (
        <HospitalAdminInvites key={record.id} hospitalId={record.id} />
      )}
    </div>
  );
}
