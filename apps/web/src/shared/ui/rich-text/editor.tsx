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
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { sanitizeRichText, type RichTextDocument } from './document';

export interface RichTextEditorProps {
  /** Names the editor for assistive technology. */
  label: string;
  /** The starting content. Read once: the editor owns the content while it is open. */
  initialValue?: unknown;
  /** Called with a sanitized document on every change. */
  onChange: (document: RichTextDocument) => void;
  disabled?: boolean;
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

export function RichTextEditor({
  label,
  initialValue,
  onChange,
  disabled = false,
}: RichTextEditorProps) {
  const { t } = useTranslation();
  const editor = useEditor({
    extensions,
    // Whatever was stored is reduced to the allowlist before the editor ever sees it.
    content: sanitizeRichText(initialValue),
    editable: !disabled,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': label,
        class:
          'min-h-32 px-3 py-2 text-sm leading-relaxed outline-none [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_h2]:font-semibold [&_h3]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:pl-3',
      },
    },
    // And what the editor produces is reduced again on the way out.
    onUpdate: ({ editor: current }) => onChange(sanitizeRichText(current.getJSON())),
  });

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
    const chain = editor.chain().focus();
    if (id === 'bold') chain.toggleBold().run();
    else if (id === 'italic') chain.toggleItalic().run();
    else if (id === 'underline') chain.toggleUnderline().run();
    else if (id === 'strike') chain.toggleStrike().run();
    else if (id === 'heading') chain.toggleHeading({ level: 2 }).run();
    else if (id === 'bulletList') chain.toggleBulletList().run();
    else if (id === 'orderedList') chain.toggleOrderedList().run();
    else if (id === 'blockquote') chain.toggleBlockquote().run();
  };

  return (
    <div
      className={cn(
        'rounded-md border bg-background focus-within:ring-[3px] focus-within:ring-ring/50',
        disabled && 'opacity-60',
      )}
    >
      <div
        role="toolbar"
        aria-label={t('editor.toolbar')}
        className="flex flex-wrap gap-0.5 border-b p-1"
      >
        {TOOLS.map(({ id, icon: Icon, labelKey }) => (
          <button
            key={id}
            type="button"
            disabled={disabled || !editor}
            aria-label={t(labelKey)}
            aria-pressed={active?.[id] ?? false}
            title={t(labelKey)}
            className="inline-flex size-8 items-center justify-center rounded-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 aria-pressed:bg-accent"
            onClick={() => run(id)}
          >
            <Icon className="size-4" />
          </button>
        ))}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
