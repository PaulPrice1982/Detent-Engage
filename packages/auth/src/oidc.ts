import { createHash, createPublicKey, createVerify, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Sign in with Google and Sign in with Apple.
 *
 * Both are OpenID Connect, and both are usually integrated wrongly in the same
 * three ways. Each is guarded here, and each has a comment saying what goes
 * wrong without it, because these are the failures that do not show up in
 * testing, everything works, and the account takeover arrives later.
 *
 *  1. **Trusting an unverified email.** An identity provider will happily
 *     assert an email address it has not verified. Linking on one lets somebody
 *     register `paul@detentgtm.io` at a provider that does not check, sign in,
 *     and land in Paul's account. Verification is required before any link.
 *
 *  2. **Not checking the token.** An ID token is a signed statement; unverified
 *     it is a string the browser handed us. Signature, issuer, audience,
 *     expiry and nonce are all checked, and a failure on any of them is a
 *     refusal rather than a warning.
 *
 *  3. **Losing the state parameter.** Without it, an attacker completes a login
 *     flow with their own account in a victim's browser, and the victim's
 *     subsequent work lands in the attacker's account. State is bound to the
 *     browser and to the flow.
 *
 * Apple differs from Google in ways that matter: its client secret is a signed
 * JWT that expires and must be regenerated, it returns the user's name only on
 * the very first authorisation and never again, and it posts the result as a
 * form rather than a query string.
 */

export type OidcProviderId = 'google' | 'apple';

export interface OidcProviderConfig {
  readonly id: OidcProviderId;
  readonly displayName: string;
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly clientId: string;
  /**
   * Google: a static secret. Apple: a short-lived ES256 JWT that must be
   * regenerated, which is why this is a function rather than a string.
   */
  clientSecret(): Promise<string> | string;
  readonly scopes: readonly string[];
  /** Apple posts the result back as a form; Google uses a query string. */
  readonly responseMode: 'query' | 'form_post';
}

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const APPLE_ISSUER = 'https://appleid.apple.com';

export function googleProvider(input: {
  readonly clientId: string;
  readonly clientSecret: string;
}): OidcProviderConfig {
  return {
    id: 'google',
    displayName: 'Google',
    issuer: GOOGLE_ISSUER,
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
    clientId: input.clientId,
    clientSecret: () => input.clientSecret,
    scopes: ['openid', 'email', 'profile'],
    responseMode: 'query',
  };
}

export function appleProvider(input: {
  readonly clientId: string;
  /** Generates the ES256 client-secret JWT. Apple's expires; regenerate it. */
  clientSecret(): Promise<string>;
}): OidcProviderConfig {
  return {
    id: 'apple',
    displayName: 'Apple',
    issuer: APPLE_ISSUER,
    authorizationEndpoint: 'https://appleid.apple.com/auth/authorize',
    tokenEndpoint: 'https://appleid.apple.com/auth/token',
    jwksUri: 'https://appleid.apple.com/auth/keys',
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    // Apple returns no profile scope; name arrives once, in the form post.
    scopes: ['openid', 'email', 'name'],
    responseMode: 'form_post',
  };
}

/** One in-flight sign-in. Held server-side; only its id goes to the browser. */
export interface OidcFlow {
  readonly flowId: string;
  readonly provider: OidcProviderId;
  readonly realm: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Where to send the user afterwards. Validated as a local path. */
  readonly returnTo?: string;
}

export interface OidcFlowStore {
  put(flow: OidcFlow): Promise<void>;
  take(state: string): Promise<OidcFlow | undefined>;
}

export class InMemoryOidcFlowStore implements OidcFlowStore {
  private readonly flows = new Map<string, OidcFlow>();
  async put(flow: OidcFlow): Promise<void> { this.flows.set(flow.state, flow); }
  /** Single use: a state that has been redeemed cannot be replayed. */
  async take(state: string): Promise<OidcFlow | undefined> {
    const flow = this.flows.get(state);
    if (flow) this.flows.delete(state);
    return flow;
  }
}

export const FLOW_LIFETIME_MINUTES = 10;

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

/** PKCE challenge. Protects the code even where a secret is present. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export interface StartFlowInput {
  readonly provider: OidcProviderConfig;
  readonly realm: string;
  readonly redirectUri: string;
  readonly nowMs: number;
  readonly returnTo?: string;
}

export function startFlow(input: StartFlowInput): { flow: OidcFlow; authorizationUrl: string } {
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(24));
  const nonce = base64url(randomBytes(24));

  const flow: OidcFlow = {
    flowId: base64url(randomBytes(9)),
    provider: input.provider.id,
    realm: input.realm,
    state,
    nonce,
    codeVerifier: verifier,
    redirectUri: input.redirectUri,
    createdAt: new Date(input.nowMs).toISOString(),
    expiresAt: new Date(input.nowMs + FLOW_LIFETIME_MINUTES * 60_000).toISOString(),
    // Only a local path is ever kept, so the parameter cannot become an open
    // redirect that carries a signed-in user to somebody else's site.
    returnTo: safeReturnTo(input.returnTo),
  };

  const url = new URL(input.provider.authorizationEndpoint);
  url.searchParams.set('client_id', input.provider.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', input.provider.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (input.provider.responseMode === 'form_post') {
    url.searchParams.set('response_mode', 'form_post');
  }
  return { flow, authorizationUrl: url.toString() };
}

/** Keeps only a same-site path, never an absolute URL. */
export function safeReturnTo(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // A leading `//` is protocol-relative and leaves the site, and a backslash is
  // treated as a slash by some browsers.
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return undefined;
  return value;
}

export interface IdTokenClaims {
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly sub: string;
  readonly exp: number;
  readonly iat: number;
  readonly nonce?: string;
  readonly email?: string;
  readonly email_verified?: boolean | string;
  readonly name?: string;
  readonly given_name?: string;
  readonly family_name?: string;
  /** Apple sets this on a relay address. */
  readonly is_private_email?: boolean | string;
}

export interface Jwk {
  readonly kid: string;
  readonly kty: string;
  readonly alg?: string;
  readonly n?: string;
  readonly e?: string;
  readonly use?: string;
}

export type VerifyFailure =
  | 'malformed' | 'unknown_key' | 'bad_signature' | 'wrong_issuer'
  | 'wrong_audience' | 'expired' | 'bad_nonce' | 'unsupported_algorithm';

export type VerifyResult =
  | { readonly ok: true; readonly claims: IdTokenClaims }
  | { readonly ok: false; readonly reason: VerifyFailure };

/**
 * Verifies an ID token.
 *
 * Everything is checked, and any failure is a refusal. In particular the
 * algorithm is checked against the key rather than taken from the token: a
 * token that says `"alg": "none"`, or that asks for HMAC using the public key
 * as the secret, is the oldest JWT attack there is and both are refused here.
 */
export function verifyIdToken(input: {
  readonly idToken: string;
  readonly keys: readonly Jwk[];
  readonly issuer: string;
  readonly audience: string;
  readonly nonce: string;
  readonly nowSeconds: number;
  /** Seconds of tolerance for clock skew between us and the provider. */
  readonly leewaySeconds?: number;
}): VerifyResult {
  const parts = input.idToken.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };

  let header: { alg?: string; kid?: string };
  let claims: IdTokenClaims;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // Only RS256. `none` disables verification entirely, and an HMAC algorithm
  // lets a token be signed with the public key, which is public.
  if (header.alg !== 'RS256') return { ok: false, reason: 'unsupported_algorithm' };

  const key = input.keys.find((candidate) => candidate.kid === header.kid);
  if (!key || key.kty !== 'RSA' || !key.n || !key.e) return { ok: false, reason: 'unknown_key' };

  let publicKey;
  try {
    publicKey = createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' });
  } catch {
    return { ok: false, reason: 'unknown_key' };
  }

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  if (!verifier.verify(publicKey, Buffer.from(parts[2]!, 'base64url'))) {
    return { ok: false, reason: 'bad_signature' };
  }

  if (claims.iss !== input.issuer) return { ok: false, reason: 'wrong_issuer' };

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(input.audience)) return { ok: false, reason: 'wrong_audience' };

  const leeway = input.leewaySeconds ?? 60;
  if (typeof claims.exp !== 'number' || claims.exp + leeway < input.nowSeconds) {
    return { ok: false, reason: 'expired' };
  }

  // The nonce ties this token to the flow we started. Without it a token
  // obtained elsewhere for the same client can be replayed here.
  const given = Buffer.from(claims.nonce ?? '', 'utf8');
  const expected = Buffer.from(input.nonce, 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad_nonce' };
  }

  return { ok: true, claims };
}

