import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFeatureFlag, usePermission } from '@/access';
import { ServerSearch, type ServerSearchIdle } from '@/shared/ui/server-search';
import { useFavouriteAccess, useFavouriteDrugs, loadDrug } from '../hooks/use-favourites';
import { useMedicineSuggestions } from '../hooks/use-drugs';
import { useMedicineName } from '../hooks/use-medicine-name';
import type { Drug } from '../types';

/** A row of the list: a found medicine, or a favourite, which is only an id and a name. */
interface Row {
  id: string;
  label: string;
  drug?: Drug;
}

/**
 * A search box for a medicine to prescribe: type words of its generic name or brand, and choose
 * from what the server finds. Archived items are not offered, nor consumables unless the screen
 * asks for them (`includeConsumables`, for stock). The catalog is
 * searched on the server, with the term in the body of the request, and never loaded whole.
 *
 * For any screen that records a medicine (a prescription, a medication order). It works with the
 * keyboard (arrows, Enter, Escape), by touch, and at any width. It tells the screen which item
 * was chosen and keeps nothing itself. Built on `ServerSearch` (`shared/ui`).
 */
export function DrugSearch({
  label,
  onSelect,
  invalid,
  describedBy,
  includeConsumables = false,
  favourites = false,
}: {
  /** Already translated: what the medicine is for on this screen. */
  label: string;
  onSelect: (drug: Drug) => void;
  /** The screen's own error for the field, when it has one. */
  invalid?: boolean;
  describedBy?: string;
  /** Offer consumables too: for a screen about any item kept, such as stock. */
  includeConsumables?: boolean;
  /**
   * Offer the caller's favourite medicines while nothing is typed (#394). For a screen that
   * prescribes; needs `prescriptionSet:read` and the clinical switch, and is left out without.
   */
  favourites?: boolean;
}) {
  const { t } = useTranslation('drugs');
  const nameOf = useMedicineName();
  // The catalog is a module of its own: switched on for the hospital, and open to this person.
  // Without it the box says so and asks the server for nothing.
  const allowed = usePermission('drug:read');
  const switchedOn = useFeatureFlag('drugs');
  const available = allowed && switchedOn;
  const favouriteAccess = useFavouriteAccess();
  const [picking, setPicking] = useState<'idle' | 'busy' | 'failed'>('idle');

  // While nothing is typed, the caller's favourites, when the screen asks for them.
  const useIdle = ({
    open,
    searching,
  }: {
    open: boolean;
    searching: boolean;
  }): ServerSearchIdle<Row> | undefined => {
    const show = favourites && available && favouriteAccess.canRead && !searching;
    const list = useFavouriteDrugs(show && open);
    if (!show) return undefined;
    // A favourite that was archived since cannot be prescribed: it is not offered.
    const options = (list.data?.items ?? [])
      .filter((item) => !item.archived)
      .map((item) => ({ id: item.drugId, label: item.name }));
    const settled = list.isSuccess;
    return {
      options,
      settled,
      heading: t('search.favouritesHeading'),
      message: list.isError
        ? t('search.favouriteFailed')
        : !settled
          ? t('search.favouriteLoading')
          : options.length === 0
            ? t('search.typeToSearch')
            : t('search.favouritesFound', { count: options.length }),
    };
  };

  const useSearch = (typed: string, enabled: boolean) => {
    const query = useMedicineSuggestions(typed, enabled, includeConsumables);
    return {
      data: query.data?.map((drug) => ({ id: drug.id, label: nameOf(drug), drug })),
      isError: query.isError,
      isPending: query.isPending,
      isPlaceholderData: query.isPlaceholderData,
    };
  };

  return (
    <ServerSearch<Row>
      label={label}
      available={available}
      useSearch={useSearch}
      useIdle={useIdle}
      messages={{
        placeholder: t('search.placeholder'),
        unavailable: t('search.unavailable'),
        typeToSearch: t('search.typeToSearch'),
        loading: t('search.loading'),
        failed: t('search.failed'),
        none: () => t('search.none'),
        found: (count) => t('search.found', { count }),
      }}
      optionKey={(row) => row.id}
      renderOption={(row) => row.label}
      notice={picking === 'failed' ? t('search.favouriteChosenFailed') : undefined}
      onType={() => setPicking('idle')}
      onChoose={(row, reset) => {
        const done = (drug: Drug) => {
          onSelect(drug);
          reset();
        };
        if (row.drug) return done(row.drug);
        if (picking === 'busy') return;
        // A favourite is only an id and a name: the medicine itself is read before it is chosen.
        setPicking('busy');
        loadDrug(row.id).then(
          (drug) => {
            setPicking('idle');
            done(drug);
          },
          () => setPicking('failed'),
        );
      }}
      invalid={invalid}
      describedBy={describedBy}
    />
  );
}
