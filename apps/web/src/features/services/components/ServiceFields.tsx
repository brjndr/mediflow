import { useTranslation } from 'react-i18next';
import { SelectField, TextAreaField, TextField } from '@/shared/ui/form';
import { CATEGORIES, DESCRIPTION_MAX, NAME_MAX, TAX_CLASSES } from '../schemas';

/** The fields a service has whether it is being added or changed. Inside a form of the kit. */
export function ServiceFields() {
  const { t } = useTranslation('services');
  return (
    <>
      <TextField name="name" label={t('form.name')} required maxLength={NAME_MAX} />
      <SelectField
        name="category"
        label={t('form.category')}
        required
        placeholder={t('form.chooseCategory')}
        options={CATEGORIES.map((value) => ({ value, label: t(`categories.${value}`) }))}
      />
      <SelectField
        name="taxClass"
        label={t('form.taxClass')}
        hint={t('form.taxClassHint')}
        required
        placeholder={t('form.chooseTaxClass')}
        options={TAX_CLASSES.map((value) => ({ value, label: t(`taxClasses.${value}`) }))}
      />
      <TextAreaField
        name="description"
        label={t('form.description')}
        hint={t('form.descriptionHint')}
        maxLength={DESCRIPTION_MAX}
        rows={3}
      />
    </>
  );
}
