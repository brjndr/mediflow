import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import {
  isEmptyRichText,
  MAX_TEXT_LENGTH,
  RichTextEditor,
  richTextToPlainText,
  RichTextView,
  sanitizeRichText,
  type RichTextDocument,
} from '.';

const text = (value: string, ...marks: string[]) => ({
  type: 'text',
  text: value,
  ...(marks.length > 0 ? { marks: marks.map((type) => ({ type })) } : {}),
});
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content });
const doc = (...content: unknown[]) => ({ type: 'doc', content });

const note: RichTextDocument = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Assessment' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Stable. ' },
        { type: 'text', text: 'Review', marks: [{ type: 'bold' }, { type: 'italic' }] },
        { type: 'hardBreak' },
        { type: 'text', text: 'in two weeks.' },
      ],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First' }] }],
        },
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second' }] }],
        },
      ],
    },
  ],
};

describe('sanitizeRichText', () => {
  it('keeps a valid document exactly as it is', () => {
    expect(sanitizeRichText(note)).toEqual(note);
    expect(sanitizeRichText(JSON.parse(JSON.stringify(note)))).toEqual(note);
  });

  it.each([
    ['null', null],
    ['a string of HTML', '<p>hello</p><script>alert(1)</script>'],
    ['an array', [paragraph(text('x'))]],
    ['an object that is not a document', { type: 'paragraph' }],
    ['a document with no content', { type: 'doc' }],
  ])('reduces %s to an empty document', (_what, input) => {
    expect(sanitizeRichText(input)).toEqual({ type: 'doc', content: [] });
  });

  it('drops node types that are not on the allowlist, wherever they appear', () => {
    const dirty = doc(
      { type: 'image', attrs: { src: 'https://evil.test/x.png', onerror: 'alert(1)' } },
      { type: 'iframe', attrs: { src: 'javascript:alert(1)' } },
      { type: 'codeBlock', content: [text('<script>')] },
      paragraph(text('kept'), { type: 'mention', attrs: { id: 'pat_1' } }, { type: 'image' }),
      { type: 'html', attrs: { html: '<img src=x onerror=alert(1)>' } },
    );
    expect(sanitizeRichText(dirty)).toEqual(doc(paragraph({ type: 'text', text: 'kept' })));
  });

  it('drops marks and attributes that are not on the allowlist', () => {
    const dirty = doc({
      type: 'paragraph',
      attrs: { style: 'background:url(https://evil.test)', onclick: 'steal()' },
      content: [
        {
          type: 'text',
          text: 'click me',
          marks: [
            { type: 'link', attrs: { href: 'javascript:alert(1)' } },
            { type: 'bold', attrs: { style: 'position:fixed' } },
            { type: 'textStyle', attrs: { color: 'red' } },
            { type: 'bold' },
          ],
          attrs: { 'data-x': 1 },
        },
      ],
    });
    // Only `bold` survives, once, with no attributes. The link is gone, not rewritten.
    expect(sanitizeRichText(dirty)).toEqual(
      doc(paragraph({ type: 'text', text: 'click me', marks: [{ type: 'bold' }] })),
    );
    expect(JSON.stringify(sanitizeRichText(dirty))).not.toMatch(/javascript|style|onclick|href/);
  });

  it('keeps text that looks like markup as plain text', () => {
    const tricky = '<img src=x onerror=alert(1)> & <b>bold</b>';
    expect(sanitizeRichText(doc(paragraph(text(tricky))))).toEqual(
      doc(paragraph({ type: 'text', text: tricky })),
    );
  });

  it('rejects nodes in places they do not belong', () => {
    const dirty = doc(
      text('loose text at the top'),
      { type: 'listItem', content: [paragraph(text('item without a list'))] },
      { type: 'bulletList', content: [paragraph(text('not an item'))] },
      {
        type: 'blockquote',
        content: [{ type: 'heading', attrs: { level: 2 }, content: [text('h')] }],
      },
      paragraph(paragraph(text('nested paragraph'))),
    );
    // Containers left with nothing valid inside are dropped; the paragraph is kept, empty.
    expect(sanitizeRichText(dirty)).toEqual(doc({ type: 'paragraph' }));
  });

  it('allows heading levels 2 and 3 only', () => {
    const heading = (level: unknown) => ({
      type: 'heading',
      attrs: { level },
      content: [text('h')],
    });
    const levels = sanitizeRichText(
      doc(heading(1), heading(2), heading(3), heading(6), heading('x')),
    ).content.map((node) => (node.type === 'heading' ? node.attrs.level : null));
    expect(levels).toEqual([2, 2, 3, 2, 2]);
  });

  it('cuts off runaway nesting', () => {
    let nested: unknown = paragraph(text('deep'));
    for (let depth = 0; depth < 40; depth++) {
      nested = { type: 'bulletList', content: [{ type: 'listItem', content: [nested] }] };
    }
    const result = JSON.stringify(sanitizeRichText(doc(nested)));
    expect(result).not.toContain('deep');
    expect(result.length).toBeLessThan(200);
  });

  it('caps the total amount of text', () => {
    const huge = doc(
      paragraph(text('a'.repeat(MAX_TEXT_LENGTH))),
      paragraph(text('b'.repeat(500))),
    );
    const result = sanitizeRichText(huge);
    expect(richTextToPlainText(result).replace(/\n/g, '')).toHaveLength(MAX_TEXT_LENGTH);
    expect(JSON.stringify(result)).not.toContain('b');
  });

  it('ignores malformed nodes instead of throwing', () => {
    const dirty = doc(
      null,
      42,
      'text',
      [],
      { type: 7 },
      { type: 'text', text: 9 },
      paragraph(null, { type: 'text' }),
    );
    expect(() => sanitizeRichText(dirty)).not.toThrow();
    expect(sanitizeRichText(dirty)).toEqual(doc({ type: 'paragraph' }));
  });
});

