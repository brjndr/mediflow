import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { AppNav } from './AppNav';

interface NavDrawerProps {
  open: boolean;
  onClose: () => void;
}

/**
 * The navigation on narrow screens. A native modal <dialog>: the browser traps focus inside it,
 * closes it on Escape and returns focus to the button that opened it.
 */
export function NavDrawer({ open, onClose }: NavDrawerProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    // The click handler only adds closing by clicking the backdrop. Keyboard users close the
    // drawer with Escape (built into <dialog>) or the close button.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={ref}
      aria-label={t('nav.menu')}
      className="m-0 h-dvh max-h-none w-72 max-w-[85vw] border-r bg-background p-0 text-foreground backdrop:bg-black/40"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself, not on its content.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {open && (
        <div className="flex h-full flex-col gap-4 p-3">
          <div className="flex items-center justify-between pl-3">
            <span className="text-sm font-semibold text-primary">{t('app.name')}</span>
            <Button size="icon" variant="ghost" aria-label={t('nav.closeMenu')} onClick={onClose}>
              <X aria-hidden />
            </Button>
          </div>
          <AppNav onNavigate={onClose} />
        </div>
      )}
    </dialog>
  );
}
