/**
 * Rich text is stored and passed around as a small JSON document, never as HTML. This module
 * defines what that document may contain and reduces any input to it.
 *
 * Everything that reaches the server or the screen goes through `sanitizeRichText` first. It is
 * an allowlist: a node type, mark or attribute that is not named here is dropped, whatever it is
 * and wherever it came from (the editor, a paste, the API, an older version of the app). There
 * is no HTML to escape and nothing is ever injected as markup.
 */

export type RichTextMark = 'bold' | 'italic' | 'underline' | 'strike';

export type RichTextNode =
  | { type: 'paragraph'; content?: RichTextNode[] }
  | { type: 'heading'; attrs: { level: 2 | 3 }; content?: RichTextNode[] }
  | { type: 'bulletList'; content: RichTextNode[] }
  | { type: 'orderedList'; content: RichTextNode[] }
  | { type: 'listItem'; content: RichTextNode[] }
  | { type: 'blockquote'; content: RichTextNode[] }
  | { type: 'hardBreak' }
  | { type: 'text'; text: string; marks?: { type: RichTextMark }[] };

export interface RichTextDocument {
  type: 'doc';
  content: RichTextNode[];
}

export const EMPTY_DOCUMENT: RichTextDocument = { type: 'doc', content: [] };

const MARKS = new Set<string>(['bold', 'italic', 'underline', 'strike']);
/** Which node types each container may hold. A type missing here cannot have children. */
const CHILDREN: Record<string, ReadonlySet<string>> = {
  doc: new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote']),
  paragraph: new Set(['text', 'hardBreak']),
  heading: new Set(['text', 'hardBreak']),
  bulletList: new Set(['listItem']),
  orderedList: new Set(['listItem']),
  listItem: new Set(['paragraph', 'bulletList', 'orderedList']),
  blockquote: new Set(['paragraph']),
};
/** Nesting deeper than this is cut off (lists inside lists inside lists...). */
const MAX_DEPTH = 8;
/** Characters of text in one document. A clinical note is far shorter. */
export const MAX_TEXT_LENGTH = 50_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface Budget {
  text: number;
}

function cleanChildren(
  parent: string,
  content: unknown,
  depth: number,
  budget: Budget,
): RichTextNode[] {
  const allowed = CHILDREN[parent];
  if (!allowed || !Array.isArray(content) || depth > MAX_DEPTH) return [];
  const out: RichTextNode[] = [];
  for (const child of content) {
    if (!isObject(child) || typeof child.type !== 'string' || !allowed.has(child.type)) continue;
    const node = cleanNode(child, depth, budget);
    if (node) out.push(node);
  }
  return out;
}

function cleanNode(
  node: Record<string, unknown>,
  depth: number,
  budget: Budget,
): RichTextNode | null {
  switch (node.type) {
    case 'text': {
      if (typeof node.text !== 'string' || node.text === '' || budget.text <= 0) return null;
      const text = node.text.slice(0, budget.text);
      budget.text -= text.length;
      const marks = Array.isArray(node.marks)
        ? [
            ...new Set(
              node.marks
                .map((mark) => (isObject(mark) ? mark.type : undefined))
                .filter(
                  (type): type is RichTextMark => typeof type === 'string' && MARKS.has(type),
                ),
            ),
          ].map((type) => ({ type }))
        : [];
      return marks.length > 0 ? { type: 'text', text, marks } : { type: 'text', text };
    }
    case 'hardBreak':
      return { type: 'hardBreak' };
    case 'paragraph': {
      const content = cleanChildren('paragraph', node.content, depth + 1, budget);
      return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
    }
    case 'heading': {
      const level = isObject(node.attrs) && node.attrs.level === 3 ? 3 : 2;
      const content = cleanChildren('heading', node.content, depth + 1, budget);
      return content.length > 0
        ? { type: 'heading', attrs: { level }, content }
        : { type: 'heading', attrs: { level } };
    }
    case 'bulletList':
    case 'orderedList':
    case 'listItem':
    case 'blockquote': {
      const content = cleanChildren(node.type, node.content, depth + 1, budget);
      // A container with nothing valid inside is dropped, not kept as an empty shell.
      return content.length > 0 ? { type: node.type, content } : null;
    }
    default:
      return null;
  }
}

/** Reduces anything to a valid document. Never throws: unusable input becomes an empty document. */
export function sanitizeRichText(input: unknown): RichTextDocument {
  if (!isObject(input) || input.type !== 'doc') return { type: 'doc', content: [] };
  return {
    type: 'doc',
    content: cleanChildren('doc', input.content, 1, { text: MAX_TEXT_LENGTH }),
  };
}

/** The document's text with no formatting, for previews, search and length checks. */
export function richTextToPlainText(document: RichTextDocument): string {
  const read = (node: RichTextNode): string => {
    if (node.type === 'text') return node.text;
    if (node.type === 'hardBreak') return '\n';
    const inner = ('content' in node ? (node.content ?? []) : []).map(read).join('');
    return node.type === 'listItem' || node.type === 'bulletList' || node.type === 'orderedList'
      ? inner
      : `${inner}\n`;
  };
  return document.content.map(read).join('').replace(/\n+$/, '');
}

export function isEmptyRichText(document: RichTextDocument): boolean {
  return richTextToPlainText(document).trim() === '';
}