describe('plain text', () => {
  it('reads the text without formatting', () => {
    expect(richTextToPlainText(note)).toBe(
      'Assessment\nStable. Review\nin two weeks.\nFirst\nSecond',
    );
  });

  it('knows an empty document, including one with only blank paragraphs', () => {
    expect(isEmptyRichText({ type: 'doc', content: [] })).toBe(true);
    expect(isEmptyRichText(sanitizeRichText(doc(paragraph(), paragraph(text('   ')))))).toBe(true);
    expect(isEmptyRichText(note)).toBe(false);
  });
});

describe('<RichTextView>', () => {
  it('renders the document as semantic elements', () => {
    render(<RichTextView document={note} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Assessment' })).toBeInTheDocument();
    expect(screen.getByText('Review').closest('strong')).toBeInTheDocument();
    expect(screen.getByText('Review').closest('em')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('shows markup-looking text as text and creates no element from it', () => {
    const { container } = render(
      <RichTextView
        document={doc(paragraph(text('<img src=x onerror=alert(1)><script>x</script>')))}
      />,
    );
    expect(container).toHaveTextContent('<img src=x onerror=alert(1)><script>x</script>');
    expect(container.querySelector('img, script')).toBeNull();
  });

  it('sanitizes what it is given, whatever its source', () => {
    const { container } = render(
      <RichTextView
        document={doc(
          { type: 'image', attrs: { src: 'https://evil.test/track.png' } },
          paragraph({
            type: 'text',
            text: 'safe',
            marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
          }),
        )}
      />,
    );
    expect(container).toHaveTextContent('safe');
    expect(container.querySelector('img, a, [href], [src], [style]')).toBeNull();
  });

  it('renders nothing for unusable input', () => {
    const { container } = render(<RichTextView document="<p>html string</p>" />);
    expect(container).toHaveTextContent('');
  });
});

describe('<RichTextEditor>', () => {
  // The editor scrolls the cursor into view after a command, which needs layout measurements
  // jsdom does not have. Empty measurements are enough: nothing here depends on positions.
  const noRects = () => [] as unknown as DOMRectList;
  const noRect = () => new DOMRect(0, 0, 0, 0);
  beforeAll(() => {
    for (const prototype of [Range.prototype, Element.prototype, Text.prototype] as object[]) {
      const target = prototype as { getClientRects?: unknown; getBoundingClientRect?: unknown };
      target.getClientRects ??= noRects;
      target.getBoundingClientRect ??= noRect;
    }
    document.elementFromPoint ??= () => null;
  });

  it('loads on demand and shows the starting content in a labelled text box', async () => {
    renderWithProviders(
      <RichTextEditor label="Clinical note" initialValue={note} onChange={vi.fn()} />,
      { session: null },
    );
    const editor = await screen.findByRole('textbox', { name: 'Clinical note' });
    expect(editor).toHaveAttribute('contenteditable', 'true');
    expect(editor).toHaveTextContent('Assessment');
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('never puts disallowed starting content into the editor', async () => {
    renderWithProviders(
      <RichTextEditor
        label="Clinical note"
        initialValue={doc(
          { type: 'image', attrs: { src: 'https://evil.test/x.png' } },
          paragraph({
            type: 'text',
            text: 'kept',
            marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
          }),
        )}
        onChange={vi.fn()}
      />,
      { session: null },
    );
    const editor = await screen.findByRole('textbox', { name: 'Clinical note' });
    expect(editor).toHaveTextContent('kept');
    expect(editor.querySelector('img, a')).toBeNull();
  });

  it('reports changes as a sanitized document, and a toolbar button toggles formatting', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <RichTextEditor
        label="Clinical note"
        initialValue={doc(paragraph(text('Plan')))}
        onChange={onChange}
      />,
      { session: null },
    );
    await screen.findByRole('textbox', { name: 'Clinical note' });

    await userEvent.click(screen.getByRole('button', { name: 'Bulleted list' }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const latest = onChange.mock.calls.at(-1)?.[0] as RichTextDocument;
    expect(latest).toEqual(sanitizeRichText(latest));
    expect(latest.content[0]?.type).toBe('bulletList');
    expect(richTextToPlainText(latest)).toBe('Plan');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Bulleted list' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
  });

  it('cannot be edited when disabled', async () => {
    renderWithProviders(
      <RichTextEditor label="Clinical note" initialValue={note} onChange={vi.fn()} disabled />,
      { session: null },
    );
    const editor = await screen.findByRole('textbox', { name: 'Clinical note' });
    expect(editor).toHaveAttribute('contenteditable', 'false');
    expect(screen.getByRole('button', { name: 'Bold' })).toBeDisabled();
  });
});
