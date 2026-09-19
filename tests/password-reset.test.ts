import { describe, expect, it } from 'vitest';
import { FixedClock } from '@detent/awa-core';
import {
  ConsoleEmailSender, InMemoryResetTokenStore, InMemorySessionStore, InMemoryUserStore,
  MemoryEmailSender, PasswordResetService, RESET_REQUESTS_PER_HOUR, SessionService,
  UnconfiguredEmailSender, UserService, hashToken,
} from '@detent/awa-auth';

const PASSWORD = 'correct horse battery staple';
const LINK = { baseUrl: 'https://app.detent.io', path: '/app/reset' };

function build(iso = '2026-03-01T09:00:00.000Z') {
  const clock = new FixedClock(new Date(iso));
  const users = new UserService(new InMemoryUserStore(), clock);
  const sessions = new SessionService(new InMemorySessionStore(), 'x'.repeat(48), clock);
  const email = new MemoryEmailSender();
  const tokens = new InMemoryResetTokenStore();
  const reset = new PasswordResetService(tokens, users, sessions, email, clock);
  return { clock, users, sessions, email, tokens, reset };
}

async function withUser(harness: ReturnType<typeof build>) {
  const user = await harness.users.create({
    realm: 'app', email: 'sam@vertex.example', name: 'Sam Adler',
    password: PASSWORD, roles: ['owner'], tenantId: 't_vertex',
  });
  return user;
}

/** Pulls the token out of the link in the email. */
const tokenFrom = (email: MemoryEmailSender, address: string): string => {
  const message = email.lastTo(address);
  return /token=([A-Za-z0-9_-]+)/.exec(message?.text ?? '')?.[1] ?? '';
};

describe('requesting a reset', () => {
  it('sends a link with a one-time token', async () => {
    const harness = build();
    await withUser(harness);
    await harness.reset.request({ realm: 'app', email: 'sam@vertex.example', link: LINK });
    const message = harness.email.lastTo('sam@vertex.example');
    expect(message?.tag).toBe('password_reset');
    expect(message?.text).toContain('https://app.detent.io/app/reset?token=');
  });

  it('says nothing and sends nothing for an address with no account', async () => {
    // A reset form that distinguishes the two is a free tool for confirming
    // which of a leaked address list are customers.
    const harness = build();
    await withUser(harness);
    await expect(harness.reset.request({
      realm: 'app', email: 'nobody@nowhere.example', link: LINK,
    })).resolves.toBeUndefined();
    expect(harness.email.sent.length).toBe(0);
  });

  it('sends nothing for a disabled account', async () => {
    const harness = build();
    const user = await withUser(harness);
    await harness.users.setActive(user.userId, false);
    await harness.reset.request({ realm: 'app', email: 'sam@vertex.example', link: LINK });
    expect(harness.email.sent.length).toBe(0);
  });

  it('will not reset an account in another realm', async () => {
    // A console reset must never be able to set a customer's password.
    const harness = build();
    await withUser(harness);
    await harness.reset.request({ realm: 'console', email: 'sam@vertex.example', link: LINK });
    expect(harness.email.sent.length).toBe(0);
  });

  it('stores only a hash of the token', async () => {
    // Anyone reading a backup or a support tool otherwise holds a live key to
    // every account with a pending reset.
    const harness = build();
    await withUser(harness);
    await harness.reset.request({ realm: 'app', email: 'sam@vertex.example', link: LINK });
    const token = tokenFrom(harness.email, 'sam@vertex.example');
    expect(await harness.tokens.find(token)).toBeUndefined();
    expect(await harness.tokens.find(hashToken(token))).toBeDefined();
  });

  it('invalidates the previous link when a new one is requested', async () => {
    // Otherwise every link ever sent stays live until it expires, and a
    // forwarded old email is as good as the newest.
    const harness = build();
    await withUser(harness);
    await harness.reset.request({ realm: 'app', email: 'sam@vertex.example', link: LINK });
    const first = tokenFrom(harness.email, 'sam@vertex.example');
    await harness.reset.request({ realm: 'app', email: 'sam@vertex.example', link: LINK });
    const second = tokenFrom(harness.email, 'sam@vertex.example');

    expect(second).not.toBe(first);
    expect((await harness.reset.check('app', first)).valid).toBe(false);
    expect((await harness.reset.check('app', second)).valid).toBe(true);
  });

  it('stops sending after too many requests in an hour', async () => {
    // So nobody can bury an account owner in reset emails.
    const harness = build();
    await withUser(harness);
    for (let attempt = 0; attempt < RESET_REQUESTS_PER_HOUR + 3; attempt += 1) {
      await harness.reset.request({ realm: 'app', email: 'sam@vertex.example', link: LINK });
    }
    expect(harness.email.sent.length).toBe(RESET_REQUESTS_PER_HOUR);
  });

  it('is case-insensitive on the address', async () => {
    const harness = build();
    await withUser(harness);
    await harness.reset.request({ realm: 'app', email: 'SAM@VERTEX.EXAMPLE', link: LINK });
    expect(harness.email.sent.length).toBe(1);
  });
});

