import { AwaError, newId, type Clock, type Logger, silentLogger, systemClock } from '@detent/awa-core';
import type { Platform } from './platform.js';
import type { ApiKeyService } from './auth.js';

/**
 * Self-serve trial and OAuth connect (audit BIZ-7).
 *
 * The finding: at £350/month the Starter tier can only work self-serve, and
 * there was no free tier, no trial, no "Connect HubSpot" button, no marketplace
 * listing path and no partner surface, while trial provisioning, the governed
 * crawl and the partner registry were all built and reachable from nowhere.
 * The strongest demo this product can give is a governed crawl that produces a
 * *generated, unapproved* playbook within ten minutes, and it was mostly
 * already there.
 *
 * Two rules shape this file, and both are the reason it is safe to expose:
 *
 *  - a trial tenant is a real tenant on the real lifecycle. It starts in
 *    REGISTERED with no DPA, no CRM and `dryRun` on, so it can be shown and
 *    cannot write to anything. Nothing here skips a gate;
 *  - the OAuth handshake never holds a credential in this process longer than
 *    it takes to seal it. The state parameter is single-use and bound to the
 *    tenant, because an OAuth callback that accepts any state is an account
 *    takeover with extra steps.
 */
export interface TrialRequest {
  readonly companyName: string;
  readonly rootUrl: string;
  readonly contactEmail: string;
  readonly jurisdiction?: 'UK' | 'EU';
}

export interface TrialResult {
  readonly tenantId: string;
  readonly consoleUrl: string;
  /** Shown once. The trial's own tenant admin key. */
  readonly adminKey: string;
  readonly generated?: {
    readonly services: number;
    readonly prices: number;
    readonly claims: number;
    readonly pagesCrawled: number;
    readonly durationMs: number;
  };
  /** Stated back explicitly, every time. */
  readonly nothingServesUntilApproved: true;
  readonly expiresAt: string;
}

export interface OAuthStart {
  readonly authorizeUrl: string;
  readonly state: string;
  readonly expiresAt: string;
}

/** What a connector needs to complete an authorisation-code exchange. */
export interface OAuthConnector {
  readonly name: string;
  readonly authorizeUrl: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  /** Exchanges a code for tokens. Supplied by the deployment, never invented. */
  exchange(code: string, redirectUri: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: string;
    instanceUrl?: string;
  }>;
}

interface PendingAuthorisation {
  readonly tenantId: string;
  readonly connector: string;
  readonly redirectUri: string;
  readonly expiresAtMs: number;
}

export interface SelfServeOptions {
  readonly trialDays?: number;
  readonly consoleBaseUrl?: string;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly connectors?: readonly OAuthConnector[];
}

export class SelfServeService {
  private readonly pending = new Map<string, PendingAuthorisation>();
  private readonly connectors = new Map<string, OAuthConnector>();
  private readonly trialDays: number;
  private readonly consoleBaseUrl: string;
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(
    private readonly platform: Platform,
    private readonly keys: ApiKeyService,
    options: SelfServeOptions = {},
  ) {
    this.trialDays = options.trialDays ?? 14;
    this.consoleBaseUrl = options.consoleBaseUrl ?? '';
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? silentLogger;
    for (const connector of options.connectors ?? []) this.connectors.set(connector.name, connector);
  }

  get availableConnectors(): string[] {
    return [...this.connectors.keys()];
  }

