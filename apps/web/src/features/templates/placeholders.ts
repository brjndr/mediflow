import type { RichTextDocument, RichTextNode } from '@/shared/ui/rich-text';

/**
 * The placeholders of a template: plain text in double braces, `{{patient.name}}`, that is
 * filled in when a document is made from the template. Each kind of template knows a fixed set,
 * so a template cannot ask for something no document can give it. Pure functions on the rich
 * text document; the mock backend uses this same file, and the API keeps the same list.
 *
 * A placeholder has to sit in one run of text: one that is half bold is not read as one.
 */

export const TEMPLATE_KINDS = [
  'prescription',
  'clinical_note',
  'consent',
  'discharge_summary',
] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

const COMMON = [
  'patient.name',
  'patient.mrn',
  'patient.age',
  'patient.sex',
  'doctor.name',
  'hospital.name',
  'date.today',
] as const;
const EXTRA = {
  prescription: [],
  clinical_note: [],
  consent: ['procedure.name'],
  discharge_summary: ['admission.date', 'discharge.date'],
} as const satisfies Record<TemplateKind, readonly string[]>;

export type Placeholder = (typeof COMMON)[number] | (typeof EXTRA)[TemplateKind][number];

/** The placeholders a template of this kind may use. */
export const placeholdersFor = (kind: TemplateKind): readonly Placeholder[] => [
  ...COMMON,
  ...EXTRA[kind],
];

/** As it is written in a template. */
export const token = (name: string) => `{{${name}}}`;

const TOKEN = /\{\{([^{}]*)\}\}/g;

function eachText(nodes: readonly RichTextNode[], visit: (text: string) => void): void {
  for (const node of nodes) {
    if (node.type === 'text') visit(node.text);
    else if ('content' in node && node.content) eachText(node.content, visit);
  }
}

/** Every placeholder written in a document, once each, in the order they come. */
export function placeholdersIn(document: RichTextDocument): string[] {
  const found = new Set<string>();
  eachText(document.content, (text) => {
    for (const match of text.matchAll(TOKEN)) found.add((match[1] ?? '').trim());
  });
  return [...found];
}

/** The placeholders in a document that a template of this kind does not know. */
export function unknownPlaceholders(kind: TemplateKind, document: RichTextDocument): string[] {
  const known = new Set<string>(placeholdersFor(kind));
  return placeholdersIn(document).filter((name) => !known.has(name));
}

function fill(node: RichTextNode, values: Readonly<Record<string, string>>): RichTextNode {
  if (node.type === 'text') {
    const text = node.text.replace(TOKEN, (whole, name: string) => values[name.trim()] ?? whole);
    return { ...node, text };
  }
  if ('content' in node && node.content) {
    return { ...node, content: node.content.map((child) => fill(child, values)) } as RichTextNode;
  }
  return node;
}

/**
 * The document with each placeholder replaced by its value. One that has no value is left as it
 * is written, so it is seen and not silently dropped. The values go in as text.
 */
export function fillPlaceholders(
  document: RichTextDocument,
  values: Readonly<Record<string, string>>,
): RichTextDocument {
  return { type: 'doc', content: document.content.map((node) => fill(node, values)) };
}
