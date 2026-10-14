import { HttpError } from './errors.js';

/**
 * Text a person types that is stored and later printed: a name, a unit, a brand.
 *
 * `PLAIN_TEXT` is the pattern for its schema: no control characters (the database refuses a NUL,
 * which would otherwise be a 500), none of the characters that override the direction of text,
 * which can make one name read as another, and none of the others that print as nothing, with
 * which a second name looks the same as the first (#322): Unicode's default ignorable code
 * points (the soft hyphen, the combining grapheme joiner, the Arabic letter mark, the zero-width
 * space, the direction marks, the word joiner and the invisible operators, the byte order mark,
 * the Hangul fillers, the tag characters and the like) and the interlinear annotation characters
 * (U+FFF9 to U+FFFB). Of the default ignorables, the joiners that Indic scripts need (U+200C,
 * U+200D) and the variation selectors that emoji need (U+FE00 to U+FE0F) are allowed.
 *
 * Unicode's own list is named (`\p{...}`), not copied, so it is the runtime's edition of it. The
 * pattern means this only with the unicode flag, which the validator sets; without it, which is
 * how a schema's patterns are checked to be valid at all, it is still a valid one, as a range
 * written `\u{...}` would not be.
 */
export const PLAIN_TEXT =
  '^(?:[\\u200C\\u200D\\uFE00-\\uFE0F]|(?!\\p{Default_Ignorable_Code_Point})[^\\u0000-\\u001F\\u007F-\\u009F\\uFFF9-\\uFFFB])*$';

/** What `PLAIN_TEXT` refuses besides the control characters: what prints as nothing. */
const INVISIBLE = new RegExp(
  // The joiners and the variation selectors are in the class on purpose: they are what is kept.
  // eslint-disable-next-line no-misleading-character-class
  `(?![\\u200C\\u200D\\uFE00-\\uFE0F])[\\p{Default_Ignorable_Code_Point}\\uFFF9-\\uFFFB]`,
  'gu',
);

/**
 * A search term as it is searched for: a control character (a pasted tab or line break) is a
 * space, and what prints as nothing is gone, so the term finds what the same term without them
 * finds instead of being refused. Absent when nothing is left.
 */
export function searchTerm(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  // eslint-disable-next-line no-control-regex -- the control characters are what is replaced
  const term = tidy(text.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(INVISIBLE, ''));
  return term === '' ? undefined : term;
}

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
  '^(?:[\\u200C\\u200D\\uFE00-\\uFE0F]|(?!\\p{Default_Ignorable_Code_Point})[^\\u0000-\\u0009\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\uFFF9-\\uFFFB])*$';

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
