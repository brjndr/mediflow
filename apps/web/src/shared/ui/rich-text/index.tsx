// The editor loads on demand; the viewer and the document helpers are light and load normally.
/* eslint-disable react-refresh/only-export-components */
import { lazy, Suspense } from 'react';
import { Skeleton } from '@/shared/ui/skeleton';
import type { RichTextEditorProps } from './editor';

export {
  EMPTY_DOCUMENT,
  isEmptyRichText,
  MAX_TEXT_LENGTH,
  richTextToPlainText,
  sanitizeRichText,
  type RichTextDocument,
  type RichTextMark,
  type RichTextNode,
} from './document';
export { RichTextView } from './RichTextView';
export type { RichTextEditorProps } from './editor';

const LazyEditor = lazy(() =>
  import('./editor').then((module) => ({ default: module.RichTextEditor })),
);

/** The rich text editor. Its output is a sanitized JSON document, never HTML. */
export function RichTextEditor(props: RichTextEditorProps) {
  return (
    <Suspense fallback={<Skeleton className="h-44 w-full" />}>
      <LazyEditor {...props} />
    </Suspense>
  );
}
