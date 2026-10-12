import { useTranslation } from 'react-i18next';
import { CheckboxField, SelectField, TextField } from '@/shared/ui/form';
import { FORMS, NAME_MAX, SCHEDULES, SHORT_MAX, TAX_CLASSES, TYPES } from '../schemas';

/** The fields of an item, whether it is being added or changed. Inside a form of the kit. */
export function DrugFields() {
  const { t } = useTranslation('drugs');
  return (
    <>
      <SelectField
        name="type"
        label={t('form.type')}
        required
        placeholder={t('form.chooseType')}
        options={TYPES.map((value) => ({ value, label: t(`types.${value}`) }))}
      />
      <TextField
        name="genericName"
        label={t('form.genericName')}
        hint={t('form.genericNameHint')}
        required
        maxLength={NAME_MAX}
        autoComplete="off"
      />
      <TextField
        name="brandName"
        label={t('form.brandName')}
        hint={t('form.brandNameHint')}
        maxLength={NAME_MAX}
        autoComplete="off"
      />
      <SelectField
        name="form"
        label={t('form.form')}
        required
        placeholder={t('form.chooseForm')}
        options={FORMS.map((value) => ({ value, label: t(`forms.${value}`) }))}
      />
      <TextField
        name="strength"
        label={t('form.strength')}
        hint={t('form.strengthHint')}
        maxLength={SHORT_MAX}
        autoComplete="off"
      />
      <TextField
        name="unit"
        label={t('form.unit')}
        hint={t('form.unitHint')}
        maxLength={SHORT_MAX}
        autoComplete="off"
      />
      <SelectField
        name="schedule"
        label={t('form.schedule')}
        required
        options={SCHEDULES.map((value) => ({ value, label: t(`schedules.${value}`) }))}
      />
      <CheckboxField
        name="controlled"
        label={t('form.controlled')}
        hint={t('form.controlledHint')}
      />
      <SelectField
        name="taxClass"
        label={t('form.taxClass')}
        required
        placeholder={t('form.chooseTaxClass')}
        options={TAX_CLASSES.map((value) => ({ value, label: t(`taxClasses.${value}`) }))}
      />
      <TextField
        name="reorderLevel"
        label={t('form.reorderLevel')}
        hint={t('form.reorderLevelHint')}
        inputMode="numeric"
        maxLength={7}
        autoComplete="off"
      />
    </>
  );
}
