import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isEmptyRichText,
  MAX_TEXT_LENGTH,
  richTextToPlainText,
  sanitizeRichText,
  type RichTextDocument,
} from '../../core/http/rich-text.js';
import {
  fillPlaceholders,
  placeholdersFor,
  placeholdersIn,
  unknownPlaceholders,
} from './placeholders.js';

/**
 * The rich text document and the placeholders of a template are the web app's rules, and the API
 * may not import from it: it holds a copy of each file. These tests fail when a copy differs from
 * its original, and repeat the web app's own cases for both.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const WEB = '../../../../web/src';

const doc = (...lines: string[]): RichTextDocument => ({
  type: 'doc',
  content: lines.map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
});

describe('the copies of the web app’s rules', () => {
  it('the rich text document is the same file', () => {
    expect(read('../../core/http/rich-text.ts')).toBe(
      read(`${WEB}/shared/ui/rich-text/document.ts`),
    );
  });

  it('the placeholders are the same file, but for where the document type comes from', () => {
    const withoutImport = (text: string) => text.slice(text.indexOf('\n'));
    const [ours, theirs] = [
      read('./placeholders.ts'),
      read(`${WEB}/features/templates/placeholders.ts`),
    ];
    expect(ours.split('\n')[0]).toContain("from '../../core/http/rich-text.js'");
    expect(theirs.split('\n')[0]).toContain("from '@/shared/ui/rich-text'");
    expect(withoutImport(ours)).toBe(withoutImport(theirs));
  });
});

describe('placeholders', () => {
  it('are found in the text, known by kind, and filled in as text', () => {
    const body = doc(
      'Dear {{ patient.name }}, see {{doctor.name}}.',
      '{{patient.name}} {{made.up}}',
    );

    expect(placeholdersIn(body)).toEqual(['patient.name', 'doctor.name', 'made.up']);
    expect(unknownPlaceholders('prescription', body)).toEqual(['made.up']);
    expect(placeholdersFor('discharge_summary')).toContain('discharge.date');
    expect(placeholdersFor('prescription')).not.toContain('discharge.date');

    const filled = fillPlaceholders(body, { 'patient.name': 'A <b>B</b>', 'doctor.name': 'Dr C' });
    // A value is text, whatever it holds; a placeholder with no value stays to be seen.
    expect(filled).toEqual(doc('Dear A <b>B</b>, see Dr C.', 'A <b>B</b> {{made.up}}'));
    // The template itself is not changed.
    expect(placeholdersIn(body)).toHaveLength(3);
    // What was filled in is not read again, and what is left unfilled can be named.
    const twice = fillPlaceholders(doc('{{patient.name}}'), {
      'patient.name': '{{doctor.name}}',
      'doctor.name': 'Dr C',
    });
    expect(twice).toEqual(doc('{{doctor.name}}'));
    expect(placeholdersIn(filled)).toEqual(['made.up']);
    // Only a value that was given is used: never something every object has.
    const odd = doc('{{constructor}} {{toString}} {{__proto__}} {{hasOwnProperty}}');
    expect(fillPlaceholders(odd, { 'patient.name': 'A' })).toEqual(odd);
  });

  it('are read only within one run of text', () => {
    const split = sanitizeRichText({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '{{made.' },
            { type: 'text', text: 'up}}', marks: [{ type: 'bold' }] },
          ],
        },
      ],
    });
    expect(placeholdersIn(split)).toEqual([]);
  });
});

describe('a rich text document', () => {
  it('is reduced to what a document may hold, whatever is sent', () => {
    const cleaned = sanitizeRichText({
      type: 'doc',
      onload: 'x',
      content: [
        { type: 'script', content: [{ type: 'text', text: 'alert(1)' }] },
        {
          type: 'paragraph',
          attrs: { style: 'color:red' },
          content: [
            {
              type: 'text',
              text: '<b>kept as text</b>',
              marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'javascript:1' } }],
            },
            { type: 'image', attrs: { src: 'x' } },
          ],
        },
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        { type: 'bulletList', content: [{ type: 'paragraph' }] },
      ],
    });
    expect(cleaned).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '<b>kept as text</b>', marks: [{ type: 'bold' }] }],
        },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
      ],
    });
    for (const unusable of [null, 'text', 7, [], { type: 'paragraph' }, { type: 'doc' }]) {
      expect(sanitizeRichText(unusable)).toEqual({ type: 'doc', content: [] });
    }
  });

  it('holds a bounded amount of text, and knows when it holds none', () => {
    const long = sanitizeRichText(doc('x'.repeat(MAX_TEXT_LENGTH + 10), 'more'));
    expect(richTextToPlainText(long)).toHaveLength(MAX_TEXT_LENGTH);
    expect(isEmptyRichText(sanitizeRichText(doc('  ', '')))).toBe(true);
    expect(isEmptyRichText(doc('a'))).toBe(false);
  });
});
