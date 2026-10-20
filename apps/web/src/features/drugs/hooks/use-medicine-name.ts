import { useTranslation } from 'react-i18next';
import type { Drug } from '../types';

/** How a medicine reads in a list or a prescription: generic name, strength and form, brand. */
export function useMedicineName() {
  const { t } = useTranslation('drugs');
  return (drug: Pick<Drug, 'genericName' | 'strength' | 'form' | 'brandName'>) =>
    t(drug.brandName ? 'search.nameWithBrand' : 'search.name', {
      name: [drug.genericName, drug.strength].filter(Boolean).join(' '),
      form: t(`forms.${drug.form}`),
      brand: drug.brandName,
    });
}
