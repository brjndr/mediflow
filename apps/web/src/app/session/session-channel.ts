/**
 * Keeps this user's tabs in step. A tab that changes the session tells the others, so they act at
 * once instead of finding out from a rejected request. Messages carry no data: each is one of the
 * fixed words below, and a tab that hears one asks the server for the truth.
 */
const CHANNEL_NAME = 'mediflow.session';

/** What happened in another tab. */
export type SessionMessage =
  /** The active hospital changed (a switch, or a deep link to another hospital). */
  | 'session-changed'
  | 'signed-in'
  | 'signed-out'
  /** The user is at work in that tab, so no tab should count them as idle. */
  | 'activity';

const MESSAGES: readonly string[] = ['session-changed', 'signed-in', 'signed-out', 'activity'];
const isMessage = (data: unknown): data is SessionMessage =>
  typeof data === 'string' && MESSAGES.includes(data);

let channel: BroadcastChannel | undefined;

// One channel per tab for both sending and listening: a channel never receives its own messages,
// so the tab that made the change is not told about it.
function getChannel(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined;
  channel ??= new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

const announce = (message: SessionMessage) => getChannel()?.postMessage(message);

/** The active hospital changed in this tab. */
export const announceSessionChange = () => announce('session-changed');
export const announceSignedIn = () => announce('signed-in');
export const announceSignedOut = () => announce('signed-out');
export const announceActivity = () => announce('activity');

/** Hears everything other tabs announce. Returns an unsubscribe function. */
export function onSessionMessage(listener: (message: SessionMessage) => void): () => void {
  const target = getChannel();
  if (!target) return () => {};
  const handler = (event: MessageEvent) => {
    // Anything else on the channel is ignored, not trusted.
    if (isMessage(event.data)) listener(event.data);
  };
  target.addEventListener('message', handler);
  return () => target.removeEventListener('message', handler);
}

/** Hears only a change of hospital in another tab. Returns an unsubscribe function. */
export function onSessionChangeElsewhere(listener: () => void): () => void {
  return onSessionMessage((message) => {
    if (message === 'session-changed') listener();
  });
}

export const SESSION_CHANNEL_NAME = CHANNEL_NAME;
export const SESSION_CHANGED_MESSAGE: SessionMessage = 'session-changed';
