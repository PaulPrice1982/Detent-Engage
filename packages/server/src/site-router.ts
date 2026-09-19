import {
  cookieNameFor, csrfTokenFor, csrfValid, readCookie,
  type AuthUser, type Realm, type SessionService, type UserService,
} from '@detent/awa-auth';
import { brandMark } from './site-html.js';
import type { PasswordResetService } from '@detent/awa-auth';
import {
  forgotPasswordPage, resetPasswordPage, signInError, signInPage, signUpPage,
  type FederatedOption,
} from './auth-pages.js';

/**
 * The request shape a site handler sees, and the shape it returns.
 *
 * Kept small on purpose. A site is a function from a request to HTML or a
 * redirect; everything else, authentication, the realm check, CSRF, happens
 * in `SiteRouter` before the site is called, so no page can forget it.
 */
export interface SiteRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Record<string, string | undefined>;
  readonly rawBody?: string;
  /**
   * The body as bytes.
   *
   * A file upload is binary and does not survive being decoded as UTF-8, so a
   * multipart handler needs the original bytes rather than `rawBody`.
   */
  readonly rawBodyBuffer?: Buffer;
}

export interface SiteResponse {
  readonly status: number;
  readonly html?: string;
  readonly redirect?: string;
  readonly cookies?: readonly string[];
}

export interface AuthenticatedRequest extends SiteRequest {
  readonly user: AuthUser;
  readonly sessionId: string;
  readonly csrf: string;
  readonly form: Readonly<Record<string, string>>;
}

export type SiteHandler = (request: AuthenticatedRequest) => Promise<SiteResponse>;

/** Parses an application/x-www-form-urlencoded body. */
export function parseForm(rawBody: string | undefined): Readonly<Record<string, string>> {
  if (!rawBody) return {};
  const form: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(rawBody)) form[key] = value;
  return form;
}

export interface SiteRouterOptions {
  readonly realm: Realm;
  /** URL prefix, e.g. `/console`. */
  readonly prefix: string;
  readonly users: UserService;
  readonly sessions: SessionService;
  readonly secret: string;
  readonly handler: SiteHandler;
  /** Customer app only. Self-service into the back office is never offered. */
  readonly allowSignUp?: boolean;
  /** No operator account exists: the sign-in page says which secret to set. */
  readonly operatorMissing?: boolean;
  /** Enables reset by email. Omitted, the links are not offered. */
  readonly passwordReset?: PasswordResetService;
  /** Absolute base for the link in the email, e.g. https://app.detent.io. */
  readonly baseUrl?: string;
  /** Sign in with Google / Apple, when configured. */
  readonly federated?: readonly FederatedOption[];
  onSignUp?(form: Readonly<Record<string, string>>): Promise<AuthUser>;
  /** False in local development, where there is no TLS. */
  readonly secureCookies?: boolean;
}

/**
 * Authentication, session and CSRF for one site.
 *
 * Everything unauthenticated is refused before the site's own code runs. That
 * is the mechanism by which the back office is not visible to end users: there
 * is no page behind `/console` that renders without a live console session, and
 * a console session cannot be created from the customer app's login form
 * because the realm is part of both the credential lookup and the cookie.
 */
export class SiteRouter {
  constructor(private readonly options: SiteRouterOptions) {}

  private path(request: SiteRequest): string {
    const stripped = request.path.slice(this.options.prefix.length);
    return stripped === '' ? '/' : stripped;
  }

  private cookieToken(request: SiteRequest): string | undefined {
    // Read the name that matches how the cookie was set. Reading the secure
    // name on a plain-HTTP server finds nothing and looks like a failed login.
    const secure = this.options.secureCookies !== false;
    return readCookie(request.headers['cookie'], cookieNameFor(this.options.realm, secure));
  }

