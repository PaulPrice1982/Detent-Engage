import type { Realm } from '@detent/awa-auth';
import { escape, page } from './site-html.js';

/**
 * Sign-in and sign-up screens for both sites.
 *
 * Shared markup, separate realms. The two sites look like siblings because they
 * are, but nothing an unauthenticated visitor can do on one reaches the other.
 *
 * The console's screen deliberately says nothing about what is behind it. An
 * end user who finds the URL learns that Detent staff sign in there, and not
 * which customers exist, how many, or what the tool does.
 */

const FORM_STYLES = `
<style>
  body { background: #0F1B2A; }
  main { max-width: 420px; padding-top: 8vh; }
  .auth { background: #fff; border-radius: 12px; padding: 30px 30px 26px;
          box-shadow: 0 20px 60px rgb(0 0 0 / .35); }
  .auth h1 { font-size: 20px; margin: 0 0 6px; }
  .auth p.sub { margin: 0 0 22px; font-size: 13.5px; }
  label { display: block; font-size: 12.5px; font-weight: 600; color: #5B6B7F;
          margin: 0 0 5px; text-transform: uppercase; letter-spacing: .05em; }
  input[type=email], input[type=password], input[type=text] {
    width: 100%; padding: 10px 12px; font-size: 15px; border: 1px solid #E3E8EF;
    border-radius: 8px; margin-bottom: 15px; font-family: inherit; color: #0F1B2A;
  }
  input:focus { outline: 2px solid #1B5FA8; outline-offset: 1px; border-color: #1B5FA8; }
  button.submit { width: 100%; padding: 11px; font-size: 15px; font-weight: 600;
    border: 0; border-radius: 8px; background: #0F1B2A; color: #fff; cursor: pointer; }
  button.submit:hover { background: #1B2A3D; }
  .error { background: #FCEBEB; border: 1px solid #F3C9C9; color: #A32A2A;
           border-radius: 8px; padding: 10px 13px; margin-bottom: 18px; font-size: 13.5px; }
  .note { color: #5B6B7F; font-size: 12.5px; margin-top: 16px; text-align: center; }
  .note a { color: #1B5FA8; }
  .hint-box { margin-top: 18px; padding: 12px 14px; background: #FDF3E5;
              border: 1px solid #F3DDBB; border-radius: 8px; color: #8A5A16;
              font-size: 12.5px; line-height: 1.5; }
  .hint-box b { display: block; margin-bottom: 4px; }
  .hint-box code { background: #fff; border: 1px solid #F3DDBB; border-radius: 4px;
                   padding: 1px 4px; font-size: 12px; }
  .federated { margin-bottom: 4px; }
  .fed { display: flex; align-items: center; justify-content: center; gap: 9px;
         width: 100%; padding: 10px; margin-bottom: 9px; border-radius: 8px;
         border: 1px solid #D5DBE4; background: #fff; color: #0F1B2A;
         font-size: 14.5px; font-weight: 550; text-decoration: none; }
  .fed:hover { background: #F7F9FC; border-color: #5B6B7F; }
  .fed-apple { background: #000; border-color: #000; color: #fff; }
  .fed-apple:hover { background: #1a1a1a; border-color: #1a1a1a; }
  .divider { display: flex; align-items: center; gap: 12px; margin: 16px 0 14px;
             color: #5B6B7F; font-size: 12px; }
  .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: #E3E8EF; }
  footer { color: #5B6B7F; text-align: center; border: 0; }
</style>`;

export interface SignInPageOptions {
  readonly realm: Realm;
  readonly error?: string;
  readonly email?: string;
  readonly action: string;
  /** Shown on the customer app only. */
  readonly signUpHref?: string;
  /**
   * No operator account exists on this server. Says which secret to set, never
   * anything that could be a credential.
   */
  readonly operatorMissing?: boolean;
  readonly forgotHref?: string;
  /** Providers offered. Empty means none is configured. */
  readonly federated?: readonly FederatedOption[];
}

export interface FederatedOption {
  readonly id: 'google' | 'apple';
  readonly label: string;
  readonly href: string;
  /**
   * False when the provider has no credentials configured. The button is still
   * shown, and says so on click: hiding it would leave somebody wondering
   * whether the feature exists, and a silent absence is harder to diagnose than
   * an explicit "not configured yet".
   */
  readonly configured: boolean;
}

