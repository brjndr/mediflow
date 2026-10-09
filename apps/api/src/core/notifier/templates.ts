/**
 * Staff email templates. Emails go to staff only (CLAUDE.md: the system does not contact
 * patients in v1), and each carries the minimum: who it is from, one link, and when the link
 * stops working. No patient data, no clinical detail, nothing that needs protecting in an inbox
 * beyond the link itself.
 */

export interface TemplateData {
  /** A hospital admin invited someone to join their hospital. */
  invite: {
    hospitalName: string;
    /** Path and query on the web app, e.g. `/invite?token=...`. Never a full URL. */
    linkPath: string;
    expiresInHours: number;
  };
  /** Someone asked to reset the password of this account. */
  password_reset: {
    linkPath: string;
    expiresInMinutes: number;
  };
}

export type TemplateName = keyof TemplateData;

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Header values must be one line, or a name could smuggle in extra headers. */
const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();

/**
 * The absolute link for an email. The origin always comes from configuration: a template is only
 * ever given a path, so nothing a user typed can point the link at another site.
 */
export function appLink(appBaseUrl: string, linkPath: string): string {
  if (!linkPath.startsWith('/') || linkPath.startsWith('//')) {
    throw new Error('An email link must be a path on the web app, starting with a single "/"');
  }
  const url = new URL(linkPath, appBaseUrl);
  if (url.origin !== new URL(appBaseUrl).origin) {
    throw new Error('An email link must stay on the web app');
  }
  return url.href;
}

function layout(paragraphs: string[], link: { href: string; label: string }, footer: string) {
  const text = [...paragraphs, link.href, footer].join('\n\n');
  const html = [
    '<!doctype html>',
    '<html lang="en"><body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1f2937">',
    ...paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
    `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>`,
    `<p style="color: #6b7280; font-size: 14px">${escapeHtml(footer)}</p>`,
    '</body></html>',
  ].join('\n');
  return { text, html };
}

const renderers: {
  [Name in TemplateName]: (data: TemplateData[Name], appBaseUrl: string) => RenderedEmail;
} = {
  invite(data, appBaseUrl) {
    const hospital = oneLine(data.hospitalName);
    return {
      subject: `You have been invited to ${hospital} on Mediflow`,
      ...layout(
        [
          `You have been invited to join ${hospital} on Mediflow.`,
          'Use the link below to set your password and sign in.',
        ],
        { href: appLink(appBaseUrl, data.linkPath), label: 'Accept the invitation' },
        `This link works once and expires in ${data.expiresInHours} hours. If you were not expecting it, you can ignore this email.`,
      ),
    };
  },
  password_reset(data, appBaseUrl) {
    return {
      subject: 'Reset your Mediflow password',
      ...layout(
        [
          'We received a request to reset the password of your Mediflow account.',
          'Use the link below to choose a new password.',
        ],
        { href: appLink(appBaseUrl, data.linkPath), label: 'Reset your password' },
        `This link works once and expires in ${data.expiresInMinutes} minutes. If you did not ask for this, you can ignore this email and your password stays as it is.`,
      ),
    };
  },
};

export function renderTemplate<Name extends TemplateName>(
  template: Name,
  data: TemplateData[Name],
  appBaseUrl: string,
): RenderedEmail {
  return renderers[template](data, appBaseUrl);
}