  async handle(request: SiteRequest): Promise<SiteResponse | undefined> {
    if (!request.path.startsWith(this.options.prefix)) return undefined;
    const path = this.path(request);
    const { realm, prefix } = this.options;
    const secure = this.options.secureCookies !== false;

    if (path === '/signout') {
      await this.options.sessions.end(this.cookieToken(request));
      return {
        status: 303,
        redirect: `${prefix}/signin`,
        cookies: [this.options.sessions.clearCookie(realm, { secure })],
      };
    }

    if (path === '/signin') return this.signIn(request, secure);
    if (path === '/signup') return this.signUp(request, secure);
    if (path.startsWith('/auth/')) return this.federatedStart(path);
    if (path === '/forgot') return this.forgot(request);
    if (path === '/reset') return this.reset(request);

    const session = await this.options.sessions.resolve(realm, this.cookieToken(request));
    if (!session) {
      // Redirect rather than 403: an unauthenticated visitor learns only that
      // there is a sign-in page here, not what is behind it.
      return { status: 303, redirect: `${prefix}/signin` };
    }
    const user = await this.options.users.byId(session.userId);
    if (!user || !user.active || user.realm !== realm) {
      await this.options.sessions.end(this.cookieToken(request));
      return {
        status: 303,
        redirect: `${prefix}/signin`,
        cookies: [this.options.sessions.clearCookie(realm, { secure })],
      };
    }

    const form = parseForm(request.rawBody);
    // A multipart body is not urlencoded, so its CSRF token is not in `form`.
    // The handler checks it after parsing the parts; skipping it here would
    // reject every upload rather than protect it.
    const isMultipart = (request.headers['content-type'] ?? '').startsWith('multipart/form-data');
    if (request.method === 'POST' && !isMultipart
        && !csrfValid(session.sessionId, this.options.secret, form['csrf'])) {
      // SameSite=Lax already blocks the cross-site POST. This is the second
      // control, because a form that moves money should not rest on one
      // attribute enforced only by the browser.
      return { status: 403, html: this.problem('That form has expired. Go back and try again.') };
    }

    return this.options.handler({
      ...request,
      user,
      sessionId: session.sessionId,
      csrf: csrfTokenFor(session.sessionId, this.options.secret),
      form,
    });
  }

  private async signIn(request: SiteRequest, secure: boolean): Promise<SiteResponse> {
    const { realm, prefix } = this.options;
    const action = `${prefix}/signin`;
    const signUpHref = this.options.allowSignUp ? `${prefix}/signup` : undefined;

    if (request.method !== 'POST') {
      // Already signed in? Go where they were heading.
      const existing = await this.options.sessions.resolve(realm, this.cookieToken(request));
      if (existing) return { status: 303, redirect: prefix };
      return {
        status: 200,
        html: signInPage({
          realm, action, signUpHref,
          operatorMissing: this.options.operatorMissing,
          forgotHref: this.options.passwordReset ? `${prefix}/forgot` : undefined,
          federated: this.options.federated,
        }),
      };
    }

    const form = parseForm(request.rawBody);
    const email = form['email'] ?? '';
    const outcome = await this.options.users.login(realm, email, form['password'] ?? '');
    if (!outcome.ok) {
      return {
        status: 401,
        html: signInPage({
          realm, action, signUpHref, email,
          error: signInError(outcome.reason),
          operatorMissing: this.options.operatorMissing,
          forgotHref: this.options.passwordReset ? `${prefix}/forgot` : undefined,
          federated: this.options.federated,
        }),
      };
    }

    const { token } = await this.options.sessions.start({
      userId: outcome.user.userId,
      realm,
      userAgent: request.headers['user-agent'],
    });
    return {
      status: 303,
      redirect: prefix,
      cookies: [this.options.sessions.cookie(realm, token, { secure })],
    };
  }

  private async signUp(request: SiteRequest, secure: boolean): Promise<SiteResponse> {
    const { realm, prefix } = this.options;
    if (!this.options.allowSignUp || !this.options.onSignUp) {
      // Self-service registration into the back office would be a way to grant
      // yourself access to every customer's money.
      return { status: 404, html: this.problem('Not found.') };
    }
    const action = `${prefix}/signup`;
    const signInHref = `${prefix}/signin`;
    if (request.method !== 'POST') {
      return {
        status: 200,
        html: signUpPage({ action, signInHref, federated: this.options.federated }),
      };
    }

    const form = parseForm(request.rawBody);
    try {
      const user = await this.options.onSignUp(form);
      const { token } = await this.options.sessions.start({ userId: user.userId, realm });
      return {
        status: 303,
        redirect: prefix,
        cookies: [this.options.sessions.cookie(realm, token, { secure })],
      };
    } catch (error) {
      return {
        status: 400,
        html: signUpPage({
          action, signInHref, values: form, federated: this.options.federated,
          error: error instanceof Error ? error.message : 'That did not work.',
        }),
      };
    }
  }

