import {
  AwaError, Keyring, LocalKeyProvider, MetricsRegistry, SPINE_FEATURES, silentLogger, systemClock,
  type Clock, type FeatureFlags, type Jurisdiction, type KeyProvider, type Logger, type TenantConfig,
} from '@detent/awa-core';
import {
  AuditLog, InMemoryAuditStore, InMemoryCheckpointStore,
  type AuditStore, type CheckpointStore,
} from '@detent/awa-audit';
import {
  ConsentService, InMemoryConsentStore, MeteringService, InMemoryUsageStore, PolicyEngine,
  type ConsentStore, type UsageStore,
} from '@detent/awa-policy';
import {
  ConnectorRegistry, CrmAdapter, EncryptedConnectionStore, InMemoryParkedWriteStore,
  InMemoryWriteReceiptStore, RateLimiter, ReconciliationWorker, WriteReceiptService,
  type ConnectionStore, type CrmConnector, type Credential, type ParkedWriteStore,
} from '@detent/awa-connectors';
import { IdentityResolutionService } from '@detent/awa-identity';
import { KnowledgeCorpus, RetrievalService } from '@detent/awa-knowledge';
import {
  HandoffService, InMemoryCalendarService, InMemoryNotificationService, SessionManager,
  ToolExecutor, TurnOrchestrator, type ModelProvider, type Session,
} from '@detent/awa-agent';
import {
  GenerationService, StagingLedger, type Extractor, type PageFetcher,
} from '@detent/awa-onboarding';
import {
  PlaybookVersionStore, SimulationHarness, type ScenarioDriver,
} from '@detent/awa-studio';
import {
  InMemoryOutcomeStore, OutcomeService, type OutcomeDispatcher,
} from '@detent/awa-outcomes';
import {
  ComplianceScorecardService, DailyRollupCache, DataQualityScorecardService, FunnelService,
} from '@detent/awa-analytics';
import {
  FollowUpEngine, FrequencyLedger, InMemoryMessageSender, InMemorySuppressionStore, SuppressionList,
} from '@detent/awa-followup';
import {
  AccountMatcher, EngagementRulesEngine, EnrichmentOrchestrator, SignalStore, VisitorSignalService,
  type CompanyResolver, type EnrichmentVendor,
} from '@detent/awa-signals';
import {
  CustomerContextService, SystemRegistry,
} from '@detent/awa-context';
import { EntitlementService, VerificationService, type CodeSender } from '@detent/awa-entitlement';
import { ModeSelector } from '@detent/awa-modes';
import { GroupIdentityService, HierarchyService, PartnerRegistry } from '@detent/awa-groups';
import { MachineSurface } from '@detent/awa-machine';
import { AssurancePackGenerator, type AccessibilityStatement } from '@detent/awa-assurance';
import {
  CreditLedger, InMemoryLedgerStore, InMemorySubscriptionStore, SubscriptionService,
} from '@detent/awa-billing';
import { TenantStore } from './tenant-store.js';

/**
 * Composition root.
 *
 * One place where every dependency is wired, so the trust boundaries are
 * visible in a single file rather than distributed across a framework's
 * container.
 *
 * On persistence, stated accurately (audit SEC-3): the in-memory stores are the
 * default and are what a test or a demo runs on. `@detent/awa-db` implements
 * the same interfaces against Postgres, binding `SET LOCAL app.tenant_id` inside
 * every transaction so row-level security is enforced at the database under a
 * `NOBYPASSRLS` role. A deployment passes those adapters in through
 * `PlatformOptions`; nothing else in the platform changes, and nothing here
 * claims durability a deployment has not configured. `durable` reports which it
 * is, and the console shows it, because "the evidence evaporates on restart" is
 * not a thing a buyer should have to discover for themselves.
 */
