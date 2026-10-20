import { useId, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useFeatureFlag, usePermission } from '@/access';
import {
  SEARCH_DEBOUNCE_MS,
  useDebouncedValue,
  useOrderableLabTests,
} from '../hooks/use-lab-tests';
import type { LabTest } from '../types';

/**
 * A search box for a test or panel to order: type words of its code or name, and choose from
 * what the server finds. Archived tests are not offered. The catalog is searched on the server,
 * with the term in the body of the request, and never loaded whole.
 *
 * For any screen that orders a test (a consultation, a ward round). It works with the keyboard
 * (arrows, Enter, Escape), by touch, and at any width. It tells the screen which test was chosen
 * and keeps nothing itself.
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
  const inputId = useId();
  const listId = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const typed = useDebouncedValue(text, SEARCH_DEBOUNCE_MS);
  // The catalog is a module of its own: switched on for the hospital, and open to this person.
  // Without it the box says so and asks the server for nothing.
  const allowed = usePermission('labTest:read');
  const switchedOn = useFeatureFlag('lab_tests');
  const available = allowed && switchedOn;
  const searching = text.trim() !== '';
  const suggestions = useOrderableLabTests(typed, open && available);
  // What is listed belongs to what was typed: while a search is on its way nothing of an
  // earlier one can be chosen by mistake.
  const settled = typed === text && !suggestions.isPlaceholderData;
  const options = searching ? (suggestions.data ?? []) : [];
  const highlighted = Math.min(active, Math.max(options.length - 1, 0));

  const choose = (test: LabTest) => {
    onSelect(test);
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

  // A list is drawn only with options in it: an empty listbox is announced as one.
  const listed = open && settled && options.length > 0;
  const optionId = (index: number) => `${listId}-${index}`;
  const message = !searching
    ? t('picker.typeToSearch')
    : suggestions.isError
      ? t('picker.failed')
      : !settled || suggestions.isPending
        ? t('picker.loading')
        : options.length === 0
          ? t('picker.none')
          : t('picker.found', { count: options.length });
  const described =
    [available ? undefined : `${inputId}-unavailable`, describedBy].filter(Boolean).join(' ') ||
    undefined;

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
        aria-controls={listed ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={listed ? optionId(highlighted) : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={described}
        value={text}
        maxLength={100}
        autoComplete="off"
        disabled={!available}
        placeholder={available ? t('picker.placeholder') : ''}
        onChange={(event) => {
          setText(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        // After a tap on an option has had its turn.
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="h-9 w-full rounded-md border bg-background px-3 text-base outline-none md:text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive pointer-coarse:h-11"
      />
      {!available && (
        <p id={`${inputId}-unavailable`} className="text-xs text-muted-foreground">
          {t('picker.unavailable')}
        </p>
      )}
      {/* Always on the page, so what the search found is announced as it changes. */}
      <p role="status" className="sr-only">
        {open && available ? message : ''}
      </p>
      {open && available && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-md border bg-background shadow-md">
          <p aria-hidden className="px-3 py-2 text-xs text-muted-foreground">
            {message}
          </p>
          {listed && (
            <ul id={listId} role="listbox" aria-label={label} className="max-h-72 overflow-y-auto">
              {options.map((option, index) => (
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
                  className="cursor-pointer break-words px-3 py-2 text-sm aria-selected:bg-accent pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:items-center"
                >
                  {t('picker.option', {
                    code: option.code,
                    name: option.name,
                    kind: t(`kinds.${option.kind}`),
                  })}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
