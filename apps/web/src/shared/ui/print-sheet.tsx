import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A document to print: drawn into a box of its own under `<body>`, hidden on screen, the only
 * thing shown on paper (the print rules of `index.css`). Once its images are ready it opens the
 * browser's print dialog, and calls `onDone` when the dialog closes. Mount one per print (a new
 * `key` each time), and only once whatever must happen first (the audit) has happened. What it
 * shows is held in memory only, as anything else on the screen.
 */
export function PrintSheet({ children, onDone }: { children: ReactNode; onDone: () => void }) {
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
    void Promise.all(
      images.map((image) =>
        typeof image.decode === 'function' ? image.decode().catch(() => undefined) : undefined,
      ),
    ).then(() => {
      if (!live) return;
      window.addEventListener('afterprint', finish, { once: true });
      window.print();
    });
    return () => {
      live = false;
      window.removeEventListener('afterprint', finish);
    };
  }, []);

  return createPortal(
    <div ref={box} data-print-sheet="" className="p-8 text-sm leading-relaxed">
      {children}
    </div>,
    document.body,
  );
}