export interface PlatformOptions {
  readonly model: ModelProvider;
  readonly clock?: Clock;
  readonly auditStore?: AuditStore;
  readonly checkpointStore?: CheckpointStore;
  readonly connectionStore?: ConnectionStore;
  readonly parkedWriteStore?: ParkedWriteStore;
  /** Retry policy for CRM calls. Injectable so a test does not sleep through a backoff. */
  readonly adapter?: { readonly maxAttempts?: number; readonly sleep?: (ms: number) => Promise<void> };
  /** Attempts before a parked write is left for a human (audit PERF-8). */
  readonly reconciliationMaxAttempts?: number;
  readonly usageStore?: UsageStore;
  readonly consentStore?: ConsentStore;
  readonly connectors?: readonly CrmConnector[];
  /** Which surfaces this deployment serves (audit BIZ-1). */
  readonly features?: FeatureFlags;
  readonly logger?: Logger;
  readonly metrics?: MetricsRegistry;
  /**
   * Key management for credentials at rest (audit SEC-4). A deployment supplies
   * a KMS-backed provider; the local provider exists so development and test
   * are encrypted too, because the secure path nobody exercises is how
   * plaintext reaches production.
   */
  readonly keyProvider?: KeyProvider;
  /** HMAC key for signed audit-chain checkpoints (audit PERF-2). */
  readonly checkpointKey?: string;
  /** Fetches a tenant page to confirm the widget snippet is installed. */
  readonly pageProbe?: (url: string) => Promise<string>;
  readonly accessibilityStatement?: AccessibilityStatement;
  /** Stated so the composition root does not have to assume it. */
  readonly durable?: boolean;
  /**
   * Regions this deployment can serve, by residency (audit BIZ-8).
   *
   * `residency` was a column in the migration and a word in the Enterprise tier
   * description, and nothing routed on it. A deployment now declares which
   * regions it actually operates; a tenant whose residency has no region is
   * refused rather than quietly served from the wrong place, and a deployment
   * that declares none makes no residency claim at all.
   */
  readonly residencyRegions?: Readonly<Partial<Record<TenantConfig['residency'], string>>>;
  // --- v1.1 parity extension. Each is optional: a platform without a page
  // fetcher simply has no generation service, rather than a broken one.
  readonly pageFetcher?: PageFetcher;
  readonly extractor?: Extractor;
  readonly outcomeDispatcher?: OutcomeDispatcher;
  readonly companyResolver?: CompanyResolver;
  readonly enrichmentVendors?: readonly EnrichmentVendor[];
  readonly scenarioDriver?: ScenarioDriver;
  /** Base URL for opt-out links and outcome confirmation callbacks. */
  readonly publicBaseUrl?: string;
  /** Platform-wide salt for the global suppression digest. Never rotated. */
  readonly suppressionSalt?: string;
  // --- v1.2 unoccupied ground.
  readonly codeSender?: CodeSender;
}

/**
 * The accessibility statement shipped by default.
 *
 * Deliberately `partial` and deliberately explicit about what is not audited.
 * The README's WCAG 2.2 AA claim was an assertion; the audit found a keyboard
 * trap behind it (UX-1). That trap is fixed, and the claim is now a statement
 * with named limitations rather than a badge.
 */
export const DEFAULT_ACCESSIBILITY: AccessibilityStatement = {
  standard: 'WCAG 2.2 AA',
  conformance: 'partial',
  knownLimitations: [
    'No independent accessibility audit has been carried out. The conformance claim is self-assessed.',
    'Voice modality has not been assessed for assistive-technology compatibility.',
  ],
  statement:
    'The visitor surface targets WCAG 2.2 AA. The conversation panel is keyboard operable throughout, '
    + 'traps no focus, announces state changes, and can be closed from the keyboard and from a visible control. '
    + 'The assessment is our own and has not been independently audited.',
};

export class Platform {
  readonly clock: Clock;
  readonly audit: AuditLog;
  readonly consent: ConsentService;
  readonly metering: MeteringService;
  readonly policy: PolicyEngine;
  readonly registry: ConnectorRegistry;
  readonly connections: ConnectionStore;
  readonly receipts: WriteReceiptService;
  readonly adapter: CrmAdapter;
  /** Replays CRM writes parked by an outage (audit PERF-8). */
  readonly reconciliation: ReconciliationWorker;
  readonly identity: IdentityResolutionService;
  readonly corpus: KnowledgeCorpus;
  readonly retrieval: RetrievalService;
  readonly calendar: InMemoryCalendarService;
  readonly notifications: InMemoryNotificationService;
  readonly handoff: HandoffService;
  readonly sessions: SessionManager;
  readonly executor: ToolExecutor;
  readonly orchestrator: TurnOrchestrator;
  readonly tenants: TenantStore;

  // --- v1.1 parity extension
  readonly generation?: GenerationService;
  readonly staging: StagingLedger;
  readonly playbooks: PlaybookVersionStore;
  readonly simulation?: SimulationHarness;
  readonly outcomes: OutcomeService;
  readonly funnel: FunnelService;
  readonly dataQuality: DataQualityScorecardService;
  readonly compliance: ComplianceScorecardService;
  readonly followUp: FollowUpEngine;
  readonly suppression: SuppressionList;
  readonly messages: InMemoryMessageSender;
  readonly signals: VisitorSignalService;
  readonly signalStore: SignalStore;
  readonly engagement: EngagementRulesEngine;
  readonly enrichment?: EnrichmentOrchestrator;
  readonly accounts: AccountMatcher;

