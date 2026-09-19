/**
 * Public mailbox domains, for follow-up jurisdiction resolution.
 *
 * Separate from the identity package's list so that the follow-up engine does
 * not take a dependency on identity resolution: the two answer different
 * questions and should be able to diverge.
 */
export const PUBLIC_MAILBOX_DOMAINS_FOR_FOLLOWUP: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk',
  'live.com', 'live.co.uk', 'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com',
  'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'msn.com',
  'btinternet.com', 'sky.com', 'talktalk.net', 'virginmedia.com',
  'yandex.com', 'fastmail.com', 'tutanota.com', 'hey.com',
]);
