import { createTransport } from 'nodemailer';
import type { Config } from '../config/config.js';
import { renderTemplate, type TemplateData, type TemplateName } from './templates.js';

/** One email to send. Described by template and data, never by raw subject or body. */
export interface Notification<Name extends TemplateName = TemplateName> {
  /** Recipient address. Staff only. */
  to: string;
  template: Name;
  data: TemplateData[Name];
}

/**
 * How the app sends messages. Callers depend on this interface only, so the provider (SMTP today,
 * SES or another channel later) can change without touching them. Adding a channel or a provider
 * is a new implementation of this interface.
 */
export interface Notifier {
  send<Name extends TemplateName>(notification: Notification<Name>): Promise<void>;
  close(): Promise<void>;
}

export class NotifierError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NotifierError';
  }
}

/** One address, no display name, no list: a recipient field cannot be used to add recipients. */
const ADDRESS = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

function assertAddress(address: string): void {
  if (!ADDRESS.test(address) || address.length > 254) {
    throw new NotifierError('The recipient is not a single valid email address');
  }
}

/** Sends through an SMTP server: Mailpit locally, the hospital platform's mail service in production. */
export function createSmtpNotifier(
  config: Pick<Config, 'SMTP_URL' | 'MAIL_FROM' | 'APP_BASE_URL'>,
): Notifier {
  const transport = createTransport({
    url: config.SMTP_URL,
    // Fail a send that cannot connect quickly instead of holding a request open.
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
  });

  return {
    async send(notification) {
      assertAddress(notification.to);
      const email = renderTemplate(notification.template, notification.data, config.APP_BASE_URL);
      try {
        await transport.sendMail({
          from: config.MAIL_FROM,
          to: notification.to,
          subject: email.subject,
          text: email.text,
          html: email.html,
          // No tracking pixels, no remote content: nothing that reports when a message is opened.
          disableFileAccess: true,
          disableUrlAccess: true,
        });
      } catch (error) {
        // The provider's error can quote the recipient or the server address. Callers get a
        // plain failure; the cause is attached for whoever handles it, and logs redact it.
        throw new NotifierError(`Could not send the ${notification.template} email`, {
          cause: error,
        });
      }
    },
    async close() {
      transport.close();
    },
  };
}

export interface SentNotification extends Notification {
  subject: string;
  text: string;
  html: string;
}

/**
 * Keeps what was "sent" in memory instead of sending it. For tests of code that notifies: assert
 * on `sent`, with no mail server involved. Templates are still rendered, so a broken one fails.
 */
export function createMemoryNotifier(appBaseUrl: string): Notifier & { sent: SentNotification[] } {
  const sent: SentNotification[] = [];
  return {
    sent,
    async send(notification) {
      assertAddress(notification.to);
      sent.push({
        ...notification,
        ...renderTemplate(notification.template, notification.data, appBaseUrl),
      });
    },
    async close() {},
  };
}
