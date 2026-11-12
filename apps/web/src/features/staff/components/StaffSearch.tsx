import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { ServerSearch } from '@/shared/ui/server-search';
import type { StaffOption } from '../hooks/use-staff-options';
import { useStaffSearch } from '../hooks/use-staff-search';

/**
 * A search box for a member of staff (a duty roster): type part of a name or email address and
 * choose from what the server finds, so it works for a hospital of any size. Only active staff
 * are offered, and only the id and name leave this feature. Needs `staff:read`; without it the
 * box says so and asks nothing. It tells the screen who was chosen and keeps nothing itself.
 */
export function StaffSearch({
  label,
  onSelect,
  invalid,
  describedBy,
}: {
  /** Already translated: what the person is for on this screen. */
  label: string;
  onSelect: (person: StaffOption) => void;
  invalid?: boolean;
  describedBy?: string;
}) {
  const { t } = useTranslation('staff');
  const allowed = usePermission('staff:read');

  return (
    <ServerSearch
      label={label}
      available={allowed}
      useSearch={useStaffSearch}
      messages={{
        placeholder: t('picker.placeholder'),
        unavailable: t('picker.unavailable'),
        typeToSearch: t('picker.typeToSearch'),
        loading: t('picker.loading'),
        failed: t('picker.failed'),
        none: () => t('picker.none'),
        found: (count) => t('picker.found', { count }),
      }}
      optionKey={(option) => option.id}
      renderOption={(option) => option.name}
      onChoose={(option, reset) => {
        onSelect(option);
        reset();
      }}
      invalid={invalid}
      describedBy={describedBy}
    />
  );
}
