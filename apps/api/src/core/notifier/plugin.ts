import fp from 'fastify-plugin';
import { createSmtpNotifier, type Notifier } from './notifier.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Sends staff email. Features call this, never a mail library. */
    notifier: Notifier;
  }
}

/**
 * Makes the notifier available as `app.notifier`. The default sends through SMTP; tests pass an
 * in-memory one. Sending is direct for now. When the job queue exists (BE-06), sends move onto
 * it so a slow mail server never slows a request and a failed send is retried.
 */
export const notifierPlugin = fp<{ notifier?: Notifier }>(
  async (app, options) => {
    const notifier = options.notifier ?? createSmtpNotifier(app.config);
    app.decorate('notifier', notifier);
    app.addHook('onClose', () => notifier.close());
  },
  { name: 'notifier' },
);