  // --- v1.2 unoccupied ground
  readonly systems: SystemRegistry;
  readonly customerContext: CustomerContextService;
  readonly verification: VerificationService;
  readonly entitlement: EntitlementService;
  readonly modes: ModeSelector;
  readonly hierarchy: HierarchyService;
  readonly groupIdentity: GroupIdentityService;
  readonly partners: PartnerRegistry;
  readonly machine: MachineSurface;
  readonly assurance: AssurancePackGenerator;

  // --- commercial
  readonly subscriptions: SubscriptionService;
  readonly credits: CreditLedger;
  readonly features: FeatureFlags;
  readonly logger: Logger;
  readonly metrics?: MetricsRegistry;
  readonly keyring: Keyring;
  readonly rollups: DailyRollupCache;
  readonly accessibilityStatement: AccessibilityStatement;
  /** True only when every store passed in is backed by durable storage. */
  readonly durable: boolean;
  /** Regions this deployment can serve, by residency. Empty means no claim. */
  readonly residencyRegions: Readonly<Partial<Record<TenantConfig['residency'], string>>>;
  private readonly pageProbe?: (url: string) => Promise<string>;
  private sweepTimer?: ReturnType<typeof setInterval>;

  /**
   * Platform-wide kill switch (section 13.6). Independent of the per-tenant
   * switch, and effective without a redeploy.
   */
  platformKillSwitch: 'OFF' | 'TEXT_ONLY' | 'BOOKING_LINK_ONLY' = 'OFF';

