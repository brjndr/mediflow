import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFeatureFlag, usePermission } from '@/access';
import { useFavouriteDrugs, useToggleFavourite } from '@/features/drugs';
import { errorMessageKey } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';

/**
 * The caller's favourite medicines, each with a button to take it off (#485). Starring stays on
 * the prescription form and the drug catalog; this list is where a favourite that is no longer
 * wanted, or whose medicine was archived, is removed without finding the medicine again.
 */
export function FavouriteDrugList() {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  const switchedOn = useFeatureFlag('clinical');
  const canRead = usePermission('prescriptionSet:read') && switchedOn;
  const canManage = usePermission('prescriptionSet:manage') && canRead;
  const favourites = useFavouriteDrugs(canRead);
  const toggle = useToggleFavourite();
  const [message, setMessage] = useState('');
  const status = useRef<HTMLParagraphElement>(null);
  if (!canRead) return null;
  const items = favourites.data?.items ?? [];

  const remove = (drugId: string, name: string) => {
    if (toggle.isPending) return;
    toggle.mutate(
      { drugId, starred: false },
      {
        onSuccess: () => {
          setMessage(t('favourites.removed', { name }));
          requestAnimationFrame(() => focusIfLost(status.current));
        },
        onError: () => setMessage(t('favourites.failed')),
      },
    );
  };

  return (
    <section aria-labelledby="favourites-heading" className="flex flex-col gap-3">
      <h2 id="favourites-heading" className="text-lg font-semibold">
        {t('favourites.heading')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('favourites.intro')}</p>
      <p
        ref={status}
        role="status"
        tabIndex={-1}
        className="text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {message}
      </p>
      {favourites.isPending ? (
        <p className="text-sm text-muted-foreground">{t('favourites.loading')}</p>
      ) : favourites.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(favourites.error))}
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('favourites.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li
              key={item.drugId}
              className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
            >
              <span className="min-w-0 break-words">
                {item.archived ? t('favourites.archived', { name: item.name }) : item.name}
              </span>
              {canManage && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-disabled={toggle.isPending || undefined}
                  aria-label={t('favourites.removeNamed', { name: item.name })}
                  onClick={() => remove(item.drugId, item.name)}
                >
                  {t('sets.manage.remove')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
