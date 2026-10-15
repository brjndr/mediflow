/**
 * Puts focus on `element` when the keyboard has lost its place: focus fell to the page because
 * what had it went away or became disabled (a closed form, a removed row, a button that hid
 * itself). It never takes focus from where the person has moved it since.
 */
export function focusIfLost(element: HTMLElement | null | undefined): void {
  const active = document.activeElement;
  if (active === null || active === document.body) element?.focus();
}
