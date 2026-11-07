import { useTranslation } from 'react-i18next';
import { useFeatureFlag, usePermission } from '@/access';
import { ServerSearch } from '@/shared/ui/server-search';
import type { ServiceOption } from '../hooks/use-service-options';
import { useOrderableServices } from '../hooks/use-services';
import type { ServiceCategory } from '../types';

/**
 * A search box for a service, of one category when given, to order (an imaging study, a procedure): type words
 * of its code or name, and choose from what the server finds. Archived services are not offered,
 * and only the id, code and name are given: a price is the price catalog's to show. The catalog
 * is searched on the server, with the term in the body of the request, and never loaded whole.
 *
 * For any screen that orders a service (a consultation, a ward round). It works with the keyboard
 * (arrows, Enter, Escape), by touch, and at any width. It tells the screen which service was
 * chosen and keeps nothing itself. Built on `ServerSearch` (`shared/ui`).
 */
export function ServiceSearch({
  category,
  label,
  onSelect,
  invalid,
  describedBy,
}: {
  /** Only services of this category are found; without one, every category is searched. */
  category?: ServiceCategory;
  /** Already translated: what the service is for on this screen. */
  label: string;
  onSelect: (service: ServiceOption) => void;
  /** The screen's own error for the field, when it has one. */
  invalid?: boolean;
  describedBy?: string;
}) {
  const { t } = useTranslation('services');
  // The catalog is a module of its own: switched on for the hospital, and open to this person.
  // Without it the box says so and asks the server for nothing.
  const allowed = usePermission('service:read');
  const switchedOn = useFeatureFlag('services');

  const useSearch = (typed: string, enabled: boolean) =>
    useOrderableServices(typed, category, enabled);

  return (
    <ServerSearch
      label={label}
      available={allowed && switchedOn}
      useSearch={useSearch}
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
      renderOption={(option) => t('picker.option', { code: option.code, name: option.name })}
      onChoose={(option, reset) => {
        onSelect(option);
        reset();
      }}
      invalid={invalid}
      describedBy={describedBy}
    />
  );
}