describe('completing a reset', () => {
  const requested = async () => {
    const harness = build();
    const user = await withUser(harness);
    await harness.reset.request({ realm: 'app', email: 'sam@vertex.example', link: LINK });
    return { ...harness, user, token: tokenFrom(harness.email, 'sam@vertex.example') };
  };

  it('sets the new password', async () => {
    const harness = await requested();
    await harness.reset.complete({
      realm: 'app', token: harness.token, newPassword: 'a completely different phrase',
    });
    expect((await harness.users.login('app', 'sam@vertex.example', 'a completely different phrase')).ok)
      .toBe(true);
    expect((await harness.users.login('app', 'sam@vertex.example', PASSWORD)).ok).toBe(false);
  });

  it('spends the token, so the link cannot be used twice', async () => {
    const harness = await requested();
    await harness.reset.complete({
      realm: 'app', token: harness.token, newPassword: 'a completely different phrase',
    });
    await expect(harness.reset.complete({
      realm: 'app', token: harness.token, newPassword: 'another different phrase entirely',
    })).rejects.toThrow(/no longer valid/i);
  });

  it('ends every session, because a reset is often a response to a compromise', async () => {
    const harness = await requested();
    const { token: sessionToken } = await harness.sessions.start({
      userId: harness.user.userId, realm: 'app',
    });
    expect(await harness.sessions.resolve('app', sessionToken)).toBeDefined();

    await harness.reset.complete({
      realm: 'app', token: harness.token, newPassword: 'a completely different phrase',
    });
    // Leaving the attacker's session alive defeats the point of resetting.
    expect(await harness.sessions.resolve('app', sessionToken)).toBeUndefined();
  });

  it('tells the account holder afterwards', async () => {
    // Somebody whose password was changed without their knowledge needs to
    // know immediately; this is the message that surfaces a takeover.
    const harness = await requested();
    await harness.reset.complete({
      realm: 'app', token: harness.token, newPassword: 'a completely different phrase',
    });
    expect(harness.email.sent.some((message) => message.tag === 'password_changed')).toBe(true);
  });

  it('clears a lockout, since the mailbox has just been proved', async () => {
    const harness = await requested();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await harness.users.login('app', 'sam@vertex.example', 'wrong password entirely');
    }
    await harness.reset.complete({
      realm: 'app', token: harness.token, newPassword: 'a completely different phrase',
    });
    expect((await harness.users.login('app', 'sam@vertex.example', 'a completely different phrase')).ok)
      .toBe(true);
  });

  it('gives one message for every way a token can be unusable', async () => {
    // Distinguishing wrong from expired from spent tells an attacker which
    // tokens exist.
    const harness = await requested();
    await expect(harness.reset.complete({
      realm: 'app', token: 'not-a-real-token', newPassword: 'a completely different phrase',
    })).rejects.toThrow(/no longer valid/i);
  });

  it('refuses a token expired by time', async () => {
    const harness = await requested();
    harness.clock.advance(46 * 60_000);
    await expect(harness.reset.complete({
      realm: 'app', token: harness.token, newPassword: 'a completely different phrase',
    })).rejects.toThrow(/no longer valid/i);
  });

  it('refuses a token presented to the wrong realm', async () => {
    const harness = await requested();
    await expect(harness.reset.complete({
      realm: 'console', token: harness.token, newPassword: 'a completely different phrase',
    })).rejects.toThrow(/no longer valid/i);
  });

  it('does not spend the token on a password that is too weak', async () => {
    // Making somebody request a new link because they mistyped is how a reset
    // flow gets abandoned.
    const harness = await requested();
    await expect(harness.reset.complete({
      realm: 'app', token: harness.token, newPassword: 'short',
    })).rejects.toThrow(/12 characters/i);
    expect((await harness.reset.check('app', harness.token)).valid).toBe(true);
  });

  it('refuses a password containing the account holder’s own details', async () => {
    const harness = await requested();
    await expect(harness.reset.complete({
      realm: 'app', token: harness.token, newPassword: 'vertex example 2026 pw',
    })).rejects.toThrow();
  });
});

describe('checking a link before showing the form', () => {
  it('reports an expired link without spending it', async () => {
    // So an expired link says so, rather than collecting a new password and
    // then refusing it.
    const harness = build();
    await withUser(harness);
    await harness.reset.request({ realm: 'app', email: 'sam@vertex.example', link: LINK });
    const token = tokenFrom(harness.email, 'sam@vertex.example');
    expect((await harness.reset.check('app', token)).valid).toBe(true);
    harness.clock.advance(46 * 60_000);
    expect((await harness.reset.check('app', token)).valid).toBe(false);
  });

  it('reports an unknown token as invalid', async () => {
    const harness = build();
    expect((await harness.reset.check('app', 'nonsense')).valid).toBe(false);
  });
});

describe('the email senders', () => {
  it('refuses to send when none is configured, rather than pretending', async () => {
    // A reset that appears to work and sends nothing leaves a customer waiting
    // for an email that will never arrive, and they blame the product.
    await expect(new UnconfiguredEmailSender().send({
      to: 'a@b.co', subject: 's', text: 't', tag: 'password_reset',
    })).rejects.toThrow(/no email sender is configured/i);
  });

  it('prints a message rather than sending it, in development', async () => {
    const lines: string[] = [];
    const sender = new ConsoleEmailSender((line) => lines.push(line));
    await sender.send({ to: 'a@b.co', subject: 'Reset', text: 'link', tag: 'password_reset' });
    expect(lines.join('')).toContain('not actually sent');
    expect(sender.sent.length).toBe(1);
  });
});
