import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RichTextEditor,
  richTextToPlainText,
  RichTextView,
  type RichTextDocument,
} from '@/shared/ui/rich-text';
import { ExamplePage } from '../components/ExamplePage';

// Synthetic. A real note is loaded from, and saved to, the API as this JSON document.
const START: RichTextDocument = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Example note' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Formatting is stored as a ' },
        { type: 'text', text: 'document', marks: [{ type: 'bold' }] },
        { type: 'text', text: ', never as HTML.' },
      ],
    },
  ],
};

export default function EditorExample() {
  const { t } = useTranslation('ui_examples');
  const [document, setDocument] = useState<RichTextDocument>(START);

  return (
    <ExamplePage heading={t('editor.heading')}>
      <RichTextEditor label={t('editor.label')} initialValue={START} onChange={setDocument} />
      <p role="status" className="text-sm text-muted-foreground">
        {t('editor.characters', { count: richTextToPlainText(document).length })}
      </p>
      <section aria-labelledby="preview-title" className="rounded-lg border p-4">
        <h2 id="preview-title" className="mb-2 text-sm font-medium">
          {t('editor.preview')}
        </h2>
        {/* The viewer needs no editor code: a list or a summary can show notes cheaply. */}
        <RichTextView document={document} />
      </section>
    </ExamplePage>
  );
}
