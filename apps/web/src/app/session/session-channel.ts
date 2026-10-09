/**
 * Tells this user's other tabs that the session changed (for example a hospital switch), so they
 * reload it at once instead of finding out from a rejected request. The message carries no data.
 */
const CHANNEL_NAME = 'mediflow.session';
const SESSION_CHANGED = 'session-changed';

let channel: BroadcastChannel | undefined;

// One channel per tab for both sending and listening: a channel never receives its own messages,
// so the tab that made the change is not told about it.
function getChannel(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined;
  channel ??= new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

export function announceSessionChange(): void {
  getChannel()?.postMessage(SESSION_CHANGED);
}

/** Returns an unsubscribe function. */
export function onSessionChangeElsewhere(listener: () => void): () => void {
  const target = getChannel();
  if (!target) return () => {};
  const handler = (event: MessageEvent) => {
    if (event.data === SESSION_CHANGED) listener();
  };
  target.addEventListener('message', handler);
  return () => target.removeEventListener('message', handler);
}

export const SESSION_CHANNEL_NAME = CHANNEL_NAME;
export const SESSION_CHANGED_MESSAGE = SESSION_CHANGED;
