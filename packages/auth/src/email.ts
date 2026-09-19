/**
 * Outbound email.
 *
 * A port, because the sender is a vendor decision and because the governed
 * behaviour above it must be testable without a network or an account.
 *
 * Nothing here composes marketing. It sends the small number of transactional
 * messages the product cannot work without: a password reset, a sign-in
 * notification, and each of those has a security property attached to it, not
 * a conversion rate.
 */

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  /** Plain text. Always present: some clients show nothing else. */
  readonly text: string;
  readonly html?: string;
  /** Groups related sends for suppression and diagnosis. */
  readonly tag: 'password_reset' | 'password_changed' | 'welcome' | 'security_alert';
}

export interface EmailSender {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/**
 * Writes the message to the console instead of sending it.
 *
 * For development, and deliberately loud: an email that silently goes nowhere
 * is worse than one that fails, because the flow looks like it worked.
 */
export class ConsoleEmailSender implements EmailSender {
  readonly name = 'console';
  readonly sent: EmailMessage[] = [];

  constructor(private readonly log: (line: string) => void = console.log) {}

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    this.log([
      '',
      '  ---- email (not actually sent) ----',
      `  to       ${message.to}`,
      `  subject  ${message.subject}`,
      '',
      message.text.split('\n').map((line) => `  ${line}`).join('\n'),
      '  -----------------------------------',
      '',
    ].join('\n'));
  }
}

/** Collects messages without printing. For tests. */
export class MemoryEmailSender implements EmailSender {
  readonly name = 'memory';
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
  lastTo(address: string): EmailMessage | undefined {
    return [...this.sent].reverse().find((message) => message.to === address.toLowerCase());
  }
}

/**
 * Refuses to send, loudly.
 *
 * The default when no sender is configured. A password reset that appears to
 * work and sends nothing leaves a customer waiting for an email that will never
 * arrive, and they blame the product rather than the configuration.
 */
export class UnconfiguredEmailSender implements EmailSender {
  readonly name = 'unconfigured';
  async send(message: EmailMessage): Promise<void> {
    throw new Error(
      `Cannot send "${message.subject}" to ${message.to}: ` +
      'no email sender is configured. Set one before enabling password reset.',
    );
  }
}
