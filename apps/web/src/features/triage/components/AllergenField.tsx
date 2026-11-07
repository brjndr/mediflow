import { useId, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useFieldError, useFieldFocusRef, useFieldValue, useSetFieldValue } from '@/shared/ui/form';
import { useAllergenSearch } from '../hooks/use-triage';
import { SUBSTANCE_MAX } from '../schemas';
import type { Allergen } from '../types';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/shared/hooks/use-debounced-value';

/**
 * The substance of one allergy (row `index` of the form's `rows`): typed as free text, or chosen
 * from what the server finds in the allergen catalog and the hospital's own medicines (#380). A
 * choice records which one it was, so prescribing and the pharmacy can check it against a drug
 * class and not only against words; typing again after a choice goes back to free text.
 *
 * It is a combobox worked with the keyboard (arrows, Enter, Escape) and by touch. The term is
 * searched on the server and never loaded whole.
 */
export function AllergenField({ index }: { index: number }) {
  const { t } = useTranslation('triage');
  const name = (field: string) => `rows.${index}.${field}`;
  const set = useSetFieldValue();
  const text = String(useFieldValue(name('substance')) ?? '');
  const allergenId = useFieldValue(name('allergenId'));
  const drugId = useFieldValue(name('drugId'));
  const coded = Boolean(allergenId || drugId);
  const message = useFieldError(name('substance'));
  const focusRef = useFieldFocusRef(name('substance'));
  const inputId = useId();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Set while the text is the name of a choice: the kind to tell the person.
  const [kind, setKind] = useState<Allergen['kind'] | null>(null);
  const typed = useDebouncedValue(text, SEARCH_DEBOUNCE_MS);
  const searching = open && !coded && text.trim() !== '';
  const suggestions = useAllergenSearch(typed, searching);
  // What is listed belongs to what was typed: nothing of an earlier search can be chosen by
  // mistake while a new one is on its way.
  const settled = typed === text && !suggestions.isPlaceholderData;
  const options = searching ? (suggestions.data ?? []) : [];
  const highlighted = Math.min(active, Math.max(options.length - 1, 0));
  const listed = searching && settled && options.length > 0;
  const optionId = (position: number) => `${listId}-${position}`;
  const keyOf = (option: Allergen) => `${option.kind}:${option.allergenId ?? option.drugId}`;

  const choose = (option: Allergen) => {
    set(name('substance'), option.name);
    set(name('allergenId'), option.allergenId ?? '');
    set(name('drugId'), option.drugId ?? '');
    setKind(option.kind);
    setOpen(false);
    setActive(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      if (open) event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) return setOpen(true);
      if (options.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((highlighted + step + options.length) % options.length);
      return;
    }
    if (event.key === 'Enter' && open && searching) {
      // Never the form's submit while the list is open.
      event.preventDefault();
      const option = settled ? options[highlighted] : undefined;
      if (option) choose(option);
    }
  };

  const status = !searching
    ? ''
    : suggestions.isError
      ? t('allergies.picker.failed')
      : !settled || suggestions.isPending
        ? t('allergies.picker.loading')
        : options.length === 0
          ? t('allergies.picker.none')
          : t('allergies.picker.found', { count: options.length });
  const hint = coded
    ? t('allergies.picker.recognised', {
        kind: kind ? t(`allergies.kinds.${kind}`) : t('allergies.kinds.chosen'),
      })
    : text.trim() === ''
      ? t('allergies.picker.typeToSearch')
      : t('allergies.picker.freeText');
  const describedBy = [`${inputId}-hint`, message ? `${inputId}-error` : undefined]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={focusRef} className="relative flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium">
        {t('allergies.substance')}
        <span aria-hidden className="text-destructive">
          {' *'}
        </span>
      </label>
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={listed}
        aria-controls={listed ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={listed ? optionId(highlighted) : undefined}
        aria-invalid={message ? true : undefined}
        aria-describedby={describedBy}
        aria-required
        value={text}
        maxLength={SUBSTANCE_MAX}
        autoComplete="off"
        onChange={(event) => {
          set(name('substance'), event.target.value);
          // Typing over a choice is free text again.
          if (coded) {
            set(name('allergenId'), '');
            set(name('drugId'), '');
            setKind(null);
          }
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="h-9 w-full rounded-md border bg-background px-3 text-base outline-none md:text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive pointer-coarse:h-11"
      />
      <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
      {message && (
        <p id={`${inputId}-error`} role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
      {/* Always on the page, so what the search found is announced as it changes. */}
      <p role="status" className="sr-only">
        {status}
      </p>
      {listed && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('allergies.substance')}
          className="absolute left-0 right-0 top-full z-10 mt-1 max-h-72 overflow-y-auto rounded-md border bg-background shadow-md"
        >
          {options.map((option, position) => (
            // The keyboard works the list from the input (arrows and Enter, with
            // aria-activedescendant), as a combobox does: an option never takes focus.
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events
            <li
              key={keyOf(option)}
              id={optionId(position)}
              role="option"
              aria-selected={position === highlighted}
              // Before the input loses focus, which would close the list under the finger.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option)}
              onMouseEnter={() => setActive(position)}
              className="cursor-pointer break-words px-3 py-2 text-sm aria-selected:bg-accent pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:items-center"
            >
              {t('allergies.picker.option', {
                name: option.name,
                kind: t(`allergies.kinds.${option.kind}`),
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
