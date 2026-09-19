import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AwaError } from '@detent/awa-core';

/**
 * Tenant-scoped API keys.
 *
 * Tenant binding is applied at the authorisation layer rather than the query
 * layer (table 34, elevation of privilege). A caller does not supply a tenant
 * id and have it checked; the tenant id is derived from the key, so a request
 * naming another tenant cannot be authorised at all.
 *
 * Keys are stored as SHA-256 digests. A stolen database gives an attacker
 * hashes, not keys.
 *
 * Audit SEC-8 changed three things here:
 *
 *  - the tenant id is no longer part of the key material. It published an
 *    internal identifier in the HTML of every page on a tenant's website for no
 *    benefit, since the digest lookup never needed it. Keys carry a short
 *    random public prefix instead, which is what the record is indexed by;
 *  - keys expire, record when they were last used, and can be rotated with an
 *    overlap window, so a leaked key has a bounded life and a rotation does not
 *    require a simultaneous redeploy of every tenant's website;
 *  - a key can be bound to a set of web origins. Combined with the tenant's
 *    registered origins (SEC-5), a widget key lifted from page source is
 *    useless from anywhere but the tenant's own site.
 */
export type Audience = 'widget' | 'tenant_admin' | 'platform_admin';

export interface ApiKeyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly audience: Audience;
  /** Short random public identifier carried in the key. Not a secret. */
  readonly prefix: string;
  readonly digest: string;
  readonly createdAt: string;
  /** Optional human label, e.g. "marketing site". Shown in the console. */
  readonly label?: string;
  /**
   * Origins this key may be presented from. Empty means "fall back to the
   * tenant's registered origins", which is where the widget's binding lives.
   */
  readonly origins: readonly string[];
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  /** Set on the predecessor when a key is rotated, for the audit trail. */
  rotatedToId?: string;
}

export interface Principal {
  readonly tenantId: string;
  readonly audience: Audience;
  readonly keyId: string;
  readonly keyOrigins: readonly string[];
}

export interface IssueOptions {
  readonly label?: string;
  readonly origins?: readonly string[];
  /** Lifetime in milliseconds. Omitted means the key does not expire. */
  readonly ttlMs?: number;
}

/** Public view of a key. Never carries the digest or the key itself. */
export interface ApiKeyView {
  readonly id: string;
  readonly tenantId: string;
  readonly audience: Audience;
  readonly prefix: string;
  readonly label?: string;
  readonly origins: readonly string[];
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
  readonly rotatedToId?: string;
  readonly active: boolean;
}

export class ApiKeyService {
  /** Digest → record. The authentication path. */
  private readonly byDigest = new Map<string, ApiKeyRecord>();
  /** Id → record, so revoke and rotate are not a linear scan. */
  private readonly byId = new Map<string, ApiKeyRecord>();
  /** Public prefix → record, for "which key is this?" without the secret. */
  private readonly byPrefix = new Map<string, ApiKeyRecord>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  issue(tenantId: string, audience: Audience, options: IssueOptions = {}): { key: string; record: ApiKeyRecord } {
    const prefix = randomBytes(5).toString('base64url');
    const secret = randomBytes(24).toString('base64url');
    // No tenant id in the key material. The prefix identifies the record; the
    // secret authenticates it.
    const key = `awa_${audience === 'widget' ? 'pub' : 'sk'}_${prefix}_${secret}`;
    const issuedAt = this.now();
    const record: ApiKeyRecord = {
      id: `ak_${randomBytes(8).toString('hex')}`,
      tenantId,
      audience,
      prefix,
      digest: digestOf(key),
      createdAt: issuedAt.toISOString(),
      label: options.label,
      origins: options.origins ?? [],
      expiresAt: options.ttlMs ? new Date(issuedAt.getTime() + options.ttlMs).toISOString() : undefined,
    };
    this.byDigest.set(record.digest, record);
    this.byId.set(record.id, record);
    this.byPrefix.set(record.prefix, record);
    return { key, record };
  }

  /**
   * Rotate a key: issue a successor and put the predecessor on a deadline.
   *
   * The overlap window is the whole point. A tenant has the old key pasted into
   * their site's markup; revoking on the spot breaks their assistant until they
   * redeploy. With an overlap, both work, and the console can show when the old
   * one was last used — which is how a tenant knows the swap is complete.
   */
  rotate(keyId: string, overlapMs = 7 * 24 * 60 * 60 * 1000): { key: string; record: ApiKeyRecord } {
    const current = this.byId.get(keyId);
    if (!current) throw new AwaError({ kind: 'NOT_FOUND', message: `key ${keyId} not found` });
    if (current.revokedAt) throw new AwaError({ kind: 'CONFLICT', message: 'a revoked key cannot be rotated' });

    const successor = this.issue(current.tenantId, current.audience, {
      label: current.label,
      origins: current.origins,
    });
    const deadline = new Date(this.now().getTime() + overlapMs).toISOString();
    // Never extend a life: if the predecessor already expires sooner, keep it.
    current.expiresAt = current.expiresAt && current.expiresAt < deadline ? current.expiresAt : deadline;
    current.rotatedToId = successor.record.id;
    return successor;
  }

  revoke(keyId: string): void {
    const record = this.byId.get(keyId);
    if (record && !record.revokedAt) record.revokedAt = this.now().toISOString();
  }