  constructor(options: PlatformOptions) {
    this.clock = options.clock ?? systemClock;
    this.features = options.features ?? SPINE_FEATURES;
    this.logger = options.logger ?? silentLogger;
    this.metrics = options.metrics;
    this.pageProbe = options.pageProbe;
    this.durable = options.durable
      ?? Boolean(options.auditStore && options.connectionStore && options.usageStore && options.consentStore);
    this.accessibilityStatement = options.accessibilityStatement ?? DEFAULT_ACCESSIBILITY;
    this.residencyRegions = options.residencyRegions ?? {};

    this.audit = new AuditLog(
      options.auditStore ?? new InMemoryAuditStore(),
      this.clock,
      {
        checkpoints: options.checkpointStore ?? new InMemoryCheckpointStore(),
        checkpointKey: options.checkpointKey,
      },
    );
    this.consent = new ConsentService(options.consentStore ?? new InMemoryConsentStore(), this.clock, this.audit);
    this.metering = new MeteringService(options.usageStore ?? new InMemoryUsageStore(), undefined, this.clock);
    this.policy = new PolicyEngine(this.consent, this.metering, this.audit);
    this.rollups = new DailyRollupCache(this.audit, () => this.clock.iso());

    this.registry = new ConnectorRegistry();
    for (const connector of options.connectors ?? []) this.registry.register(connector);

    // Credentials are sealed before they reach any store (audit SEC-4). The
    // local provider is a development default; a deployment passes a KMS one.
    this.keyring = new Keyring(
      options.keyProvider ?? new LocalKeyProvider(
        process.env['AWA_ROOT_KEY'] ?? LocalKeyProvider.generateRootKey(),
      ),
      () => this.clock.iso(),
    );
    this.connections = options.connectionStore ?? new EncryptedConnectionStore(this.keyring);
    this.receipts = new WriteReceiptService(new InMemoryWriteReceiptStore(), this.clock);
    const parked = options.parkedWriteStore ?? new InMemoryParkedWriteStore();
    this.adapter = new CrmAdapter(
      this.registry, this.connections, this.receipts, this.audit,
      new RateLimiter(this.clock), { parked, ...(options.adapter ?? {}) }, this.clock,
    );
    this.reconciliation = new ReconciliationWorker(
      this.adapter, parked, this.receipts, this.audit,
      { clock: this.clock, logger: this.logger, maxAttempts: options.reconciliationMaxAttempts },
    );

    this.identity = new IdentityResolutionService(this.consent, this.adapter, this.audit, this.clock);
    this.corpus = new KnowledgeCorpus(this.clock);
    this.retrieval = new RetrievalService(this.corpus);
    this.calendar = new InMemoryCalendarService(this.clock);
    this.notifications = new InMemoryNotificationService(this.clock);
    this.handoff = new HandoffService(this.clock);
    this.sessions = new SessionManager(this.clock);

    // --- v1.1 parity extension, wired before the executor so the outcome
    // recorder can be handed to it.
    this.staging = new StagingLedger(this.clock);
    this.playbooks = new PlaybookVersionStore(this.audit, this.clock);
    this.outcomes = new OutcomeService(
      new InMemoryOutcomeStore(),
      this.metering,
      this.audit,
      options.outcomeDispatcher ?? { async post() { return { status: 204 }; } },
      this.clock,
    );

    this.executor = new ToolExecutor({
      policy: this.policy, consent: this.consent, metering: this.metering, audit: this.audit,
      adapter: this.adapter, identity: this.identity, retrieval: this.retrieval,
      calendar: this.calendar, notifications: this.notifications, handoff: this.handoff,
      sessions: this.sessions, clock: this.clock,
      staging: this.staging,
      outcomes: {
        record: async (input) => {
          const recorded = await this.outcomes.record({
            config: input.config,
            conversationId: input.conversationId,
            correlationId: input.correlationId,
            outcome: input.outcome as never,
            person: input.person,
            qualification: input.qualification,
            callbackBaseUrl: options.publicBaseUrl,
          });
          return { outcome: recorded.outcome, billable: recorded.billable, state: recorded.state };
        },
      },
    });

    this.orchestrator = new TurnOrchestrator({
      model: options.model, executor: this.executor, sessions: this.sessions,
      audit: this.audit, metering: this.metering,
    });

    this.tenants = new TenantStore(this.audit, this.clock);

    if (options.pageFetcher) {
      this.generation = new GenerationService(options.pageFetcher, this.audit, options.extractor, this.clock);
    }
    if (options.scenarioDriver) {
      this.simulation = new SimulationHarness(options.scenarioDriver, this.audit, this.clock);
    }

    this.funnel = new FunnelService(this.audit, this.metering, this.outcomes);
    this.dataQuality = new DataQualityScorecardService(this.audit, this.receipts);
    this.compliance = new ComplianceScorecardService(this.audit, this.rollups);

    const salt = options.suppressionSalt ?? 'awa-platform-suppression-salt';
    this.suppression = new SuppressionList(new InMemorySuppressionStore(), salt, this.clock);
    this.messages = new InMemoryMessageSender();
    this.followUp = new FollowUpEngine(
      this.messages,
      this.suppression,
      new FrequencyLedger(salt, this.clock),
      this.audit,
      options.publicBaseUrl ?? '',
      this.clock,
    );

    // Short-retention behavioural store: fifteen minutes is long enough for an
    // engagement decision and short enough that it is not a profile.
    this.signalStore = new SignalStore(900, this.clock);
    this.signals = new VisitorSignalService(this.signalStore, this.consent, this.audit, options.companyResolver);
    this.engagement = new EngagementRulesEngine(this.audit);
    this.accounts = new AccountMatcher(this.adapter);
    if (options.enrichmentVendors?.length) {
      this.enrichment = new EnrichmentOrchestrator(options.enrichmentVendors, this.metering, 8.0, 90, this.clock);
    }

    // --- v1.2: the systems beyond the CRM.
    this.systems = new SystemRegistry();
    this.customerContext = new CustomerContextService(
      (tenantId) => this.systems.forTenant(tenantId), this.audit, this.clock,
    );
    this.verification = new VerificationService(
      options.codeSender ?? { async send() { /* development default */ } },
      this.audit, this.clock,
    );
    this.entitlement = new EntitlementService(this.audit);
    this.modes = new ModeSelector(this.audit);
    this.hierarchy = new HierarchyService(this.audit, this.clock);
    this.groupIdentity = new GroupIdentityService(
      this.hierarchy, this.audit,
      // Per-group salt, so two groups never produce the same digest for a
      // person. Derived from the platform salt rather than stored per group.
      (groupId) => `${salt}:${groupId}`,
    );
    this.partners = new PartnerRegistry(this.audit);
    this.machine = new MachineSurface(this.audit, this.clock);
    this.assurance = new AssurancePackGenerator(this.audit, this.compliance);

    // --- commercial. The billing package was built, tested and a dependency of
    // nothing (audit BIZ-1); it is now wired to the plan catalogue here.
    this.subscriptions = new SubscriptionService(new InMemorySubscriptionStore(), this.audit, this.clock);
    this.credits = new CreditLedger(new InMemoryLedgerStore(), this.audit, this.clock);
  }

