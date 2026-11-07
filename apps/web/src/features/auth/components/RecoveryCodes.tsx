import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { useLeaveGuard } from '../hooks/use-leave-guard';

/** How long copied codes stay on the clipboard before it is emptied. */
export const CLIPBOARD_CLEAR_MS = 60_000;

/** Saves the codes as a text file the person chooses where to keep. Nothing is stored here. */
function downloadCodes(codes: string[]) {
  const url = URL.createObjectURL(new Blob([codes.join('\n') + '\n'], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'recovery-codes.txt';
  link.click();
  // After the browser has taken the file, not in the same breath as the click.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * The recovery codes, shown once. The screen holds the person until they confirm they saved them
 * (a leave guard), and codes copied to the clipboard are cleared from it after a minute or when
 * the screen closes, since the next person at a shared computer could paste them.
 */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const { blocked, clearBlocked } = useLeaveGuard(!saved);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copied = useRef(false);

  const emptyClipboard = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!copied.current) return;
    copied.current = false;
    // Best effort: a browser may refuse once the page is not focused.
    void navigator.clipboard?.writeText('').catch(() => undefined);
  };
  useEffect(() => emptyClipboard, []);

  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      copied.current = true;
      setCopy('copied');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        emptyClipboard();
        setCopy('idle');
      }, CLIPBOARD_CLEAR_MS);
    } catch {
      // No clipboard access (an insecure page, or refused): the codes are still on screen.
      setCopy('failed');
    }
  };

  return (
    <>
      <p className="text-sm">{t('security.codesIntro')}</p>
      <ul
        aria-label={t('security.codesLabel')}
        className="grid grid-cols-2 gap-2 rounded-md border bg-muted p-3 font-mono text-sm"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={() => void copyCodes()}>
          {t('security.copy')}
        </Button>
        <Button type="button" variant="outline" onClick={() => downloadCodes(codes)}>
          {t('security.download')}
        </Button>
      </div>
      <p role="status" className="min-h-5 text-sm">
        {copy === 'copied' && t('security.copied')}
        {copy === 'failed' && t('security.copyFailed')}
      </p>
      <p className="text-sm text-muted-foreground">{t('security.sharedPc')}</p>
      {blocked && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {t('security.leaveBlocked')}
        </p>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => {
            setSaved(e.target.checked);
            clearBlocked();
          }}
        />
        {t('security.codesSaved')}
      </label>
      <Button
        type="button"
        aria-disabled={!saved}
        onClick={() => {
          emptyClipboard();
          onDone();
        }}
      >
        {t('security.done')}
      </Button>
    </>
  );
}