  /** Every key for a tenant, so a tenant can see what is live. Never secrets. */
  list(tenantId: string): ApiKeyView[] {
    const nowIso = this.now().toISOString();
    return [...this.byId.values()]
      .filter((record) => record.tenantId === tenantId)
      .map((record) => ({
        id: record.id,
        tenantId: record.tenantId,
        audience: record.audience,
        prefix: record.prefix,
        label: record.label,
        origins: record.origins,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        lastUsedAt: record.lastUsedAt,
        revokedAt: record.revokedAt,
        rotatedToId: record.rotatedToId,
        active: !record.revokedAt && !(record.expiresAt && record.expiresAt <= nowIso),
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  authenticate(presented: string | undefined): Principal {
    if (!presented) {
      throw new AwaError({ kind: 'POLICY_DENIED', message: 'no API key presented' });
    }
    const digest = digestOf(presented);
    const record = this.byDigest.get(digest);
    if (!record || record.revokedAt) {
      throw new AwaError({ kind: 'POLICY_DENIED', message: 'API key is not recognised' });
    }
    // Constant-time confirmation on the digest as well, so a partial-match
    // oracle cannot be built from response timing on the map lookup.
    const a = Buffer.from(record.digest, 'hex');
    const b = Buffer.from(digest, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AwaError({ kind: 'POLICY_DENIED', message: 'API key is not recognised' });
    }
    const nowIso = this.now().toISOString();
    if (record.expiresAt && record.expiresAt <= nowIso) {
      throw new AwaError({
        kind: 'POLICY_DENIED',
        message: 'API key has expired',
        details: { keyId: record.id, expiredAt: record.expiresAt },
      });
    }
    record.lastUsedAt = nowIso;
    return {
      tenantId: record.tenantId,
      audience: record.audience,
      keyId: record.id,
      keyOrigins: record.origins,
    };
  }

  /**
   * The cross-tenant guard. Every handler that takes a tenant id in the path
   * calls this. A platform admin is the only principal permitted to address a
   * tenant other than its own, and that access is audited by the caller.
   */
  assertTenantAccess(principal: Principal, tenantId: string): void {
    if (principal.audience === 'platform_admin') return;
    if (principal.tenantId !== tenantId) {
      throw new AwaError({
        kind: 'POLICY_DENIED',
        message: 'cross-tenant access denied',
        details: { presentedTenant: principal.tenantId, requestedTenant: tenantId },
      });
    }
  }

  assertAudience(principal: Principal, ...allowed: Audience[]): void {
    if (!allowed.includes(principal.audience)) {
      throw new AwaError({
        kind: 'POLICY_DENIED',
        message: `audience ${principal.audience} may not perform this operation`,
      });
    }
  }
}

/**
 * Origin binding (audit SEC-5).
 *
 * A widget key is, by design, in the HTML of every page on a tenant's website.
 * Rejecting at authentication rather than only at CORS is what makes it a
 * control: CORS is enforced by the caller's browser and a script or bot farm
 * simply does not run one.
 *
 * Rules, in order:
 *   - a request with no `Origin` header is not a browser request. Those are
 *     allowed only for non-widget audiences (server-to-server admin calls);
 *   - an explicit allowlist on the key wins;
 *   - otherwise the tenant's registered origins apply;
 *   - a tenant with no registered origins cannot serve widget traffic at all.
 *     Failing closed here is the difference between a control and a default.
 */
export function assertOriginAllowed(
  principal: Principal,
  origin: string | undefined,
  tenantOrigins: readonly string[],
): void {
  if (principal.audience !== 'widget') return;

  const allowed = principal.keyOrigins.length > 0 ? principal.keyOrigins : tenantOrigins;
  if (allowed.length === 0) {
    throw new AwaError({
      kind: 'POLICY_DENIED',
      message: 'this tenant has no registered origins; complete install verification before serving traffic',
      details: { tenantId: principal.tenantId },
    });
  }
  if (!origin) {
    throw new AwaError({
      kind: 'POLICY_DENIED',
      message: 'a widget key must be presented from a registered browser origin',
      details: { tenantId: principal.tenantId },
    });
  }
  if (!originMatches(origin, allowed)) {
    throw new AwaError({
      kind: 'POLICY_DENIED',
      message: 'origin is not registered for this tenant',
      details: { origin, tenantId: principal.tenantId },
    });
  }
}

/**
 * Exact origin match, with one deliberate extension: a registered origin of
 * `https://*.example.com` matches any single-label subdomain. No other
 * wildcarding — `*` alone is not an origin, it is the absence of one.
 */
export function originMatches(origin: string, allowed: readonly string[]): boolean {
  const normalised = normaliseOrigin(origin);
  return allowed.some((candidate) => {
    const pattern = normaliseOrigin(candidate);
    if (pattern === normalised) return true;
    if (!pattern.includes('://*.')) return false;
    const [scheme, rest] = pattern.split('://*.');
    return normalised.startsWith(`${scheme}://`)
      && normalised.endsWith(`.${rest}`)
      // Exactly one extra label, so `https://*.example.com` does not match
      // `https://evil.example.com.attacker.net`.
      && normalised.slice(`${scheme}://`.length, normalised.length - rest!.length - 1).split('.').length === 1;
  });
}

function normaliseOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, '');
}

function digestOf(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
