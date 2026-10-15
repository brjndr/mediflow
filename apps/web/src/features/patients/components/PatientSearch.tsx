import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useFeatureFlag, usePermission } from '@/access';
import { useFormatters } from '@/tenancy';
import {
  SEARCH_DEBOUNCE_MS,
  useDebouncedValue,
  usePatientSuggestions,
} from '../hooks/use-patients';
import type { PatientSummary } from '../types';

/**
 * A search box to choose a patient in another feature's screen (whom to book an appointment
 * for): type a name, a phone number or an MRN, and choose from what the server finds. The term
 * goes in the body of a search, never in an address, and nothing is asked for until something
 * is typed.
 *
 * It needs the `patients` switch and `patient:read`: without them the box says so and asks the
 * server for nothing. It works with the keyboard (arrows, Enter, Escape), by touch, and at any
 * width. It tells the screen which patient was chosen and keeps nothing itself.
 */
export function PatientSearch({
  label,
  onSelect,
  describedBy,
  focusOnMount = false,
  required = false,
}: {
  /** Already translated: what the patient is chosen for on this screen. */
  label: string;
  onSelect: (patient: PatientSummary) => void;
  /** The id of the screen's own message for the box (an error), if it shows one. */
  describedBy?: string;
  /** Takes focus when it appears in place of something that had it (a "Change" button). */
  focusOnMount?: boolean;
  /** A patient must be chosen: marked, and said by a screen reader, as a kit field is. */
  required?: boolean;
}) {
  const { t } = useTranslation('patients');
  const format = useFormatters();
  const inputId = useId();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const focusFirst = useRef(focusOnMount);
  useEffect(() => {
    if (focusFirst.current) input.current?.focus();
  }, []);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const typed = useDebouncedValue(text, SEARCH_DEBOUNCE_MS);
  const allowed = usePermission('patient:read');
  const switchedOn = useFeatureFlag('patients');
  const available = allowed && switchedOn;
  const suggestions = usePatientSuggestions(typed, open && available);
  // What is listed belongs to what was typed: while a search is on its way nothing of an
  // earlier one can be chosen by mistake.
  const settled = typed === text && !suggestions.isPlaceholderData;
  const options = suggestions.data ?? [];
  const searching = text.trim() !== '';
  const highlighted = Math.min(active, Math.max(options.length - 1, 0));

  const choose = (patient: PatientSummary) => {
    onSelect(patient);
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
    ? t('picker.failed')
    : !settled || suggestions.isPending
      ? t('picker.loading')
      : options.length === 0
        ? t('picker.none')
        : t('picker.found', { count: options.length });
  const describedByIds =
    [available ? undefined : `${inputId}-unavailable`, describedBy].filter(Boolean).join(' ') ||
    undefined;

  return (
    <div className="relative flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
        {required && (
          <span aria-hidden className="text-destructive">
            {' *'}
          </span>
        )}
      </label>
      <input
        ref={input}
        id={inputId}
        type="search"
        role="combobox"
        aria-expanded={open && searching}
        aria-controls={open && searching ? listId : undefined}
        aria-autocomplete="list"
        aria-required={required || undefined}
        aria-activedescendant={
          open && settled && options.length > 0 ? optionId(highlighted) : undefined
        }
        value={text}
        maxLength={100}
        autoComplete="off"
        disabled={!available}
        aria-describedby={describedByIds}
        placeholder={available ? t('search.placeholder') : ''}
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
      {!available && (
        <p id={`${inputId}-unavailable`} className="text-xs text-muted-foreground">
          {t('picker.unavailable')}
        </p>
      )}
      {open && available && searching && (
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
                  className="flex cursor-pointer flex-wrap items-baseline gap-x-2 px-3 py-2 text-sm aria-selected:bg-accent pointer-coarse:min-h-11 pointer-coarse:items-center"
                >
                  <span className="min-w-0 break-words font-medium">
                    {option.firstName} {option.lastName}
                  </span>
                  {/* The desk tells two patients of one name apart by these. */}
                  <span className="text-xs text-muted-foreground">
                    {t('picker.details', {
                      mrn: option.mrn,
                      dob: format.calendarDate(option.dob),
                    })}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
