import { useTranslation } from 'react-i18next';
import { useDepartmentOptions } from '@/features/departments';
import { SelectField, TextField, useFieldValue } from '@/shared/ui/form';
import { CODE_MAX, FLOOR_MAX, NAME_MAX } from '../schemas';

/**
 * The fields of a ward, whether it is being added or changed. Inside a form of the kit. The code
 * is asked only when adding: it does not change afterwards.
 */
export function WardFields({
  adding = false,
  known = [],
}: {
  adding?: boolean;
  /** Departments the ward is known to belong to, for their names. */
  known?: { id: string; name: string }[];
}) {
  const { t } = useTranslation('wards');
  const departments = useDepartmentOptions();
  const selected = String(useFieldValue('departmentId') ?? '');
  const offered = departments.data ?? [];
  // The ward's own department stays an option when it has been archived since.
  const extras = known.filter(
    (item, index) =>
      !offered.some((other) => other.id === item.id) &&
      known.findIndex((other) => other.id === item.id) === index,
  );
  const options = [...extras, ...offered].map(({ id, name }) => ({ value: id, label: name }));
  const current = options.find((option) => option.value === selected);
  return (
    <>
      {adding && (
        <TextField
          name="code"
          label={t('form.code')}
          hint={t('form.codeHint')}
          required
          maxLength={CODE_MAX}
          autoComplete="off"
        />
      )}
      <TextField
        name="name"
        label={t('form.name')}
        required
        maxLength={NAME_MAX}
        autoComplete="off"
      />
      <TextField
        name="floor"
        label={t('form.floor')}
        hint={t('form.floorHint')}
        maxLength={FLOOR_MAX}
        autoComplete="off"
      />
      {departments.available && !departments.isError ? (
        <SelectField
          name="departmentId"
          label={t('form.departmentId')}
          hint={t('form.departmentHint')}
          placeholder={t('form.noDepartment')}
          options={options}
        />
      ) : (
        // Without the departments there is nothing to pick from: the ward keeps the one it has.
        <div className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('form.departmentId')}</span>
          <span>{current?.label ?? t('form.noDepartment')}</span>
          <span className="text-xs text-muted-foreground">{t('form.departmentUnavailable')}</span>
        </div>
      )}
    </>
  );
}
