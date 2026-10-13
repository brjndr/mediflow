/**
 * Text a person types that is stored and later printed: a name, a unit, a brand.
 *
 * `PLAIN_TEXT` is the pattern for its schema: no control characters (the database refuses a NUL,
 * which would otherwise be a 500), no zero-width space, and none of the characters that override
 * the direction of text, which can make one name read as another. The joiners that Indic scripts
 * need (U+200C, U+200D) are allowed.
 */
export const PLAIN_TEXT =
  '^[^\\u0000-\\u001F\\u007F-\\u009F\\u200B\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]*$';

/**
 * Text as it is stored: in one normal form, so that the same letters typed two ways are the same
 * text, with runs of spaces made one and none at the ends.
 */
export const tidy = (text: string): string => text.normalize('NFC').replace(/\s+/g, ' ').trim();

/** Optional text is absent, never empty. */
export const tidyOptional = (text: string | undefined): string | null =>
  text === undefined ? null : tidy(text) || null;
