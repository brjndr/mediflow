import { HttpError } from './errors.js';

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

/**
 * The same, refused (400) when it is longer than `max` characters once tidied. A schema checks
 * the length of what was sent, and a few letters become two characters in the normal form
 * (Devanagari U+0958 to U+095F among them): without this the database's own check would refuse
 * the text as a 500. Counted in characters, as the database counts.
 */
export function tidyWithin(text: string, max: number): string {
  const tidied = tidy(text);
  if ([...tidied].length > max) {
    throw new HttpError(400, 'validation_failed', 'A text is too long once it is normalised');
  }
  return tidied;
}

/** Optional text is absent, never empty. */
export const tidyOptional = (text: string | undefined, max: number): string | null =>
  text === undefined ? null : tidyWithin(text, max) || null;

/**
 * `PLAIN_TEXT` for text of several lines (a description): the same, with line breaks allowed.
 */
export const PLAIN_LINES =
  '^[^\\u0000-\\u0009\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u200B\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]*$';

/**
 * Text of several lines as it is stored: each line tidied, one kind of line break, at most one
 * empty line between two paragraphs and none at the ends.
 */
export const tidyLines = (text: string): string =>
  text
    .split(/\r\n|\r|\n/)
    .map(tidy)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Optional text of several lines: absent, never empty, and refused (400) when too long. */
export function tidyLinesOptional(text: string | undefined, max: number): string | null {
  if (text === undefined) return null;
  const tidied = tidyLines(text);
  if ([...tidied].length > max) {
    throw new HttpError(400, 'validation_failed', 'A text is too long once it is normalised');
  }
  return tidied || null;
}