  /**
   * Provision a trial and run the governed crawl.
   *
   * The crawl is the demo: within a few minutes a prospect sees their own
   * services, prices and claims proposed back to them, every one of them marked
   * unapproved and unservable. That is a stronger argument for the governance
   * thesis than any slide about it.
   */
  async startTrial(request: TrialRequest): Promise<TrialResult> {
    if (!request.companyName?.trim() || !request.rootUrl?.trim() || !request.contactEmail?.includes('@')) {
      throw new AwaError({
        kind: 'SCHEMA_INVALID',
        message: 'companyName, rootUrl and a contactEmail are required',
      });
    }
    let root: URL;
    try {
      root = new URL(request.rootUrl);
    } catch {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'rootUrl must be an absolute URL' });
    }
    if (root.protocol !== 'https:') {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'rootUrl must be https' });
    }

    const tenantId = newId('t', this.clock.nowMs());
    this.platform.tenants.create({
      tenantId,
      name: request.companyName.trim(),
      connector: 'sandbox',
      homeJurisdiction: request.jurisdiction ?? 'UK',
      // The trial's own site, so the widget can be demonstrated on it.
      origins: [root.origin],
    });

    const admin = this.keys.issue(tenantId, 'tenant_admin', {
      label: 'trial',
      ttlMs: this.trialDays * 86_400_000,
    });

    await this.platform.audit.write({
      tenantId,
      type: 'policy_allowed',
      correlationId: `trial_${this.clock.nowMs()}`,
      actor: 'platform_admin',
      payload: { change: 'trial_started', rootUrl: root.origin, contactDomain: request.contactEmail.split('@')[1] },
    });

    let generated: TrialResult['generated'];
    if (this.platform.generation) {
      try {
        const result = await this.platform.generation.generate({
          tenantId,
          rootUrl: root.toString(),
          correlationId: `trial_generate_${this.clock.nowMs()}`,
          qualification: this.platform.tenants.get(tenantId).qualification,
          objections: this.platform.tenants.get(tenantId).objections,
          crmSchemas: [],
          owners: [],
          pipelines: [],
          capabilities: undefined as never,
        });
        generated = {
          services: result.playbook.serviceCatalogue.length,
          prices: result.playbook.priceList.length,
          claims: result.playbook.approvedClaims.length,
          pagesCrawled: result.knowledge.pagesCrawled,
          durationMs: result.durationMs,
        };
      } catch (cause) {
        // A crawl that fails is a worse demo, not a failed signup.
        this.logger.warn('trial generation failed', {
          tenantId, error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }

    return {
      tenantId,
      consoleUrl: `${this.consoleBaseUrl}/console.html#connect`,
      adminKey: admin.key,
      generated,
      nothingServesUntilApproved: true,
      expiresAt: new Date(this.clock.nowMs() + this.trialDays * 86_400_000).toISOString(),
    };
  }

  /** Begin an OAuth handshake. The state is single-use and tenant-bound. */
  begin(tenantId: string, connectorName: string, redirectUri: string): OAuthStart {
    const connector = this.connectors.get(connectorName);
    if (!connector) {
      throw new AwaError({ kind: 'NOT_FOUND', message: `connector ${connectorName} is not configured` });
    }
    const config = this.platform.tenants.get(tenantId);
    if (!config.dpaSignedAt) {
      // The lifecycle gate, enforced here as well as in the store: no CRM
      // connection before a DPA record exists, self-serve or not.
      throw new AwaError({
        kind: 'POLICY_DENIED',
        message: 'no CRM connection before a signed DPA record exists',
        tenantId,
      });
    }

    const state = newId('corr', this.clock.nowMs());
    const expiresAtMs = this.clock.nowMs() + 10 * 60 * 1000;
    this.pending.set(state, { tenantId, connector: connectorName, redirectUri, expiresAtMs });

    const url = new URL(connector.authorizeUrl);
    url.searchParams.set('client_id', connector.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', connector.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('response_type', 'code');

    return { authorizeUrl: url.toString(), state, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /**
   * Complete the handshake.
   *
   * The state is consumed whatever happens, so a replayed callback cannot bind
   * a second credential, and the tenant comes from the stored state rather than
   * from the request, a callback that takes a tenant id from the caller is an
   * account takeover with extra steps.
   */
  async complete(state: string, code: string): Promise<{ tenantId: string; connector: string }> {
    const authorisation = this.pending.get(state);
    this.pending.delete(state);
    if (!authorisation) {
      throw new AwaError({ kind: 'POLICY_DENIED', message: 'unknown or already-used authorisation state' });
    }
    if (authorisation.expiresAtMs <= this.clock.nowMs()) {
      throw new AwaError({ kind: 'POLICY_DENIED', message: 'authorisation state has expired' });
    }
    const connector = this.connectors.get(authorisation.connector)!;

    const tokens = await connector.exchange(code, authorisation.redirectUri);
    // Sealed on the way into the store; the plaintext never leaves this call.
    await this.platform.connectCrm(authorisation.tenantId, authorisation.connector, {
      kind: 'oauth2',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      instanceUrl: tokens.instanceUrl,
    });
    await this.platform.tenants.transition(authorisation.tenantId, 'CRM_CONNECTED', 'tenant');

    return { tenantId: authorisation.tenantId, connector: authorisation.connector };
  }

  /** Drop expired authorisations. Called on the maintenance sweep. */
  sweep(): number {
    const now = this.clock.nowMs();
    let removed = 0;
    for (const [state, authorisation] of this.pending) {
      if (authorisation.expiresAtMs <= now) { this.pending.delete(state); removed += 1; }
    }
    return removed;
  }
}