  /**
   * Requesting a link.
   *
   * The confirmation is identical whether or not the address has an account,
   * and the same work is done either way. A form that says "no account with
   * that address" is a free tool for testing a leaked address list.
   */
  private async forgot(request: SiteRequest): Promise<SiteResponse> {
    const { realm, prefix } = this.options;
    const reset = this.options.passwordReset;
    if (!reset) return { status: 404, html: this.problem('Not found.') };

    const action = `${prefix}/forgot`;
    const signInHref = `${prefix}/signin`;
    if (request.method !== 'POST') {
      return { status: 200, html: forgotPasswordPage({ realm, action, signInHref }) };
    }

    const form = parseForm(request.rawBody);
    const email = (form['email'] ?? '').trim();
    try {
      await reset.request({
        realm,
        email,
        link: { baseUrl: this.options.baseUrl ?? '', path: `${prefix}/reset` },
        ip: request.headers['x-forwarded-for'],
      });
    } catch {
      // A sender failure is not surfaced: it would distinguish an address that
      // exists from one that does not, which is exactly what this endpoint must
      // not do. It is logged by the sender itself.
    }
    return {
      status: 200,
      html: forgotPasswordPage({ realm, action, signInHref, sent: true, email }),
    };
  }

  /** Choosing a new password from a link. */
  private async reset(request: SiteRequest): Promise<SiteResponse> {
    const { realm, prefix } = this.options;
    const service = this.options.passwordReset;
    if (!service) return { status: 404, html: this.problem('Not found.') };

    const action = `${prefix}/reset`;
    const signInHref = `${prefix}/signin`;
    const forgotHref = `${prefix}/forgot`;

    if (request.method !== 'POST') {
      const token = request.query['token'] ?? '';
      const { valid } = await service.check(realm, token);
      return {
        status: valid ? 200 : 400,
        html: resetPasswordPage({ realm, action, token, signInHref, forgotHref, valid }),
      };
    }

    const form = parseForm(request.rawBody);
    const token = form['token'] ?? '';
    const password = form['password'] ?? '';
    if (password !== (form['confirm'] ?? '')) {
      return {
        status: 400,
        html: resetPasswordPage({
          realm, action, token, signInHref, forgotHref, valid: true,
          error: 'Those two passwords are not the same.',
        }),
      };
    }

    try {
      await service.complete({ realm, token, newPassword: password });
      return {
        status: 200,
        html: resetPasswordPage({
          realm, action, token, signInHref, forgotHref, valid: true, done: true,
        }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'That did not work.';
      // A token rejected for being spent or expired reopens the "send a new
      // one" page; a weak password keeps the form so the token is not wasted.
      const stillValid = !/no longer valid/i.test(message);
      return {
        status: 400,
        html: resetPasswordPage({
          realm, action, token, signInHref, forgotHref,
          valid: stillValid, error: message,
        }),
      };
    }
  }

  /**
   * Starts a provider sign-in, or explains why it cannot.
   *
   * An unconfigured provider gets a page saying exactly which secrets are
   * missing. A button that silently does nothing is the hardest kind of
   * failure to diagnose from the outside.
   */
  private async federatedStart(path: string): Promise<SiteResponse> {
    const id = path.replace('/auth/', '').replace(/\/.*$/, '');
    const option = this.options.federated?.find((candidate) => candidate.id === id);
    if (!option) return { status: 404, html: this.problem('Not found.') };
    if (!option.configured) {
      const secrets = id === 'google'
        ? 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET'
        : 'APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY';
      return {
        status: 503,
        html: this.problem(
          `Sign in with ${option.label} is not configured on this server. ` +
          `Set ${secrets} in the host's secrets, and register ` +
          `${this.options.baseUrl || '(your public URL)'}${this.options.prefix}/auth/${id}/callback ` +
          `as an authorised redirect URI with ${option.label}.`,
        ),
      };
    }
    // Configured: the redirect is built by the OIDC layer, which needs the
    // provider config held outside this router.
    return { status: 303, redirect: `${this.options.prefix}/signin?federated=${id}` };
  }

  private problem(message: string): string {
    return `<!doctype html><meta charset="utf-8"><title>Detent</title>
<body style="margin:0;background:#0F1B2A;color:#fff;font:15px/1.6 system-ui">
<div style="max-width:560px;margin:0 auto;padding:12vh 24px">
  <a href="${this.options.prefix}" style="color:#EFA13C;text-decoration:none;font-weight:650">
    ${brandMark()}Detent</a>
  <p style="margin:22px 0 0;font-size:16px">${message}</p>
  <p style="margin:22px 0 0"><a href="${this.options.prefix}"
     style="color:#A9B7C8">Back</a></p>
</div></body>`;
  }
}
