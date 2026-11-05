import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { errorMessageKey, isApiError } from '@/shared/api';
import { HospitalWizard } from '../components/HospitalWizard';
import { useCreateHospital } from '../hooks/use-hospitals';
import { toCreateBody } from '../schemas';

// Default export: route modules are loaded with a dynamic import.
export default function HospitalCreate() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const create = useCreateHospital();
  const slugTaken = isApiError(create.error) && create.error.serverCode === 'slug_taken';

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('platform.create.title')}</h1>
        <p className="text-muted-foreground">{t('platform.create.description')}</p>
      </div>
      <HospitalWizard
        pending={create.isPending}
        slugTaken={slugTaken}
        error={create.isError && !slugTaken ? t(errorMessageKey(create.error)) : undefined}
        onSubmit={async (values) => {
          try {
            const hospital = await create.mutateAsync(toCreateBody(values));
            // The list says what happened; the name is shown, never put in the address.
            await navigate('/platform/hospitals', { state: { created: hospital.name } });
          } catch {
            // Shown by the wizard from the mutation's error.
          }
        }}
        onCancel={() => void navigate('/platform/hospitals')}
      />
    </div>
  );
}
