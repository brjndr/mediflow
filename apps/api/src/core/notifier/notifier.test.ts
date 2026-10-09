import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { buildTestApp, testConfig } from '../../../test/helpers.js';
import { createMemoryNotifier, createSmtpNotifier, NotifierError } from './notifier.js';
import { appLink, renderTemplate } from './templates.js';

const APP = 'https://app.example.com';
const invite = {
  hospitalName: 'Sample Hospital',
  linkPath: '/invite?token=abc123',
  expiresInHours: 72,
};
const reset = { linkPath: '/reset-password?token=def456', expiresInMinutes: 30 };

describe('templates', () => {
  it('renders the invite with the hospital, one link and its expiry', () => {
    const email = renderTemplate('invite', invite, APP);
    expect(email.subject).toBe('You have been invited to Sample Hospital on Mediflow');
    expect(email.text).toContain('https://app.example.com/invite?token=abc123');
    expect(email.text).toContain('expires in 72 hours');
    expect(email.html).toContain('<a href="https://app.example.com/invite?token=abc123">');
    expect(email.html.match(/<a /g)).toHaveLength(1);
  });

  it('renders the password reset without saying whose account it is', () => {
    const email = renderTemplate('password_reset', reset, APP);
    expect(email.subject).toBe('Reset your Mediflow password');
    expect(email.text).toContain('https://app.example.com/reset-password?token=def456');
    expect(email.text).toContain('expires in 30 minutes');
    // No name, no address, no hospital: the email reveals nothing if it is misdelivered.
    expect(email.text).not.toMatch(/@|Hospital/);
  });

  it('carries no remote content: nothing reports that the email was opened', () => {
    for (const email of [
      renderTemplate('invite', invite, APP),
      renderTemplate('password_reset', reset, APP),
    ]) {
      expect(email.html).not.toMatch(/<img|<script|<link|<iframe|url\(/i);
    }
  });

  it('escapes a hospital name in HTML and keeps it on one line in the subject', () => {
    const hostile = 'Evil <script>alert(1)</script> & "Sons"\r\nBcc: attacker@evil.test';
    const email = renderTemplate('invite', { ...invite, hospitalName: hostile }, APP);
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).toContain('&amp; &quot;Sons&quot;');
    expect(email.subject).not.toMatch(/[\r\n]/);
  });

  describe('links', () => {
    it('are always on the configured web app', () => {
      expect(appLink(APP, '/invite?token=a b')).toBe('https://app.example.com/invite?token=a%20b');
      expect(appLink('http://localhost:5173', '/x')).toBe('http://localhost:5173/x');
    });

    it.each([
      ['a full URL', 'https://evil.test/invite?token=abc'],
      ['a protocol-relative URL', '//evil.test/invite'],
      ['a relative path', 'invite?token=abc'],
      ['a javascript URL', 'javascript:alert(1)'],
      ['a backslash trick', '/\\evil.test/invite'],
    ])('refuse %s', (_what, linkPath) => {
      expect(() => renderTemplate('invite', { ...invite, linkPath }, APP)).toThrow(
        /must (be a path|stay) on the web app/,
      );
    });
  });
});

describe('memory notifier', () => {
  it('records what would be sent, rendered', async () => {
    const notifier = createMemoryNotifier(APP);
    await notifier.send({ to: 'nurse@sample-hospital.test', template: 'invite', data: invite });
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({
      to: 'nurse@sample-hospital.test',
      template: 'invite',
      subject: 'You have been invited to Sample Hospital on Mediflow',
    });
  });

  it.each([
    ['two addresses', 'a@x.test, b@y.test'],
    ['a display name', 'Mallory <m@evil.test>'],
    ['a header injection', 'a@x.test\r\nBcc: m@evil.test'],
    ['not an address', 'nurse'],
    ['an empty string', ''],
  ])('refuses %s as the recipient', async (_what, to) => {
    const notifier = createMemoryNotifier(APP);
    await expect(notifier.send({ to, template: 'password_reset', data: reset })).rejects.toThrow(
      NotifierError,
    );
    expect(notifier.sent).toEqual([]);
  });
});

