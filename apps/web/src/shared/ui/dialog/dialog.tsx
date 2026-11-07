import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Already translated. Names the dialog. */
  title: string;
  /** Already translated. When given, it also describes the dialog. */
  description?: string;
  /** Already translated: the accessible name of the close button. */
  closeLabel: string;
  /** The actions, in a footer that stays in view. A button there submits a form in the body with its `form` attribute. */
  footer?: ReactNode;
  /** A save is on its way: Escape, the backdrop and the close button leave the dialog open. */
  busy?: boolean;
  /** The width of the box from `md` up. A phone always gets the whole screen. */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  children?: ReactNode;
}

const SIZES = { sm: 'md:max-w-md', md: 'md:max-w-xl', lg: 'md:max-w-3xl' } as const;

/**
 * A modal dialog on Radix: the whole screen below `md`, a centred box from there up, with the
 * title and close button in a header and the actions in a footer that both stay in view while
 * the body scrolls. Focus goes to the first element marked `data-autofocus` in the body, else
 * the first field, else the title (a confirmation), stays inside, and returns to the control
 * that opened it. Escape closes it unless `busy`. The page behind is inert.
 *
 * Unlike `ConfirmDialog` it is controlled and keeps its children mounted only while open.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  closeLabel,
  footer,
  busy = false,
  size = 'md',
  className,
  children,
}: DialogProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => (busy && !next ? undefined : onOpenChange(next))}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <DialogPrimitive.Content
          {...(description ? {} : { 'aria-describedby': undefined })}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            opener.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            const first =
              body.current?.querySelector<HTMLElement>('[data-autofocus]') ??
              body.current?.querySelector<HTMLElement>(
                'input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])',
              );
            (first ?? heading.current)?.focus();
          }}
          // Back to the control that opened it, whether or not it is a Radix trigger. When that
          // control is gone, the caller moves focus on (`focusIfLost`).
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (opener.current?.isConnected) opener.current.focus();
          }}
          className={cn(
            'fixed inset-0 z-50 flex flex-col bg-background text-foreground shadow-lg outline-none',
            'md:inset-auto md:left-1/2 md:top-1/2 md:max-h-[calc(100dvh-2rem)] md:w-[calc(100vw-2rem)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg md:border',
            SIZES[size],
            className,
          )}
        >
          <header className="flex shrink-0 items-start justify-between gap-2 border-b px-4 py-3 md:px-6">
            <DialogPrimitive.Title
              ref={heading}
              tabIndex={-1}
              className="min-w-0 break-words text-lg font-semibold tracking-tight outline-none"
            >
              {title}
            </DialogPrimitive.Title>
            <Button
              variant="ghost"
              size="icon"
              aria-label={closeLabel}
              aria-disabled={busy || undefined}
              onClick={() => onOpenChange(false)}
              className="-mr-2 -mt-1"
            >
              <X aria-hidden="true" />
            </Button>
          </header>
          <div
            ref={body}
            // The header and footer are outside this box, but a focused field must still clear
            // them when the browser scrolls it into view (WCAG 2.4.11).
            className="flex min-h-0 flex-1 scroll-py-4 flex-col gap-3 overflow-y-auto px-4 py-4 md:px-6"
          >
            {description && (
              <DialogPrimitive.Description className="text-sm text-muted-foreground">
                {description}
              </DialogPrimitive.Description>
            )}
            {children}
          </div>
          {footer && (
            <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t px-4 py-3 max-md:flex-col-reverse md:px-6">
              {footer}
            </footer>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
