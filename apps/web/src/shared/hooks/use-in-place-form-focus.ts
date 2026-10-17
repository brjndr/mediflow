import { useEffect, useRef, type RefObject } from 'react';
import { focusIfLost } from '@/shared/lib/focus';

/**
 * The keyboard follows a form that opens and closes in place of what was shown (an Edit form
 * over a record's details), since the button that opened it goes away and focus would fall to
 * the page:
 *
 * - when it opens, to `heading` (give it `tabIndex={-1}`): the section is named, and Tab goes on
 *   into the form, whose own fields may still be drawn again as their options arrive;
 * - when it closes, back to the button marked `data-opens="edit"` inside `box`, unless the person
 *   has moved focus somewhere else meanwhile.
 */
export function useInPlaceFormFocus(
  open: boolean,
  box: RefObject<HTMLElement | null>,
  heading: RefObject<HTMLElement | null>,
): void {
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      heading.current?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      focusIfLost(box.current?.querySelector<HTMLElement>('[data-opens="edit"]'));
    }
  }, [open, box, heading]);
}
