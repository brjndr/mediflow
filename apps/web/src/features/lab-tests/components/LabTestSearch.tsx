import { useTranslation } from 'react-i18next';
import { useFeatureFlag, usePermission } from '@/access';
import { ServerSearch } from '@/shared/ui/server-search';
import { useOrderableLabTests } from '../hooks/use-lab-tests';
import type { LabTest } from '../types';

/**
 * A search box for a test or panel to order: type words of its code or name, and choose from
 * what the server finds. Archived tests are not offered. The catalog is searched on the server,
 * with the term in the body of the request, and never loaded whole.
 *
 * For any screen that orders a test (a consultation, a ward round). It works with the keyboard
 * (arrows, Enter, Escape), by touch, and at any width. It tells the screen which test was chosen
 * and keeps nothing itself. Built on `ServerSearch` (`shared/ui`).
 */
export function LabTestSearch({
  label,
  onSelect,
  invalid,
  describedBy,
}: {
  /** Already translated: what the test is for on this screen. */
  label: string;
  onSelect: (test: LabTest) => void;
  /** The screen's own error for the field, when it has one. */
  invalid?: boolean;
  describedBy?: string;
}) {
  const { t } = useTranslation('lab_tests');
  // The catalog is a module of its own: switched on for the hospital, and open to this person.
  // Without it the box says so and asks the server for nothing.
  const allowed = usePermission('labTest:read');
  const switchedOn = useFeatureFlag('lab_tests');

  return (
    <ServerSearch
      label={label}
      available={allowed && switchedOn}
      useSearch={useOrderableLabTests}
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
      renderOption={(option) =>
        t('picker.option', {
          code: option.code,
          name: option.name,
          kind: t(`kinds.${option.kind}`),
        })
      }
      onChoose={(option, reset) => {
        onSelect(option);
        reset();
      }}
      invalid={invalid}
      describedBy={describedBy}
    />
  );
}
