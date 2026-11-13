import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { i18n as I18n } from 'i18next';
import { I18nextProvider } from 'react-i18next';

/**
 * A document to print: drawn into a box of its own under `<body>`, hidden on screen, the only
 * thing shown on paper (the print rules of `index.css`). Once its images are ready it opens the
 * browser's print dialog, and calls `onDone` when the dialog closes. Mount one per print (a new
 * `key` each time), and only once whatever must happen first (the audit) has happened. What it
 * shows is held in memory only, as anything else on the screen. `className` replaces the page's
 * padding and type, for something smaller than a page (a sample's label). `i18n` draws the
 * document in another language (#771, "Print in Hindi"): its strings come from that instance,
 * the box carries its `lang` (which brings the Devanagari font, `index.css`), and the dialog
 * opens once that font is ready so no glyph prints as a box.
 */
export function PrintSheet({
  children,
  onDone,
  className = 'p-8 text-sm leading-relaxed',
  i18n,
}: {
  children: ReactNode;
  onDone: () => void;
  className?: string;
  i18n?: I18n;
}) {
  const box = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);

  useEffect(() => {
    let live = true;
    const finish = () => {
      if (live) done.current();
    };
    const images = Array.from(box.current?.querySelectorAll('img') ?? []);
    // A logo not yet loaded would print as a blank; one that fails prints without it.
    const fonts =
      i18n && typeof document.fonts?.load === 'function'
        ? document.fonts.load('1em "Noto Sans Devanagari Variable"', 'अ').catch(() => undefined)
        : undefined;
    void Promise.all([
      fonts,
      ...images.map((image) =>
        typeof image.decode === 'function' ? image.decode().catch(() => undefined) : undefined,
      ),
    ]).then(() => {
      if (!live) return;
      window.addEventListener('afterprint', finish, { once: true });
      window.print();
    });
    return () => {
      live = false;
      window.removeEventListener('afterprint', finish);
    };
    // Once per sheet: a new print mounts a new sheet (a new key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div ref={box} data-print-sheet="" className={className} lang={i18n?.language}>
      {i18n ? <I18nextProvider i18n={i18n}>{children}</I18nextProvider> : children}
    </div>,
    document.body,
  );
}
