import { Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { useFavouriteAccess, useFavouriteDrugs, useToggleFavourite } from '../hooks/use-favourites';

/**
 * A star on a medicine: add it to the caller's favourites, which `DrugSearch` offers before
 * anything is typed, or take it off. A toggle button (`aria-pressed`) named after the medicine.
 * Shown only to someone who may keep favourites; says nothing while the list is not known.
 */
export function FavouriteToggle({ drugId, name }: { drugId: string; name: string }) {
  const { t } = useTranslation('drugs');
  const { canManage } = useFavouriteAccess();
  const favourites = useFavouriteDrugs(canManage);
  const toggle = useToggleFavourite();
  if (!canManage || !favourites.data) return null;
  const starred = favourites.data.items.some((item) => item.drugId === drugId);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-pressed={starred}
        aria-disabled={toggle.isPending || undefined}
        aria-label={t(starred ? 'favourites.remove' : 'favourites.add', { name })}
        onClick={() => {
          if (!toggle.isPending) toggle.mutate({ drugId, starred: !starred });
        }}
      >
        <Star aria-hidden className={starred ? 'size-4 fill-current' : 'size-4'} />
      </Button>
      <span role="status" className="sr-only">
        {toggle.isError
          ? t('favourites.failed')
          : toggle.isSuccess
            ? t(starred ? 'favourites.added' : 'favourites.removed', { name })
            : ''}
      </span>
    </>
  );
}
