import { useTranslation } from 'react-i18next';
import { FavouriteDrugList } from '../components/FavouriteDrugList';
import { PrescriptionSetList } from '../components/PrescriptionSetList';

/** Prescription sets and favourite medicines (#485), for `prescriptionSet:read`. */
export default function PrescriptionSets() {
  const { t } = useTranslation('clinical');
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('sets.manage.title')}</h1>
      <PrescriptionSetList />
      <FavouriteDrugList />
    </div>
  );
}
