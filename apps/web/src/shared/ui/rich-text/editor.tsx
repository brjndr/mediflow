// The editor library lives only in this module. Import RichTextEditor from './index', which
// loads this file on demand, so the library is never part of the initial bundle or of a screen
// that only displays text (use RichTextView for that).
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  Bold,
  Heading2,
  Italic,
  List,
  ListOrdered,
  Quote,
  Strikethrough,
  Underline,
} from 'lucide-react';
import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { sanitizeRichText, type RichTextDocument } from './document';

export interface RichTextEditorProps {
  /** Names the editor for assistive technology. */
  label: string;
  /** Ids of the hint and the error message that describe the text, space-separated. */
  describedBy?: string;
  /** The text cannot be saved as it is: said with the field, as a kit field says it. */
  invalid?: boolean;
  /** The starting content. Read once: the editor owns the content while it is open. */
  initialValue?: unknown;
  /** Called with a sanitized document on every change. */
  onChange: (document: RichTextDocument) => void;
  disabled?: boolean;
  /**
   * Pieces of fixed text the person can put in where the cursor is, chosen from a list: the
   * placeholders of a template. Plain text goes in, never markup.
   */
  insertable?: {
    /** Already translated: names the list. */
    label: string;
    options: { value: string; label: string }[];
  };
}

// Only what the document allowlist can hold. Links, code blocks, images and raw HTML are off:
// each is a way for unexpected content to get in, and clinical notes do not need them.
const extensions = [
  StarterKit.configure({
    heading: { levels: [2, 3] },
    link: false,
    code: false,
    codeBlock: false,
    horizontalRule: false,
  }),
];

interface Tool {
  id: string;
  icon: ComponentType<{ className?: string }>;
  labelKey: string;
}

const TOOLS: Tool[] = [
  { id: 'bold', icon: Bold, labelKey: 'editor.bold' },
  { id: 'italic', icon: Italic, labelKey: 'editor.italic' },
  { id: 'underline', icon: Underline, labelKey: 'editor.underline' },
  { id: 'strike', icon: Strikethrough, labelKey: 'editor.strike' },
  { id: 'heading', icon: Heading2, labelKey: 'editor.heading' },
  { id: 'bulletList', icon: List, labelKey: 'editor.bulletList' },
  { id: 'orderedList', icon: ListOrdered, labelKey: 'editor.orderedList' },
  { id: 'blockquote', icon: Quote, labelKey: 'editor.blockquote' },
];

interface Described {
  label: string;
  describedBy?: string;
  invalid?: boolean;
}

function startingDocument(value: unknown): RichTextDocument {
  const document = sanitizeRichText(value);
  return document.content.length > 0 ? document : { ...document, content: [{ type: 'paragraph' }] };
}

/** The attributes of the editable area: a labelled, described text box of several lines. */
function textboxAttributes({ label, describedBy, invalid }: Described) {
  return {
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': label,
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    ...(invalid ? { 'aria-invalid': 'true' } : {}),
    class:
      'min-h-32 px-3 py-2 text-sm leading-relaxed outline-none [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_h2]:font-semibold [&_h3]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:pl-3',
  };
}

