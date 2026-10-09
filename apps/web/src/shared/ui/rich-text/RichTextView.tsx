import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';
import { sanitizeRichText, type RichTextNode } from './document';

/**
 * Shows a rich text document. It needs no editor code, so it is cheap to use anywhere (a note in
 * a list, a discharge summary), and it builds React elements from the sanitized document:
 * no HTML string is ever parsed or injected.
 */

function renderNode(node: RichTextNode, key: number): ReactNode {
  switch (node.type) {
    case 'text': {
      let content: ReactNode = node.text;
      for (const mark of node.marks ?? []) {
        if (mark.type === 'bold') content = <strong>{content}</strong>;
        else if (mark.type === 'italic') content = <em>{content}</em>;
        else if (mark.type === 'underline') content = <u>{content}</u>;
        else if (mark.type === 'strike') content = <s>{content}</s>;
      }
      return <span key={key}>{content}</span>;
    }
    case 'hardBreak':
      return <br key={key} />;
    case 'paragraph':
      return <p key={key}>{node.content?.map(renderNode)}</p>;
    case 'heading': {
      // Level 2 and 3 only: level 1 belongs to the page.
      const Heading = node.attrs.level === 3 ? 'h3' : 'h2';
      return (
        <Heading key={key} className="font-semibold">
          {node.content?.map(renderNode)}
        </Heading>
      );
    }
    case 'bulletList':
      return (
        <ul key={key} className="list-disc pl-5">
          {node.content.map(renderNode)}
        </ul>
      );
    case 'orderedList':
      return (
        <ol key={key} className="list-decimal pl-5">
          {node.content.map(renderNode)}
        </ol>
      );
    case 'listItem':
      return <li key={key}>{node.content.map(renderNode)}</li>;
    case 'blockquote':
      return (
        <blockquote key={key} className="border-l-2 pl-3 text-muted-foreground">
          {node.content.map(renderNode)}
        </blockquote>
      );
  }
}

interface RichTextViewProps {
  /** A document from the API or the editor. It is sanitized again here, whatever its source. */
  document: unknown;
  className?: string;
}

export function RichTextView({ document, className }: RichTextViewProps) {
  const safe = sanitizeRichText(document);
  return (
    <div className={cn('flex flex-col gap-2 text-sm leading-relaxed', className)}>
      {safe.content.map(renderNode)}
    </div>
  );
}
