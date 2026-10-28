import { useEffect, useRef, type RefObject } from 'react';
import { focusIfLost } from '@/shared/lib/focus';

/**
 * The keyboard follows a form that opens beside what is shown (a panel to add a room, change a
 * bed), opened from any of several buttons:
 *
 * - when one opens, the button that had focus is remembered and focus goes to the heading marked
 *   `data-panel-heading` inside `container` (give it `tabIndex={-1}`);
 * - when it closes, focus goes back to that button, or to a button of the same name inside
 *   `container` when the form took its place (it comes back as a new element), or else to
 *   `fallback` (a status line that says what was done); unless the person has moved focus.
 *
 * `panel` is whatever says which form is open, or null: a change to another form counts as a
 * new one opening.
 */
export function usePanelFocus(
  panel: unknown,
  container: RefObject<HTMLElement | null>,
  fallback?: RefObject<HTMLElement | null>,
): void {
  // What last had focus inside the container. The button that opens a form may already be gone
  // when the form is drawn (the form takes its place), so it is known from before. Heard on the
  // document: a screen may draw the container only once its record is read, after this mounts.
  const lastFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const box = container.current;
      if (box && event.target instanceof HTMLElement && box.contains(event.target)) {
        lastFocused.current = event.target;
      }
    };
    document.addEventListener('focusin', remember);
    return () => document.removeEventListener('focusin', remember);
  }, [container]);

  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (panel) {
      opener.current = lastFocused.current;
      container.current?.querySelector<HTMLElement>('[data-panel-heading]')?.focus();
    } else if (opener.current) {
      const back = opener.current;
      opener.current = null;
      // A button the form took the place of comes back as a new element: one of the same name.
      const name = back.getAttribute('aria-label') ?? back.textContent;
      const again = back.isConnected
        ? back
        : [...(container.current?.querySelectorAll<HTMLElement>('button, a[href]') ?? [])].find(
            (element) => (element.getAttribute('aria-label') ?? element.textContent) === name,
          );
      focusIfLost(again ?? fallback?.current);
    }
  }, [panel, container, fallback]);
}
