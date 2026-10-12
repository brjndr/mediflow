import { useId, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { SEARCH_DEBOUNCE_MS, useCodeSuggestions, useDebouncedValue } from '../hooks/use-codes';
import type { Code, CodeSystem } from '../types';

/**
 * A search box for a diagnosis or procedure code: type a code or words of its title, and choose
 * from what the server finds. Before anything is typed it offers the hospital's favourites.
 * The code set is searched on the server and is never in the bundle.
 *
 * For any screen that records a code (a diagnosis on a consultation, a procedure on an order).
 * It works with the keyboard (arrows, Enter, Escape), by touch, and at any width. It tells the
 * screen which code was chosen and keeps nothing itself.
 */
export function CodeSearch({
  system,
  label,
  onSelect,
}: {
  system: CodeSystem;
  /** Already translated: what the code is for on this screen. */
  label: string;
  onSelect: (code: Code) => void;
}) {
  const { t } = useTranslation('codes');
  const inputId = useId();
  const listId = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const typed = useDebouncedValue(text, SEARCH_DEBOUNCE_MS);
  const suggestions = useCodeSuggestions(system, typed, open);
  // What is listed belongs to what was typed: while a search is on its way nothing of an
  // earlier one can be chosen by mistake.
  const settled = typed === text && !suggestions.isPlaceholderData;
  const options = suggestions.data ?? [];
  const searching = text.trim() !== '';
  const highlighted = Math.min(active, Math.max(options.length - 1, 0));

  const choose = (code: Code) => {
    onSelect(code);
    setText('');
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
    if (event.key === 'Enter' && open) {
      // Never the form's submit while the list is open.
      event.preventDefault();
      const option = settled ? options[highlighted] : undefined;
      if (option) choose(option);
    }
  };

  const optionId = (index: number) => `${listId}-${index}`;
  const message = suggestions.isError
    ? t('search.failed')
    : !settled || suggestions.isPending
      ? t('search.loading')
      : options.length === 0
        ? t(searching ? 'search.none' : 'search.noFavourites')
        : t(searching ? 'search.found' : 'search.favourites', { count: options.length });

  return (
    <div className="relative flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && settled && options.length > 0 ? optionId(highlighted) : undefined
        }
        value={text}
        maxLength={100}
        autoComplete="off"
        placeholder={t('search.placeholder')}
        onChange={(event) => {
          setText(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        // After a tap on an option has had its turn.
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="h-9 w-full rounded-md border bg-background px-3 text-base outline-none md:text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:h-11"
      />
      {open && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-md border bg-background shadow-md">
          <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
            {message}
          </p>
          <ul id={listId} role="listbox" aria-label={label} className="max-h-72 overflow-y-auto">
            {settled &&
              options.map((option, index) => (
                // The keyboard works the list from the input (arrows and Enter, with
                // aria-activedescendant), as a combobox does: an option never takes focus.
                // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                <li
                  key={option.id}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === highlighted}
                  // Before the input loses focus, which would close the list under the finger.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(option)}
                  onMouseEnter={() => setActive(index)}
                  className="flex cursor-pointer items-baseline gap-2 px-3 py-2 text-sm aria-selected:bg-accent pointer-coarse:min-h-11 pointer-coarse:items-center"
                >
                  <span className="shrink-0 font-medium">{option.code}</span>
                  <span className="min-w-0 break-words">{option.title}</span>
                  {option.favourite && (
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {t('favourite')}
                    </span>
                  )}
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
