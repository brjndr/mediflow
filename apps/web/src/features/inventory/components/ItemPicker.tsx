import { useId, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { DrugSearch, useMedicineName } from '@/features/drugs';
import { Button } from '@/shared/ui/button';

export interface PickedItem {
  id: string;
  name: string;
}

/**
 * An item of the drug and consumable master, chosen with its search (medicines and consumables),
 * or the one chosen with a button to choose another. Focus goes to the search when Change is
 * pressed and to Change once an item is chosen, so it is never left on the page body.
 */
export function ItemPicker({
  label,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  /** Already translated. */
  label: string;
  value: PickedItem | null;
  onChange: (item: PickedItem | null) => void;
  invalid?: boolean;
  describedBy?: string;
}) {
  const { t } = useTranslation('inventory');
  const nameOf = useMedicineName();
  const labelId = useId();
  const box = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  useLayoutEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    box.current?.querySelector<HTMLElement>(value ? 'button' : 'input')?.focus();
  }, [value]);
  const change = (item: PickedItem | null) => {
    moved.current = true;
    onChange(item);
  };

  return (
    <div ref={box}>
      {value ? (
        <div className="flex flex-col gap-1.5">
          <span id={labelId} className="text-sm font-medium">
            {label}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-words text-sm">{value.name}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-describedby={labelId}
              onClick={() => change(null)}
            >
              {t('item.change')}
            </Button>
          </div>
        </div>
      ) : (
        <DrugSearch
          label={label}
          includeConsumables
          invalid={invalid}
          describedBy={describedBy}
          onSelect={(drug) => change({ id: drug.id, name: nameOf(drug) })}
        />
      )}
    </div>
  );
}
