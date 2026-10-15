import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { useAppDispatch } from '../store-hooks';
import { signOut } from './api';
import { announceActivity, announceSignedOut, onSessionMessage } from './session-channel';
import { endSessionLocally, type SessionEndReason } from './session-end';
import { sessionKey } from './session-query';

/** Used when the hospital's configuration does not say. Matches the API's own default. */
export const DEFAULT_IDLE_MINUTES = 30;

/** What counts as someone being at the screen. Deliberate actions only, not a mouse drifting. */
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

interface IdleTimeoutProps {
  /** From the active hospital's configuration. */
  minutes: number | undefined;
}

/**
 * Signs the user out when nobody has used the app for the hospital's idle time, so a screen left
 * open at a nursing station does not stay readable. Rendered only while someone is signed in.
 *
 * - Activity in any tab counts for all of them: tabs tell each other, so a tab in the background
 *   never signs out someone who is working in another.
 * - Shortly before the end a dialog asks. From then on only its buttons count: a stray key press
 *   must not silently keep an unattended screen open.
 * - While the user is active the session is touched on the server now and then, so someone
 *   typing a long note is not timed out there for making no requests.
 * - At the end, everything loaded is dropped here first. Telling the server follows and may
 *   fail (the network may be gone); the screen is cleared regardless.
 */
export function IdleTimeout({ minutes }: IdleTimeoutProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const dispatch = useAppDispatch();

  const timeoutMs = (minutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
  // The warning shows for the last minute, or the last half of a very short timeout.
  const warnMs = Math.min(60_000, timeoutMs / 2);
  const tickMs = clamp(timeoutMs / 20, 50, 1000);
  // Other tabs and the server hear about activity at most this often.
  const shareEveryMs = clamp(timeoutMs / 6, 100, 5_000);
  const keepAliveEveryMs = clamp(timeoutMs / 3, 200, 5 * 60_000);

  // Set when the effect below starts: being signed in, or changing hospital, counts as activity.
  const lastActivity = useRef(0);
  const lastShared = useRef(0);
  const lastKeepAlive = useRef(0);
  const warning = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  const end = useCallback(
    (reason: SessionEndReason) => {
      endSessionLocally(queryClient, dispatch, reason);
      announceSignedOut();
      // Best effort. The server ends an unused session by itself anyway.
      void signOut().catch(() => {});
    },
    [queryClient, dispatch],
  );

  const stay = useCallback(() => {
    const now = Date.now();
    lastActivity.current = now;
    lastShared.current = now;
    lastKeepAlive.current = now;
    warning.current = false;
    setSecondsLeft(null);
    announceActivity();
    void queryClient.refetchQueries({ queryKey: sessionKey, exact: true });
  }, [queryClient]);

  useEffect(() => {
    lastActivity.current = Date.now();
    lastKeepAlive.current = Date.now();
    const onActivity = () => {
      if (warning.current) return;
      const now = Date.now();
      lastActivity.current = now;
      if (now - lastShared.current >= shareEveryMs) {
        lastShared.current = now;
        announceActivity();
      }
      if (now - lastKeepAlive.current >= keepAliveEveryMs) {
        lastKeepAlive.current = now;
        void queryClient.refetchQueries({ queryKey: sessionKey, exact: true });
      }
    };
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true });
    }

    const unsubscribe = onSessionMessage((message) => {
      if (message !== 'activity') return;
      // The user answered, or is at work, in another tab.
      lastActivity.current = Date.now();
      warning.current = false;
      setSecondsLeft(null);
    });

    const timer = setInterval(() => {
      const remaining = lastActivity.current + timeoutMs - Date.now();
      if (remaining <= 0) {
        clearInterval(timer);
        end('idle');
      } else if (remaining <= warnMs) {
        warning.current = true;
        setSecondsLeft(Math.ceil(remaining / 1000));
      }
    }, tickMs);

    return () => {
      clearInterval(timer);
      unsubscribe();
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, onActivity);
    };
  }, [queryClient, end, timeoutMs, warnMs, tickMs, shareEveryMs, keepAliveEveryMs]);

  const open = secondsLeft !== null;
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      // Staying is the answer that loses nothing: a key pressed out of habit must not sign out.
      element.querySelector<HTMLElement>('[data-stay]')?.focus();
    }
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      role="alertdialog"
      aria-labelledby="idle-title"
      aria-describedby="idle-description"
      className="m-auto w-[min(24rem,calc(100vw-2rem))] rounded-lg border bg-background p-6 text-foreground shadow-lg backdrop:bg-black/50"
      // Escape answers the question the safe way round: the user is here.
      onCancel={(event) => {
        event.preventDefault();
        stay();
      }}
    >
      {open && (
        <div className="flex flex-col gap-3">
          <h2 id="idle-title" className="text-lg font-semibold tracking-tight">
            {t('idle.title')}
          </h2>
          <p id="idle-description" className="text-sm text-muted-foreground">
            {t('idle.description', { count: secondsLeft })}
          </p>
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => end('signed_out')}>
              {t('idle.signOut')}
            </Button>
            <Button data-stay onClick={stay}>
              {t('idle.stay')}
            </Button>
          </div>
        </div>
      )}
    </dialog>
  );
}
