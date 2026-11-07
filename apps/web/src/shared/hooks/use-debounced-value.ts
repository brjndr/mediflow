import { useEffect, useState } from 'react';

/** How long typing pauses before a search is made. */
export const SEARCH_DEBOUNCE_MS = 300;

/** The value, as it was a moment ago: a search is made when typing pauses. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
