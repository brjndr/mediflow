/**
 * Text a person types that is stored and later printed: a name, a unit, a brand.
 *
 * The API refuses a control character and everything that prints as nothing (Unicode's default
 * ignorable code points: the zero-width space, the soft hyphen, the direction marks and
 * overrides, the word joiner, the tag characters and the like), with which one name can read as
 * another (`core/http/text.ts` there says more). A form checks the same, so that a pasted one
 * gets a message of its own (`validation.plain_text`) instead of the general error. The joiners
 * that Indic scripts need (U+200C, U+200D) and the variation selectors of emoji are allowed.
 *
 * The API may not be imported from, so the two patterns are copies of its own, written as it
 * writes them: its `text.test.ts` fails when they differ.
 */
const TEXT =
  '^(?:[\\u200C\\u200D\\uFE00-\\uFE0F]|(?!\\p{Default_Ignorable_Code_Point})[^\\u0000-\\u001F\\u007F-\\u009F\\uFFF9-\\uFFFB])*$';
const LINES =
  '^(?:[\\u200C\\u200D\\uFE00-\\uFE0F]|(?!\\p{Default_Ignorable_Code_Point})[^\\u0000-\\u0009\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\uFFF9-\\uFFFB])*$';

// The joiners and the variation selectors are in the class on purpose: they are what is allowed.
// eslint-disable-next-line no-misleading-character-class
export const PLAIN_TEXT = new RegExp(TEXT, 'u');

/** The same for text of several lines (a description): line breaks are allowed. */
// eslint-disable-next-line no-misleading-character-class
export const PLAIN_LINES = new RegExp(LINES, 'u');