export function RichTextEditor({
  label,
  describedBy,
  invalid = false,
  initialValue,
  onChange,
  disabled = false,
  insertable,
}: RichTextEditorProps) {
  const { t } = useTranslation();
  // The toolbar is one Tab stop: the arrows move between its buttons (the toolbar pattern), and
  // Tab goes on to the text. The one that has it is remembered for the next visit.
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const [current, setCurrent] = useState(0);
  const toTool = (index: number) => {
    const count = TOOLS.length;
    const next = ((index % count) + count) % count;
    setCurrent(next);
    buttons.current[next]?.focus();
  };
  const onToolbarKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = {
      ArrowRight: current + 1,
      ArrowLeft: current - 1,
      Home: 0,
      End: TOOLS.length - 1,
    };
    const target = moves[event.key];
    if (target === undefined) return;
    event.preventDefault();
    toTool(target);
  };
  const [pick, setPick] = useState('');
  // The label, hint and error can change while the editor is open: the editor reads the latest
  // each time it draws itself, and an effect below puts a change on the element at once.
  const described = useRef<Described>({ label, describedBy, invalid });
  const editor = useEditor({
    extensions,
    // Whatever was stored is reduced to the allowlist before the editor ever sees it. An empty
    // document starts with one empty paragraph: with none, the editor adds it on the first
    // change, and that change drops a format chosen before typing (Bold, then type).
    content: startingDocument(initialValue),
    editable: !disabled,
    editorProps: {
      attributes: () => textboxAttributes(described.current),
      // Tab indents a list item and otherwise leaves the text, as the list extension decides.
      // Escape leaves it for the toolbar: a way out that never types anything.
      handleKeyDown: (_view, event) => {
        if (event.key !== 'Escape') return false;
        // Read from the page, not from state: this handler is made once, with the editor.
        (buttons.current.find((button) => button?.tabIndex === 0) ?? buttons.current[0])?.focus();
        return true;
      },
    },
    // And what the editor produces is reduced again on the way out.
    onUpdate: ({ editor: current }) => onChange(sanitizeRichText(current.getJSON())),
  });

  useEffect(() => {
    described.current = { label, describedBy, invalid };
    if (!editor || editor.isDestroyed) return;
    let element: HTMLElement;
    try {
      element = editor.view.dom;
    } catch {
      return; // Not mounted yet: it will read the latest attributes when it is.
    }
    for (const [name, value] of Object.entries(
      textboxAttributes({ label, describedBy, invalid }),
    )) {
      if (name !== 'class') element.setAttribute(name, value);
    }
    if (!describedBy) element.removeAttribute('aria-describedby');
    if (!invalid) element.removeAttribute('aria-invalid');
  }, [editor, label, describedBy, invalid]);

  const active = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      Object.fromEntries(
        TOOLS.map((tool) => [
          tool.id,
          tool.id === 'heading'
            ? (current?.isActive('heading', { level: 2 }) ?? false)
            : (current?.isActive(tool.id) ?? false),
        ]),
      ),
  });

  const run = (id: string) => {
    if (!editor) return;
    const apply = () => {
      const chain = editor.chain();
      if (id === 'bold') chain.toggleBold().run();
      else if (id === 'italic') chain.toggleItalic().run();
      else if (id === 'underline') chain.toggleUnderline().run();
      else if (id === 'strike') chain.toggleStrike().run();
      else if (id === 'heading') chain.toggleHeading({ level: 2 }).run();
      else if (id === 'bulletList') chain.toggleBulletList().run();
      else if (id === 'orderedList') chain.toggleOrderedList().run();
      else if (id === 'blockquote') chain.toggleBlockquote().run();
    };
    // From the toolbar (a key or a click): back to the text, where the format applies.
    editor.view.focus();
    apply();
  };

  return (
    <div
      className={cn(
        'rounded-md border bg-background focus-within:ring-[3px] focus-within:ring-ring/50',
        disabled && 'opacity-60',
      )}
    >
      <div className="flex flex-wrap items-center gap-1 border-b p-1">
        <div
          role="toolbar"
          aria-label={t('editor.toolbar')}
          className="flex flex-wrap gap-0.5"
          onKeyDown={onToolbarKey}
        >
          {TOOLS.map(({ id, icon: Icon, labelKey }, index) => (
            <button
              key={id}
              ref={(element) => {
                buttons.current[index] = element;
              }}
              type="button"
              tabIndex={index === current ? 0 : -1}
              disabled={disabled || !editor}
              aria-label={t(labelKey)}
              aria-pressed={active?.[id] ?? false}
              title={t(labelKey)}
              className="inline-flex size-8 items-center justify-center rounded-sm outline-none pointer-coarse:size-11 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 aria-pressed:bg-accent"
              onFocus={() => setCurrent(index)}
              onClick={() => run(id)}
            >
              <Icon className="size-4" />
            </button>
          ))}
        </div>
        {insertable && (
          // Outside the toolbar, so its arrows choose in the list and never move between buttons.
          // Choosing puts nothing in: the button does, so going through the list with the arrow
          // keys never fills the text with every placeholder on the way.
          <div className="ml-1 flex flex-wrap items-center gap-1">
            <select
              aria-label={insertable.label}
              disabled={disabled || !editor}
              value={pick}
              onChange={(event) => setPick(event.target.value)}
              className="h-8 max-w-56 rounded-sm border bg-background px-2 text-sm outline-none pointer-coarse:h-11 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
            >
              <option value="">{insertable.label}</option>
              {insertable.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-disabled={disabled || !editor || pick === '' || undefined}
              onClick={() => {
                // As text, at the cursor the text had: the document stays what the allowlist holds.
                const text = insertable.options.find((option) => option.value === pick)?.value;
                if (editor && text)
                  editor.chain().focus().insertContent({ type: 'text', text }).run();
                setPick('');
              }}
            >
              {t('editor.insert')}
            </Button>
          </div>
        )}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
