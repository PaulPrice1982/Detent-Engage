import type { EmailMessage, EmailSender } from './email.js';

/**
 * Email over HTTP.
 *
 * HTTP rather than SMTP: an API call is one request with a status code, where
 * SMTP is a stateful conversation with a dozen failure modes, and every hosting
 * platform worth using blocks outbound port 25 anyway.
 *
 * Two providers, because their request shapes differ trivially and supporting
 * both costs almost nothing. Anything else implements `EmailSender` directly.
 */

export type EmailProviderId = 'resend' | 'postmark';

export interface HttpEmailOptions {
  readonly provider: EmailProviderId;
  readonly apiKey: string;
  /** The From address. Must be on a domain verified with the provider. */
  readonly from: string;
  readonly replyTo?: string;
  /** Injected so this is testable without a network. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export class HttpEmailSender implements EmailSender {
  readonly name: string;

  constructor(private readonly options: HttpEmailOptions) {
    this.name = options.provider;
    if (!options.apiKey) throw new Error(`${options.provider} needs an API key.`);
    if (!options.from) throw new Error(`${options.provider} needs a From address.`);
  }

  async send(message: EmailMessage): Promise<void> {
    const send = this.options.fetchImpl ?? fetch;
    const { url, headers, body } = this.request(message);

    const response = await send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // The body carries the reason: an unverified sending domain, a
      // suppressed address, and it is the thing worth reading. The API key is
      // in a header and never in this message.
      const detail = await response.text().catch(() => '');
      throw new Error(
        `${this.options.provider} refused to send "${message.subject}" ` +
        `(HTTP ${response.status}): ${detail.slice(0, 300)}`,
      );
    }
  }

  private request(message: EmailMessage): {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  } {
    if (this.options.provider === 'postmark') {
      return {
        url: 'https://api.postmarkapp.com/email',
        headers: { 'x-postmark-server-token': this.options.apiKey, accept: 'application/json' },
        body: {
          From: this.options.from,
          To: message.to,
          Subject: message.subject,
          TextBody: message.text,
          HtmlBody: message.html,
          ReplyTo: this.options.replyTo,
          // Groups sends for suppression and diagnosis at the provider.
          MessageStream: 'outbound',
          Tag: message.tag,
        },
      };
    }
    return {
      url: 'https://api.resend.com/emails',
      headers: { authorization: `Bearer ${this.options.apiKey}` },
      body: {
        from: this.options.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
        reply_to: this.options.replyTo,
        tags: [{ name: 'kind', value: message.tag }],
      },
    };
  }
}

/**
 * Builds a sender from the environment, or returns undefined.
 *
 * Undefined rather than a working-looking stub: the caller decides what to do
 * when email is unconfigured, and the one thing it must not do is appear to
 * send.
 */
export function senderFromEnvironment(env: Record<string, string | undefined>): EmailSender | undefined {
  const provider = env['DETENT_EMAIL_PROVIDER']?.trim().toLowerCase();
  const apiKey = env['DETENT_EMAIL_API_KEY']?.trim();
  const from = env['DETENT_EMAIL_FROM']?.trim();
  if (!provider || !apiKey || !from) return undefined;
  if (provider !== 'resend' && provider !== 'postmark') return undefined;
  return new HttpEmailSender({
    provider,
    apiKey,
    from,
    replyTo: env['DETENT_EMAIL_REPLY_TO']?.trim(),
  });
}
