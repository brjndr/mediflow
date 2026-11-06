import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from '@/shared/ui/button';

interface ConfirmDialogProps {
  open: boolean;
  /** Cancel, Escape and the backdrop-less close all end here. Not called after a confirm. */
  onClose: () => void;
  /** Already translated. */
  title: string;
  description: string;
  cancelLabel: string;
  confirmLabel: string;
  /** Presses the confirm button. Leave out when `confirmForm` names a form inside `children`. */
  onConfirm?: () => void;
  /** The id of a form inside `children`: the confirm button then submits it. */
  confirmForm?: string;
  /** A destructive answer is drawn in the warning colour; the safe answer still has focus first. */
  destructive?: boolean;
  /** Busy or not applicable: the button stays focusable and does nothing (`aria-disabled`). */
  pending?: boolean;
  /** Extra content between the description and the buttons: a field, a list of consequences. */
  children?: ReactNode;
}

/**
 * Asks before something that cannot be undone with one click: a modal on the native `<dialog>`
 * with `role="alertdialog"`, so focus is kept inside and Escape closes it. It fills the screen's
 * width on a phone. Focus starts on the first element marked `data-autofocus` in `children`, or
 * on Cancel, so a key pressed out of habit never confirms. When it closes, the browser returns
 * focus to the control that opened it; if that control went away (a Suspend button that became
 * Reactivate), the caller moves focus on with `focusIfLost`.
 *
 * Its content is mounted only while it is open, so a form inside starts empty every time.
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  cancelLabel,
  confirmLabel,
  onConfirm,
  confirmForm,
  destructive = false,
  pending = false,
  children,
}: ConfirmDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      const first =
        element.querySelector<HTMLElement>('[data-autofocus]') ??
        element.querySelector<HTMLElement>('[data-cancel]');
      first?.focus();
    }
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-lg border bg-background p-6 text-foreground shadow-lg backdrop:bg-black/50 max-md:w-[calc(100vw-1rem)]"
      // Escape is a cancel, and the parent owns whether the dialog is open.
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {open && (
        <div className="flex flex-col gap-3">
          <h2 id={titleId} className="text-lg font-semibold tracking-tight">
            {title}
          </h2>
          <p id={descriptionId} className="text-sm text-muted-foreground">
            {description}
          </p>
          {children}
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <Button variant="outline" data-cancel onClick={onClose}>
              {cancelLabel}
            </Button>
            <Button
              variant={destructive ? 'destructive' : 'default'}
              type={confirmForm ? 'submit' : 'button'}
              form={confirmForm}
              aria-disabled={pending || undefined}
              aria-busy={pending || undefined}
              onClick={confirmForm ? undefined : onConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      )}
    </dialog>
  );
}
