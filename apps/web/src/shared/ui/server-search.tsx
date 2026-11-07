import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/shared/hooks/use-debounced-value';

/** What a search query gives the box: the part of a React Query result it reads. */
export interface ServerSearchResult<T> {
  data: T[] | undefined;
  isError: boolean;
  isPending: boolean;
  isPlaceholderData: boolean;
}

/** What is offered while nothing is typed (a person's favourites), when a screen has any. */
export interface ServerSearchIdle<T> {
  options: T[];
  /** The list is ready to choose from. */
  settled: boolean;
  /** Already translated: the status line, and the heading of the list. */
  message: string;
  heading: string;
}

export interface ServerSearchMessages {
  placeholder: string;
  /** Said under the box when the module is off or not open to this person. */
  unavailable: string;
  /** Said while nothing is typed and nothing is offered. */
  typeToSearch?: string;
  loading: string;
  failed: string;
  none: (searching: boolean) => string;
  found: (count: number, searching: boolean) => string;
}

export interface ServerSearchProps<T> {
  /** Already translated: what the thing is for on this screen. */
  label: string;
  /** False when the module is off or not open to this person: the box says so and asks nothing. */
  available: boolean;
  /**
   * The query, called as a hook on every render with the text once typing has paused and
   * whether the list is open: it should ask the server for nothing while `enabled` is false.
   */
  useSearch: (typed: string, enabled: boolean) => ServerSearchResult<T>;
  /** Called as a hook; gives what to offer while nothing is typed. */
  useIdle?: (state: { open: boolean; searching: boolean }) => ServerSearchIdle<T> | undefined;
  /** Ask the server (and list what it gives) even while nothing is typed, as for favourites. */
  searchOnEmpty?: boolean;
  /** Draw the (empty) listbox too when nothing was found, for a screen whose tests expect it. */
  listWhenEmpty?: boolean;
  messages: ServerSearchMessages;
  optionKey: (option: T) => string;
  renderOption: (option: T) => ReactNode;
  /** An option was chosen; call `reset` once it is taken to clear the box and close the list. */
  onChoose: (option: T, reset: () => void) => void;
  /** A status of the screen's own that takes the place of the search's (a choice that failed). */
  notice?: string;
  /** The person typed: a screen can clear its `notice`. */
  onType?: () => void;
  /** The screen's own error for the field, when it has one. */
  invalid?: boolean;
  describedBy?: string;
  maxLength?: number;
}

/**
 * A search box over a catalog the server searches (a service, a medicine, a code): type words,
 * and choose from what the server finds. The query comes from the screen's own hook, so the term
 * goes in the body of a `POST …/search`, never in an address.
 *
 * It is a combobox worked from the input (arrows wrap, Enter chooses and never submits a form,
 * Escape closes) with `aria-activedescendant`, so an option never takes focus. What is listed
 * belongs to what was typed: while a search is on its way nothing of an earlier one can be
 * chosen. What was found is announced in a status line that is always on the page, and targets
 * are 44 px where the pointer is a finger. It tells the screen what was chosen and keeps nothing.
 */
export function ServerSearch<T>({
  label,
  available,
  useSearch,
  useIdle,
  searchOnEmpty = false,
  listWhenEmpty = false,
  messages,
  optionKey,
  renderOption,
  onChoose,
  notice,
  onType,
  invalid,
  describedBy,
  maxLength = 100,
}: ServerSearchProps<T>) {
  const inputId = useId();
  const listId = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const typed = useDebouncedValue(text, SEARCH_DEBOUNCE_MS);
  const searching = text.trim() !== '';
  const query = useSearch(typed, open && available);
  const idle = useIdle?.({ open, searching });
  const idleShown = idle !== undefined && !searching;
  // What is listed belongs to what was typed: while a search is on its way nothing of an
  // earlier one can be chosen by mistake.
  const searchSettled = typed === text && !query.isPlaceholderData;
  const settled = idleShown ? idle.settled : searchSettled;
  const options: T[] = idleShown
    ? idle.options
    : searching || searchOnEmpty
      ? (query.data ?? [])
      : [];
  const highlighted = Math.min(active, Math.max(options.length - 1, 0));

  const reset = () => {
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
      if (option !== undefined) onChoose(option, reset);
    }
  };

  // A list is drawn only with options in it: an empty listbox is announced as one.
  const listed = open && settled && options.length > 0;
  const drawList = listed || (listWhenEmpty && open);
  const optionId = (index: number) => `${listId}-${index}`;
  const searchMessage = idleShown
    ? idle.message
    : !searching && !searchOnEmpty
      ? (messages.typeToSearch ?? '')
      : query.isError
        ? messages.failed
        : !searchSettled || query.isPending
          ? messages.loading
          : options.length === 0
            ? messages.none(searching)
            : messages.found(options.length, searching);
  const message = notice ?? searchMessage;
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
        // Expanded only while a list is drawn: an open box with nothing in it controls nothing.
        aria-expanded={listed}
        aria-controls={listed ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={listed ? optionId(highlighted) : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={described}
        value={text}
        maxLength={maxLength}
        autoComplete="off"
        disabled={!available}
        placeholder={available ? messages.placeholder : ''}
        onChange={(event) => {
          setText(event.target.value);
          setOpen(true);
          setActive(0);
          onType?.();
        }}
        onFocus={() => setOpen(true)}
        // After a tap on an option has had its turn.
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="h-9 w-full rounded-md border bg-background px-3 text-base outline-none md:text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive pointer-coarse:h-11"
      />
      {!available && (
        <p id={`${inputId}-unavailable`} className="text-xs text-muted-foreground">
          {messages.unavailable}
        </p>
      )}
      {/* Always on the page, so what the search found is announced as it changes. */}
      <p role="status" className="sr-only">
        {open && available ? message : ''}
      </p>
      {open && available && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-md border bg-background shadow-md">
          <p aria-hidden className="px-3 py-2 text-xs text-muted-foreground">
            {listed && idleShown && notice === undefined ? idle.heading : message}
          </p>
          {drawList && (
            <ul
              id={listId}
              role="listbox"
              aria-label={idleShown ? idle.heading : label}
              className="max-h-72 overflow-y-auto"
            >
              {(settled ? options : []).map((option, index) => (
                // The keyboard works the list from the input (arrows and Enter, with
                // aria-activedescendant), as a combobox does: an option never takes focus.
                // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                <li
                  key={optionKey(option)}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === highlighted}
                  // Before the input loses focus, which would close the list under the finger.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onChoose(option, reset)}
                  onMouseEnter={() => setActive(index)}
                  className="cursor-pointer break-words px-3 py-2 text-sm aria-selected:bg-accent pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:items-center"
                >
                  {renderOption(option)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