export function signInPage(options: SignInPageOptions): string {
  const isConsole = options.realm === 'console';
  const title = isConsole ? 'Back office sign in' : 'Sign in';
  const body = `${FORM_STYLES}
<div class="auth">
  <h1>${escape(isConsole ? 'Detent back office' : 'Sign in to Detent')}</h1>
  <p class="sub">${escape(isConsole
    ? 'Staff access. All activity is recorded.'
    : 'Manage your assistant, your plan and your billing.')}</p>
  ${options.error ? `<div class="error">${escape(options.error)}</div>` : ''}
  <form method="post" action="${escape(options.action)}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username"
           required value="${escape(options.email ?? '')}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button class="submit" type="submit">Sign in</button>
  </form>
  ${federatedBlock(options.federated)}
  <p class="note"><a href="${escape(options.forgotHref ?? '#')}">Forgotten your password?</a></p>
  ${options.signUpHref
    ? `<p class="note">No account yet? <a href="${escape(options.signUpHref)}">Create one</a></p>`
    : ''}
  ${options.operatorMissing ? `<div class="hint-box">
    <b>No account is configured on this server.</b>
    Set <code>DETENT_CONSOLE_PASSWORD</code> in your host's secrets, on Replit,
    Tools &rarr; Secrets, then restart. Nothing is generated and no password is
    written anywhere: the secret is the only place it exists.
  </div>` : ''}
</div>`;
  return page({ title, site: isConsole ? 'console' : 'app' }, body);
}

export interface SignUpPageOptions {
  readonly action: string;
  readonly error?: string;
  readonly values?: Readonly<Record<string, string>>;
  readonly signInHref: string;
  readonly federated?: readonly FederatedOption[];
}

/** Google and Apple buttons, drawn to each brand's guidelines. */
function federatedBlock(
  options: readonly FederatedOption[] | undefined,
  verb = 'Continue with',
): string {
  if (!options || options.length === 0) return '';
  const marks: Readonly<Record<string, string>> = {
    google: `<svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M45 24c0-1.6-.1-2.7-.4-3.9H24v7.1h12c-.2 1.9-1.5 4.7-4.4 6.6l6.7 5.2C42.2 35.3 45 30.1 45 24z"/><path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.9-5.4c-1.8 1.3-4.3 2.2-7.6 2.2-5.8 0-10.8-3.8-12.5-9.1l-7.1 5.5C8 41.1 15.4 46 24 46z"/><path fill="#FBBC05" d="M11.5 28.4c-.5-1.3-.7-2.8-.7-4.4s.3-3 .7-4.4l-7.1-5.5C2.9 17 2 20.4 2 24s.9 7 2.4 9.9l7.1-5.5z"/><path fill="#EA4335" d="M24 10.7c4.1 0 6.9 1.8 8.5 3.3l6.2-6C34.9 4.6 29.9 2 24 2 15.4 2 8 6.9 4.4 14.1l7.1 5.5C13.2 14.4 18.2 10.7 24 10.7z"/></svg>`,
    apple: `<svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M16.4 12.7c0-2.6 2.1-3.9 2.2-4-1.2-1.8-3.1-2-3.8-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.3-.9-1.7 0-3.3 1-4.2 2.5-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.5 1.3-.1 1.8-.8 3.4-.8s2 .8 3.3.8c1.4 0 2.3-1.2 3.1-2.5.6-.9 1-1.8 1.3-2.7-2.1-.8-2.6-2.8-2.6-4zM14 4.6c.7-.9 1.2-2.1 1.1-3.3-1 0-2.3.7-3 1.6-.7.8-1.3 2-1.1 3.2 1.1.1 2.3-.6 3-1.5z"/></svg>`,
  };
  return `<div class="federated">
  ${options.map((option) => `<a class="fed fed-${escape(option.id)}"
      href="${escape(option.href)}"${option.configured ? '' : ' data-unconfigured="true"'}>
    ${marks[option.id] ?? ''}<span>${escape(verb)} ${escape(option.label)}</span></a>`).join('')}
  <div class="divider"><span>or</span></div>
</div>`;
}

/**
 * Customer sign-up.
 *
 * There is no equivalent for the console: staff accounts are provisioned by
 * someone who already has one. Self-service registration into the back office
 * would be a way to grant yourself access to every customer's money.
 */