export type LinkRefusal =
  | 'email_missing'
  | 'email_unverified'
  | 'flow_expired'
  | 'state_mismatch';

export interface FederatedIdentity {
  readonly provider: OidcProviderId;
  /** The provider's stable identifier. The thing to key on, not the email. */
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name?: string;
  /** Apple's private relay address. Deliverable, but not the real address. */
  readonly isPrivateRelay: boolean;
}

export type IdentityResult =
  | { readonly ok: true; readonly identity: FederatedIdentity }
  | { readonly ok: false; readonly reason: LinkRefusal };

/**
 * Turns verified claims into an identity we are willing to link.
 *
 * The email must be present and verified. An identity provider will assert an
 * unverified address, and linking on one is account takeover: register the
 * victim's address somewhere that does not check, sign in here, arrive in their
 * account.
 */
export function toIdentity(provider: OidcProviderId, claims: IdTokenClaims): IdentityResult {
  const email = claims.email?.trim().toLowerCase();
  if (!email) return { ok: false, reason: 'email_missing' };

  // Providers send this as a boolean or as the string "true". Anything else,
  // including absent, is treated as unverified.
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (!verified) return { ok: false, reason: 'email_unverified' };

  const composed = [claims.given_name, claims.family_name].filter(Boolean).join(' ').trim();
  const name = claims.name ?? (composed.length > 0 ? composed : undefined);

  return {
    ok: true,
    identity: {
      provider,
      subject: claims.sub,
      email,
      emailVerified: true,
      name,
      isPrivateRelay: claims.is_private_email === true || claims.is_private_email === 'true',
    },
  };
}

/** Explains a refusal to the person in front of the screen. */
export function refusalMessage(reason: LinkRefusal): string {
  switch (reason) {
    case 'email_missing':
      return 'That account did not share an email address, so we cannot create an account with it.';
    case 'email_unverified':
      return 'That email address has not been verified with the provider. Verify it there, then try again.';
    case 'flow_expired':
      return 'That sign-in took too long. Start again.';
    default:
      return 'That sign-in could not be completed. Start again.';
  }
}

export function verifyFailureMessage(reason: VerifyFailure): string {
  // Deliberately uniform: which check failed is useful to an attacker probing
  // the endpoint and useless to a person trying to sign in.
  return reason === 'expired'
    ? 'That sign-in took too long. Start again.'
    : 'That sign-in could not be verified. Start again.';
}
