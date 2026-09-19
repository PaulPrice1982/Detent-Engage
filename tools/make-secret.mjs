/**
 * Prints one secret, correctly formed, and nothing else.
 *
 * `openssl rand -base64 32` is the usual advice and it has two problems on a
 * hosted container. Openssl is not guaranteed to be installed, and when it is
 * missing the shell prints "command not found", which does not look like the
 * answer to "what do I paste". And the output of a working command sits on the
 * line after the command, so on a phone the wrong line gets selected. Pasting
 * the command instead of its output does not fail loudly: base64 decoding
 * ignores every character that is not base64, so it decodes to fifteen bytes
 * and looks like a key that is merely too short.
 *
 * This uses Node, which is always present because the application is written in
 * it, and prints the value alone on one line with nothing to select around.
 *
 *   node tools/make-secret.mjs                  a credential key
 *   node tools/make-secret.mjs session          a session secret
 *
 * Never commit what it prints, never paste it into a chat or an issue, and use
 * a different one for each secret: one signs cookies and the other encrypts a
 * customer's CRM token, and a key used for two purposes is weaker than two keys.
 */
import { randomBytes } from 'node:crypto';

const kind = (process.argv[2] ?? 'credential').toLowerCase();

if (kind === 'session') {
  // Hex rather than base64: the session secret needs 32 characters and this is
  // 64, so it clears the check with nothing to think about, and hex has no
  // trailing "=" that a careless selection can drop.
  process.stdout.write(`${randomBytes(32).toString('hex')}\n`);
} else {
  // Exactly 32 bytes, which is what AES-256 takes, printed as the 44 characters
  // of base64 that DETENT_CREDENTIAL_KEY is checked against.
  process.stdout.write(`${randomBytes(32).toString('base64')}\n`);
}
