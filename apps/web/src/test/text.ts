// Intl separates some parts (currency and amount, time and am/pm) with a no-break space or a
// narrow no-break space. Built from character codes so this file holds no invisible characters.
const INTL_SPACES = new RegExp(`[${String.fromCharCode(0x00a0, 0x202f)}]`, 'g');

/** Replaces the special spaces Intl emits with ordinary ones, so expectations stay readable. */
export function plainSpaces(text: string | null | undefined): string {
  return (text ?? '').replace(INTL_SPACES, ' ');
}
