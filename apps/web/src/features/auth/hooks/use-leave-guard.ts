import { useEffect, useState } from 'react';

/**
 * Holds a person on a screen that shows something once (the recovery codes) until they say they
 * are done. Closing or reloading the tab asks the browser to confirm, and a click on a link inside
 * the app is stopped and reported through `blocked`, for the screen to explain in a live region.
 * The router has no blocker (no data router), so links are caught before it sees them. The browser's
 * own back button cannot be held back from here; the codes stay on screen if it is pressed once.
 */
export function useLeaveGuard(active: boolean): { blocked: boolean; clearBlocked: () => void } {
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (!active) return;
    const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!link || link.getAttribute('target') === '_blank') return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      setBlocked(true);
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [active]);

  return { blocked: active && blocked, clearBlocked: () => setBlocked(false) };
}