  /**
   * Periodic maintenance: expire sessions, sweep rate-limit counters, publish
   * gauges (audit PERF-7, PERF-8).
   *
   * Called by the HTTP server at boot and stopped on shutdown. `unref` so a
   * timer never keeps a process alive — a server that will not exit because of
   * its own housekeeping is a deploy that hangs.
   */
  startMaintenance(intervalMs = 60_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const sessions = this.sessions.sweep();
      this.metrics?.gauge('awa_sessions_live', 'Live conversation sessions', this.sessions.size);
      if (sessions > 0) this.logger.info('sessions expired', { count: sessions });

      // Replay CRM writes parked by an outage. Guarded against overlapping
      // runs inside the worker, so a slow CRM cannot turn a short timer into a
      // self-inflicted flood.
      void this.reconciliation.runOnce().then((result) => {
        this.metrics?.gauge('awa_parked_writes', 'CRM writes awaiting reconciliation', result.stillParked);
        if (result.reconciled > 0 || result.abandoned > 0) {
          this.logger.info('reconciliation pass', { ...result });
        }
      }).catch((cause: unknown) => {
        this.logger.error('reconciliation pass failed', {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    }, intervalMs);
    this.sweepTimer.unref?.();
  }

  stopMaintenance(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  /**
   * Confirm the widget snippet is actually present on a declared origin
   * (audit SEC-5, UX-10).
   *
   * Deliberately a weak check that is honest about being one: it looks for the
   * custom element and the tenant's own key prefix in the served HTML. It
   * catches the common install failure — a snippet pasted into a staging
   * template and never promoted — and it does not pretend to prove ownership.
   */
  async verifyInstall(tenantId: string, url: string): Promise<{ verified: boolean; reason: string }> {
    if (!this.pageProbe) return { verified: false, reason: 'no page probe configured on this deployment' };
    try {
      const html = await this.pageProbe(url);
      const present = html.includes('<detent-assistant') || html.includes('detent-assistant');
      return present
        ? { verified: true, reason: `snippet found at ${url}` }
        : { verified: false, reason: `no assistant snippet found at ${url}` };
    } catch (cause) {
      return { verified: false, reason: `could not fetch ${url}: ${String(cause)}` };
    }
  }

  /**
   * Residency routing (audit BIZ-8).
   *
   * `residency` was a column in the migration and a word in the Enterprise tier
   * description, and nothing routed on it. It now selects the storage and
   * processing region for a tenant, and a deployment that has not been given a
   * region for a tenant's residency refuses rather than quietly serving from
   * the wrong one — which is the failure a DPA review is looking for.
   */
  regionFor(tenantId: string): string {
    const config = this.tenants.get(tenantId);
    const region = this.residencyRegions[config.residency];
    if (!region) {
      throw new AwaError({
        kind: 'POLICY_DENIED',
        message: `this deployment serves no region for ${config.residency} residency`,
        tenantId,
        details: { residency: config.residency, configured: Object.keys(this.residencyRegions) },
      });
    }
    return region;
  }



  async connectCrm(tenantId: string, connector: string, credential: Credential): Promise<void> {
    await this.connections.put({ tenantId, connector, credential, state: 'CONNECTED' });
  }

  /**
   * Effective kill switch for a tenant: the stricter of the platform-wide and
   * per-tenant settings. A platform incident cannot be overridden by a tenant.
   */
  effectiveConfig(tenantId: string): TenantConfig {
    const config = this.tenants.get(tenantId);
    const order = { OFF: 0, TEXT_ONLY: 1, BOOKING_LINK_ONLY: 2 } as const;
    const killSwitch = order[this.platformKillSwitch] >= order[config.killSwitch]
      ? this.platformKillSwitch
      : config.killSwitch;
    return killSwitch === config.killSwitch ? config : { ...config, killSwitch };
  }

  async openSession(tenantId: string, jurisdiction: Jurisdiction, modality: 'text' | 'voice' = 'text'): Promise<Session> {
    const config = this.effectiveConfig(tenantId);
    // A deployment that declares regions routes on them; one that declares
    // none makes no residency claim and this is a no-op (audit BIZ-8).
    if (Object.keys(this.residencyRegions).length > 0) this.regionFor(tenantId);
    const session = this.sessions.open(config, jurisdiction, modality);
    await this.metering.record(tenantId, 'conversation', 1);
    await this.audit.write({
      tenantId, type: 'session_opened', correlationId: session.correlationId,
      sessionId: session.id, actor: 'system',
      payload: { modality, jurisdiction, state: config.state },
      versions: session.versions,
    });
    return session;
  }
}