export function signUpPage(options: SignUpPageOptions): string {
  const value = (key: string) => escape(options.values?.[key] ?? '');
  const body = `${FORM_STYLES}
<div class="auth">
  <h1>Create your account</h1>
  <p class="sub">You will be the first user on the account and can invite colleagues afterwards.</p>
  ${options.error ? `<div class="error">${escape(options.error)}</div>` : ''}
  ${federatedBlock(options.federated, 'Sign up with')}
  <form method="post" action="${escape(options.action)}">
    <label for="organisation">Organisation</label>
    <input id="organisation" name="organisation" type="text" required value="${value('organisation')}">
    <label for="name">Your name</label>
    <input id="name" name="name" type="text" autocomplete="name" required value="${value('name')}">
    <label for="email">Work email</label>
    <input id="email" name="email" type="email" autocomplete="username" required value="${value('email')}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="new-password" required
           minlength="12">
    <p class="note" style="text-align:left;margin:-8px 0 15px">
      At least 12 characters. Length matters more than symbols.</p>
    <button class="submit" type="submit">Create account</button>
  </form>
  <p class="note">Already have one? <a href="${escape(options.signInHref)}">Sign in</a></p>
</div>`;
  return page({ title: 'Create an account', site: 'app' }, body);
}

/**
 * What a failed sign-in says.
 *
 * One message for a wrong password and an unknown address alike, because
 * telling someone the address was right is telling them half the answer.
 * Lockout is stated plainly: hiding it just produces a support call.
 */
export function signInError(reason: 'invalid' | 'locked' | 'disabled'): string {
  switch (reason) {
    case 'locked':
      return 'Too many attempts. This account is locked for 15 minutes.';
    case 'disabled':
      return 'This account has been disabled. Contact your administrator.';
    default:
      return 'That email and password do not match.';
  }
}


/**
 * The "forgotten your password" form.
 *
 * The confirmation is the same whether or not the address has an account. A
 * reset form that says "no account with that address" is a free tool for
 * confirming which of a leaked list of addresses are customers.
 */
export function forgotPasswordPage(options: {
  readonly realm: Realm;
  readonly action: string;
  readonly signInHref: string;
  readonly sent?: boolean;
  readonly email?: string;
}): string {
  const body = `${FORM_STYLES}
<div class="auth">
  <h1>Reset your password</h1>
  ${options.sent
    ? `<p class="sub">If there is an account for
       <strong>${escape(options.email ?? 'that address')}</strong>, a reset link is on its way.
       It works once and expires in 45 minutes.</p>
       <p class="note">Nothing arrived? Check the spam folder, then
       <a href="${escape(options.action)}">try again</a>.</p>
       <p class="note"><a href="${escape(options.signInHref)}">Back to sign in</a></p>`
    : `<p class="sub">Enter the address you sign in with and we will send you a link.</p>
    <form method="post" action="${escape(options.action)}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required
             value="${escape(options.email ?? '')}">
      <button class="submit" type="submit">Send the link</button>
    </form>
    <p class="note"><a href="${escape(options.signInHref)}">Back to sign in</a></p>`}
</div>`;
  return page(
    { title: 'Reset your password', site: options.realm === 'console' ? 'console' : 'app' },
    body,
  );
}

/** The form behind a reset link. */
export function resetPasswordPage(options: {
  readonly realm: Realm;
  readonly action: string;
  readonly token: string;
  readonly signInHref: string;
  readonly forgotHref: string;
  readonly valid: boolean;
  readonly error?: string;
  readonly done?: boolean;
}): string {
  const site = options.realm === 'console' ? 'console' : 'app';

  if (options.done) {
    return page({ title: 'Password changed', site }, `${FORM_STYLES}
<div class="auth">
  <h1>Password changed</h1>
  <p class="sub">Every signed-in session has been ended, on every device.
  Sign in again with your new password.</p>
  <p class="note"><a href="${escape(options.signInHref)}">Sign in</a></p>
</div>`);
  }

  if (!options.valid) {
    // Checked before the form is shown, so an expired link says so rather than
    // collecting a new password and then refusing it.
    return page({ title: 'Link expired', site }, `${FORM_STYLES}
<div class="auth">
  <h1>That link is no longer valid</h1>
  <p class="sub">Reset links work once and expire after 45 minutes.</p>
  <p class="note"><a href="${escape(options.forgotHref)}">Send a new one</a></p>
</div>`);
  }

  return page({ title: 'Choose a new password', site }, `${FORM_STYLES}
<div class="auth">
  <h1>Choose a new password</h1>
  <p class="sub">At least 12 characters. Length matters more than symbols.</p>
  ${options.error ? `<div class="error">${escape(options.error)}</div>` : ''}
  <form method="post" action="${escape(options.action)}">
    <input type="hidden" name="token" value="${escape(options.token)}">
    <label for="password">New password</label>
    <input id="password" name="password" type="password" autocomplete="new-password"
           required minlength="12">
    <label for="confirm">Confirm it</label>
    <input id="confirm" name="confirm" type="password" autocomplete="new-password"
           required minlength="12">
    <button class="submit" type="submit">Set the password</button>
  </form>
</div>`);
}