/**
 * Real delivery, to Mailpit (docker compose up -d, or the service container in CI). Mailpit's
 * HTTP API sits next to its SMTP port and lets the test read what arrived.
 */
describe('SMTP notifier with Mailpit', () => {
  const config = testConfig();
  const mailpitApi = `http://${new URL(config.SMTP_URL).hostname}:8025/api/v1`;
  const notifier = createSmtpNotifier(config);
  // A recipient unique to this run, so the test finds its own messages and nobody else's.
  const recipient = `staff-${randomUUID()}@notifier.test`;
  const received: string[] = [];

  afterAll(async () => {
    await notifier.close();
    if (received.length > 0) {
      await fetch(`${mailpitApi}/messages`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ IDs: received }),
      });
    }
  });

  interface MailpitMessage {
    ID: string;
    Subject: string;
    From: { Address: string; Name: string };
    To: { Address: string }[];
    Bcc: unknown[] | null;
    Cc: unknown[] | null;
  }

  async function arrived(expected: number): Promise<MailpitMessage[]> {
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await fetch(
        `${mailpitApi}/search?query=${encodeURIComponent(`to:${recipient}`)}`,
      );
      const { messages } = (await response.json()) as { messages: MailpitMessage[] };
      if (messages.length >= expected) {
        for (const message of messages)
          if (!received.includes(message.ID)) received.push(message.ID);
        return messages;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Expected ${expected} email(s) for ${recipient} in Mailpit`);
  }

  it('delivers the invite and the password reset', async () => {
    await notifier.send({ to: recipient, template: 'invite', data: invite });
    await notifier.send({ to: recipient, template: 'password_reset', data: reset });

    const messages = await arrived(2);
    expect(messages.map((message) => message.Subject).sort()).toEqual([
      'Reset your Mediflow password',
      'You have been invited to Sample Hospital on Mediflow',
    ]);
    for (const message of messages) {
      expect(message.To.map((to) => to.Address)).toEqual([recipient]);
      expect(message.From.Address).toBe('no-reply@mediflow.test');
      expect(message.Cc ?? []).toEqual([]);
      expect(message.Bcc ?? []).toEqual([]);
    }

    // Both parts arrive, and the link points at the configured web app.
    const inviteMessage = messages.find((message) => message.Subject.includes('invited'));
    const detail = (await (await fetch(`${mailpitApi}/message/${inviteMessage?.ID}`)).json()) as {
      Text: string;
      HTML: string;
    };
    const link = `${config.APP_BASE_URL}/invite?token=abc123`;
    expect(detail.Text).toContain(link);
    expect(detail.HTML).toContain(`<a href="${link}">`);
  });

  it('fails with a plain error that does not quote the server or the recipient', async () => {
    const unreachable = createSmtpNotifier({ ...config, SMTP_URL: 'smtp://127.0.0.1:1' });
    const error = await unreachable
      .send({ to: recipient, template: 'password_reset', data: reset })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    await unreachable.close();
    expect(error).toBeInstanceOf(NotifierError);
    expect((error as Error).message).toBe('Could not send the password_reset email');
    expect((error as Error).message).not.toContain(recipient);
    // The underlying reason is kept for whoever handles the failure.
    expect((error as Error).cause).toBeInstanceOf(Error);
  });
});

describe('app.notifier', () => {
  it('is the SMTP notifier by default and can be replaced for tests', async () => {
    const memory = createMemoryNotifier(APP);
    const app = await buildTestApp({ notifier: memory });
    try {
      expect(app.notifier).toBe(memory);
      await app.notifier.send({
        to: 'doctor@sample-hospital.test',
        template: 'password_reset',
        data: reset,
      });
      expect(memory.sent).toHaveLength(1);
    } finally {
      await app.close();
    }

    const real = await buildTestApp();
    try {
      expect(real.notifier).not.toBe(memory);
      expect(typeof real.notifier.send).toBe('function');
    } finally {
      await real.close();
    }
  });
});
