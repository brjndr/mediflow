/**
 * Text a person types that is stored and later printed: a name, a unit, a brand.
 *
 * The API refuses a control character, the zero-width space and the characters that override the
 * direction of text, which can make one name read as another (`core/http/text.ts` there). A form
 * checks the same, so that a pasted one gets a message of its own (`validation.plain_text`)
 * instead of the general error. The joiners that Indic scripts need (U+200C, U+200D) are allowed.
 *
 * The API may not be imported from, so the two patterns are copies of its own, written as it
 * writes them: its `text.test.ts` fails when they differ.
 */
const TEXT = '^[^\\u0000-\\u001F\\u007F-\\u009F\\u200B\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]*$';
const LINES =
  '^[^\\u0000-\\u0009\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u200B\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]*$';

export const PLAIN_TEXT = new RegExp(TEXT, 'u');

/** The same for text of several lines (a description): line breaks are allowed. */
export const PLAIN_LINES = new RegExp(LINES, 'u');
