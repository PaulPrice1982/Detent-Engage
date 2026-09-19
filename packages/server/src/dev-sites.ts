import { randomBytes } from 'node:crypto';
import {
  PostgresAccountStore, PostgresInvoiceStore, PostgresLedgerStore, PostgresPageStore,
  PostgresPaymentStore,
  PostgresResetTokenStore, PostgresSessionStore, PostgresSubscriptionStore,
  PostgresResellerStore, PostgresSupportRequestStore, PostgresTerritoryStore,
  PostgresUserStore, type Database,
} from '@detent/awa-persistence';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuditLog } from '@detent/awa-audit';
import { AwaError, newId, type Clock } from '@detent/awa-core';
import {
  AccountService, CreditLedger, DunningService, InMemoryAccountStore, InMemoryDunningStore,
  InMemoryInvoiceStore, InMemoryLedgerStore, InMemoryPlanCatalogueStore,
  InMemorySubscriptionStore, InvoiceService, PlanCatalogueService,
  SubscriptionService, money,
  type BillingInterval, type ContractTerm, type PlanCode, type PriceImpact,
  sum, type Money,
  LIST_PENCE_PER_REPLY, assertSellable, bundleByCode, creditValueOf,
} from '@detent/awa-billing';
import {
  FetchStripeHttp, InMemoryPaymentStore, PaymentService, SandboxPaymentProvider, StripeProvider,
} from '@detent/awa-payments';
import { ApprovalService, ConsoleService, InMemoryApprovalStore, can, type ConsoleCapability, type ConsoleUser } from '@detent/awa-console';
import {
  ConsoleEmailSender, InMemoryResetTokenStore, InMemorySessionStore, InMemoryUserStore,
  hashPassword,
  PasswordResetService, SessionService, UserService,
  type AuthUser, type EmailSender,
} from '@detent/awa-auth';
import { KnowledgeCorpus } from '@detent/awa-knowledge';
import {
  InMemoryPageStore, PageService, normaliseSlug,
  type Section, type SectionKind, type SectionTone,
} from '@detent/awa-cms';
import {
  DetentKnowledgeService, DocumentService, InMemoryDocumentStore, InMemoryDraftStore,
  DocxExtractor, KnowledgeAgent, PdfExtractor, PlainTextExtractor,
  type KnowledgeKind, type KnowledgeModel,
} from '@detent/awa-ingestion';
import { ConsoleSite } from './console-site.js';
import { accountsListPage, accountTermsSection, newAccountPage } from './console-accounts.js';
import { pricingPage } from './console-catalogue.js';
import { pageEditorPage, websiteListPage } from './console-cms.js';
import { notFoundPage, renderMarketingPage } from './marketing-render.js';
import { seedHomePage, seedResellerPage } from './marketing-seed.js';
import { seedCookiePage, seedPrivacyPage, seedTermsPage } from './legal-seed.js';
import type { SeedOutcome } from '@detent/awa-cms';
import { appBillingPage, appOverviewPage } from './app-site.js';
import { knowledgePage } from './knowledge-pages.js';
import {
  InMemorySupportRequestStore, SupportAgent, SupportRequestService, articleBySlug,
} from '@detent/awa-support';
import {
  CommissionCalculator, InMemoryResellerStore, InMemoryTerritoryStore,
  ResellerService, TerritoryRegistry,
} from '@detent/awa-reseller';
import {
  accountResellerControl, resellerDetailPage, resellerListPage,
} from './console-resellers.js';
import { bundlesPage } from './console-bundles.js';
import {
  resellerCustomersPage, resellerOverviewPage, resellerStatementsPage,
} from './reseller-pages.js';
import {
  supportArticlePage, supportHomePage, supportRequestPage, relatedArticles,
} from './support-pages.js';
import {
  apiPage, entitlementOf, installPage, statusPage, upgradeRequiredPage,
} from './app-gated.js';
import { boundaryOf, fieldOf, fileOf, parseMultipart } from './multipart.js';
import { SiteRouter, type SiteResponse } from './site-router.js';
import { escape as escapeHtml, forbiddenPage } from './site-html.js';

/**
 * Wires the two sites for a development server.
 *
 * Both are mounted on one process here because that is what a preview can show.
 * They are still two sites: separate realms, separate cookies, separate login
 * screens, and no shared session. In production they get separate hosts, and
 * nothing in this file has to change for that except the prefixes.
 */

/** What the transport knows about addressing that the renderer does not. */
export interface MarketingSeo {
  readonly canonicalOrigin?: string;
  readonly imageUrl?: string;
  /** False on a hostname that is not the canonical one. */
  readonly indexable?: boolean;
}

export interface DevSitesOptions {
  readonly audit: AuditLog;
  readonly clock: Clock;
  /**
   * The database, when one is configured.
   *
   * Absent, every store is in memory and everything is lost on restart. That
   * is right for a laptop and wrong for anything a customer touches, so the
   * boot banner says which of the two is running rather than leaving it to be
   * discovered by a restart.
   */
  readonly database?: Database;
  /** Signs session cookies. Generated per boot when not configured. */
  readonly sessionSecret?: string;
  /** Seed operator, from the environment. Never a literal in source. */
  readonly operatorEmail?: string;
  readonly operatorPassword?: string;
  /** False in local development, where there is no TLS. */
  readonly secureCookies?: boolean;
  /**
   * Sends reset emails. Defaults to writing them to the console, which is right
   * for development and must be replaced before launch: an email that silently
   * goes nowhere is worse than one that fails, because the flow looks like it
   * worked.
   */
  readonly emailSender?: EmailSender;
  /**
   * Absolute base for links in emails, e.g. https://app.detent.io.
   *
   * A reset link is followed from a mail client, so a relative one is useless.
   */
  readonly baseUrl?: string;
  /**
   * Which OIDC providers have credentials configured.
   *
   * The buttons are shown either way: hiding one leaves somebody wondering
   * whether the feature exists, and a silent absence is harder to diagnose
   * than an explicit "not configured yet".
   */
  readonly googleConfigured?: boolean;
  readonly appleConfigured?: boolean;
  /** The tenant's public widget key, shown in the install snippet. */
  readonly widgetKeyFor?: (tenantId: string) => string;
  /** Where the customer area lives, for links from the marketing site. */
  readonly appBaseUrl?: string;
  /** Detent's own assistant, embedded on the marketing site. */
  readonly assistant?: {
    readonly apiBaseUrl: string;
    readonly publicKey: string;
    readonly panelUrl: string;
  };
  /**
   * True when this is a deployed environment rather than a development one.
   *
   * A deployment refuses every convenience that exists for development: it will
   * not generate its own password, will not write one to a file, and will not
   * print credentials. Those are the right behaviours on a laptop and are
   * indistinguishable from a leaked secret once the app is on the internet , 
   * which is exactly what a deployment security scan looks for, and it is
   * right to.
   */
  readonly deployed?: boolean;
  /** Both or neither: a key that can take money but not verify the result is worse. */
  readonly stripeSecretKey?: string;
  readonly stripeWebhookSecret?: string;
}

/**
 * The shortest secret that can sign a session cookie here.
 *
 * Named rather than repeated, because the check and the message that explains
 * the check drifting apart is how somebody ends up reading "at least 32" while
 * the code wants something else.
 */
export const SESSION_SECRET_MINIMUM = 32;

export interface DevSites {
  readonly consoleRouter: SiteRouter;
  readonly resellerRouter: SiteRouter;
  readonly appRouter: SiteRouter;
  /** Renders the public marketing site. No session, no cookie. */
  marketing(path: string, seo?: MarketingSeo): Promise<{ status: number; html: string }>;
  readonly pages: PageService;
  /** What the shipped marketing copy did to each seeded page, for the boot log. */
  readonly copy: Record<string, SeedOutcome>;
  /** Which payment provider is live, for the boot banner. */
  readonly paymentProviderName: string;
  /** Whether sessions will survive a restart, for the boot banner. */
  /**
   * Whether the configured session secret was good enough to use.
   *
   * False when it is missing or too short, in which case a secret is generated
   * for this boot and every cookie signed with it stops verifying at the next
   * restart.
   *
   * This is one of the two things a person needs true to still be signed in
   * after a restart. The other is `sessionStoreDurable`.
   */
  readonly sessionsPersist: boolean;
  /**
   * Whether the session records themselves outlive the process.
   *
   * Separate from `sessionsPersist` because they fail differently and a single
   * field reporting both was reporting neither: with a stable secret and an
   * in-memory store the boot banner said sessions were durable and everybody
   * was signed out at the next restart anyway. A cookie that still verifies
   * and names a session that no longer exists is not a signed-in person.
   */
  readonly sessionStoreDurable: boolean;
  readonly accounts: AccountService;
  readonly users: UserService;
  readonly operatorEmail: string;
  /**
   * Whether an operator account exists.
   *
   * False when DETENT_CONSOLE_PASSWORD is unset: the site still serves, and its
   * sign-in page explains what to set. Refusing to start would take the
   * customer app down with it, and the customer app does not need that secret.
   */
  readonly operatorConfigured: boolean;
  readonly emailSender: EmailSender;
}

/**
 * The roles the first operator is seeded with.
 *
 * Both, because `owner` deliberately cannot move money and `admin`
 * deliberately cannot manage users: the split exists so that on a staffed
 * console no single person can both grant themselves a capability and use it.
 * On a deployment with one operator that split has nobody to separate, and
 * seeding only `admin` made `user.manage` unreachable for ever, so nobody
 * could create the second console user the separation is for.
 *
 * The moment a second operator exists, give them one role and take the other
 * away from this account.
 */
const CONSOLE_ROLES = ['admin', 'owner'];

export async function buildDevSites(options: DevSitesOptions): Promise<DevSites> {
  const { audit, clock } = options;
  const database = options.database;

  const users = new UserService(
    database ? new PostgresUserStore(database) : new InMemoryUserStore(), clock,
  );
  // One secret, generated once. Cookie signing and the CSRF token must derive
  // from the same value: generating one for each happens to work while both are
  // internally consistent, and breaks silently the moment anything compares
  // across them.
  //
  // A generated secret invalidates sessions on restart, which is right for a
  // development server and wrong for production, where it must be configured.
  //
  // A secret that is set and too short is treated exactly as one that is not
  // set: a strong one is generated for this boot and the operator is told. It
  // is never a refusal, and the short value is never used.
  //
  // This is the same fault as the credential key, found the same way and one
  // release later, which is why the rule is written down rather than applied
  // case by case. An unusable optional secret disables what it is for and takes
  // nothing else with it. Refusing here stopped the marketing site, which has
  // no sessions and needs no secret, over a value that only signs a cookie.
  const configuredSecret = options.sessionSecret?.trim();
  const secretTooShort = configuredSecret !== undefined
    && configuredSecret.length > 0
    && configuredSecret.length < SESSION_SECRET_MINIMUM;
  if (secretTooShort) {
    console.warn('');
    console.warn(`  DETENT_SESSION_SECRET is only ${configuredSecret!.length} characters and `
      + `needs at least ${SESSION_SECRET_MINIMUM}.`);
    console.warn('  A strong one has been generated for this boot, so everything works and');
    console.warn('  everybody is signed out at the next restart until it is corrected.');
    console.warn('  Print a good one with: node tools/make-secret.mjs session');
    console.warn('');
  }
  const secret = secretTooShort || !configuredSecret
    ? randomBytes(32).toString('hex')
    : configuredSecret;
  const sessions = new SessionService(
    database ? new PostgresSessionStore(database) : new InMemorySessionStore(),
    secret, clock,
  );

  // Password reset. The sender defaults to the console one: an email that
  // silently goes nowhere is worse than one that fails, because the flow looks
  // like it worked.
  const emailSender = options.emailSender ?? new ConsoleEmailSender();
  const passwordReset = new PasswordResetService(
    database ? new PostgresResetTokenStore(database) : new InMemoryResetTokenStore(),
    users, sessions, emailSender, clock,
  );

  const accountStore = database
    ? new PostgresAccountStore(database) : new InMemoryAccountStore();
  const accounts = new AccountService(accountStore, clock);
  const credits = new CreditLedger(
    database ? new PostgresLedgerStore(database) : new InMemoryLedgerStore(),
    audit, clock,
  );
  const approvals = new ApprovalService(new InMemoryApprovalStore(), audit, clock);
  const invoices = new InvoiceService(
    database ? new PostgresInvoiceStore(database) : new InMemoryInvoiceStore(), clock,
  );
  const dunning = new DunningService(new InMemoryDunningStore(), clock);
  // Stripe when it is configured, the sandbox when it is not, and the boot
  // banner says which. Before this the sandbox was wired unconditionally, so
  // setting STRIPE_SECRET_KEY changed nothing and the product could not take a
  // payment: the one thing standing between the build and revenue.
  //
  // Both keys or neither. A secret key without a webhook secret takes money and
  // cannot verify what the provider says happened to it, which is worse than
  // not taking it.
  const stripeConfigured = Boolean(options.stripeSecretKey && options.stripeWebhookSecret);
  const paymentProvider = stripeConfigured
    ? new StripeProvider({
        apiKey: options.stripeSecretKey!,
        webhookSecret: options.stripeWebhookSecret!,
        http: new FetchStripeHttp(),
      })
    : new SandboxPaymentProvider();
  const payments = new PaymentService(
    paymentProvider,
    database ? new PostgresPaymentStore(database) : new InMemoryPaymentStore(),
    audit, clock,
  );
  const consoleService = new ConsoleService({
    approvals, credits, invoices, dunning, payments, audit, clock,
    subscriptions: new SubscriptionService(
      database ? new PostgresSubscriptionStore(database) : new InMemorySubscriptionStore(),
      audit, clock,
    ),
  });
  const consoleSite = new ConsoleSite(consoleService);

  // The plan catalogue. Seeded from the plans in code, then edited here rather
  // than by a deploy.
  const catalogue = new PlanCatalogueService(new InMemoryPlanCatalogueStore(), clock);
  await catalogue.seed('system');

  // The marketing site's content, authored in the console.
  const pages = new PageService(
    database ? new PostgresPageStore(database) : new InMemoryPageStore(), clock,
  );

  // Where recorded demonstrations live on disk, so a missing one is detected
  // rather than served as a broken player.
  const mediaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public/media');

  // Detent's own support knowledge, built once at boot. It is a separate
  // instance from anything holding a customer's knowledge, not a reserved
  // tenant inside one: a customer asking about their invoice must never
  // retrieve their own marketing copy, and a visitor asking a customer's
  // assistant about pricing must never retrieve Detent's billing terms.
  /**
   * A margin typed as a percentage, held as basis points.
   *
   * An operator types 15 or 12.5; the system stores 1500 or 1250. Rounding
   * here rather than carrying a float is what keeps a commission statement
   * agreeing with the reseller's own arithmetic to the penny.
   */
  /**
   * Splits a bar-separated line into cells.
   *
   * Returns nothing for a blank line, so a stray newline in the textarea does
   * not become an empty row in the rendered table.
   */
  const splitCells = (input: string | undefined): string[] | undefined => {
    const cells = (input ?? '').split('|').map((cell) => cell.trim());
    return cells.some((cell) => cell.length > 0) ? cells : undefined;
  };

  const basisPointsFrom = (input: string | undefined): number => {
    const value = Number((input ?? '').trim());
    if (!Number.isFinite(value)) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'A margin is a percentage, such as 15.' });
    }
    return Math.round(value * 100);
  };

  const resellers = new ResellerService(
    database ? new PostgresResellerStore(database) : new InMemoryResellerStore(), clock,
  );
  const territories = new TerritoryRegistry(
    database ? new PostgresTerritoryStore(database) : new InMemoryTerritoryStore(),
  );
  const commission = new CommissionCalculator(clock);

  /**
   * Every invoice a reseller's customers have ever had.
   *
   * Read from the invoice service rather than kept alongside the link, so a
   * statement is always computed from the billing record itself. A channel
   * ledger that drifts from the invoices it is paid against is the thing
   * everybody discovers at year end.
   */
  const invoicesForAccounts = async (accountIds: readonly string[]) => {
    const found = await Promise.all(accountIds.map((id) => invoices.listByAccount(id)));
    return found.flat();
  };

  const supportAgent = new SupportAgent();
  const supportRequests = new SupportRequestService(
    database ? new PostgresSupportRequestStore(database) : new InMemorySupportRequestStore(),
    clock,
  );

  // The step-by-step setup recording, when it has been produced. Absent, the
  // support page simply omits the section rather than showing a broken player.
  const setupVideo = existsSync(resolve(mediaDir, 'setup-walkthrough.webm'))
    ? { src: '/media/setup-walkthrough.webm', poster: existsSync(resolve(mediaDir, 'setup-walkthrough.png'))
        ? '/media/setup-walkthrough.png' : undefined }
    : undefined;
  const appBaseUrl = options.appBaseUrl ?? options.baseUrl ?? '';
  // Reported rather than silent. "kept-edited" is the one an operator has to
  // know about: their own words are still live and the release disagrees with
  // them, which is a decision for them and not for a deploy.
  const copy: Record<string, SeedOutcome> = {
    home: await seedHomePage(pages, appBaseUrl),
    'become-a-reseller': await seedResellerPage(pages, appBaseUrl),
    privacy: await seedPrivacyPage(pages),
    terms: await seedTermsPage(pages),
    cookies: await seedCookiePage(pages),
  };

  const marketing = async (
    path: string,
    seo?: MarketingSeo,
  ): Promise<{ status: number; html: string }> => {
    const slug = normaliseSlug(path) || 'home';
    const live = await pages.live(slug);
    if (!live) return { status: 404, html: notFoundPage(appBaseUrl) };
    return {
      status: 200,
      html: renderMarketingPage({
        page: live,
        navigation: await pages.navigation(),
        appBaseUrl,
        plans: await catalogue.selfServicePlans(),
        assistant: options.assistant,
        canonicalOrigin: seo?.canonicalOrigin,
        imageUrl: seo?.imageUrl,
        // A copy served on a non-canonical hostname asks not to be listed. The
        // canonical tag says where the original is; this keeps the copy out of
        // the index entirely so the two never compete.
        previewOf: seo && seo.indexable === false ? `/${live.slug}` : undefined,
      }),
    };
  };

  // The knowledge area. The model here is a stand-in: it produces one article
  // and one FAQ per section so the flow is demonstrable end to end. Swap it for
  // a real KnowledgeModel and nothing above it changes: the governance,
  // provenance and approval gate are in the agent, not the model.
  const documents = new DocumentService(
    new InMemoryDocumentStore(),
    // Word and PDF as well as text. The upload form has always invited them and
    // until now nothing could read either, so the first thing a new customer
    // uploads was the first thing that failed.
    [new PlainTextExtractor(), new DocxExtractor(), new PdfExtractor()],
    clock,
  );
  const drafts = new InMemoryDraftStore();
  const corpus = new KnowledgeCorpus(clock);
  const knowledge = new DetentKnowledgeService(drafts, corpus, audit, clock);
  const knowledgeModel: KnowledgeModel = {
    id: 'demo',
    async propose(input) {
      const body = input.envelope.split('---\n')[1]?.split('\n«doc:')[0]?.trim() ?? '';
      const sentences = body.split(/(?<=[.!?])\s+/).filter((line) => line.trim().length > 20);
      if (sentences.length === 0) return [];
      return [
        {
          kind: 'article' as const,
          title: input.locator,
          body: sentences.slice(0, 3).join(' '),
        },
        {
          kind: 'faq' as const,
          question: `What should I know about ${input.locator.toLowerCase()}?`,
          title: input.locator,
          body: sentences[0]!,
        },
      ];
    },
  };
  const knowledgeAgent = new KnowledgeAgent(knowledgeModel, drafts, clock);

  // The seed operator. The password comes from the environment or is generated
  // and printed once; a default password in source is a shipped vulnerability,
  // because it survives into production once nobody remembers it was temporary.
  //
  // Both are trimmed. A secret pasted into a hosting provider's UI very often
  // carries a trailing newline or space, and an untrimmed password fails to
  // match with exactly the message a wrong password gives, which sends
  // somebody hunting for a problem in the wrong place entirely.
  const operatorEmail = (options.operatorEmail ?? 'operator@detent.local').trim().toLowerCase();
  const configured = options.operatorPassword?.trim() || undefined;
  // No password, no operator account, and no generated fallback.
  //
  // An earlier design generated one and wrote it to a file so it could be read
  // without the console. That solved the wrong problem twice over: the password
  // rotated on every restart, so nobody could rely on it, and a file named for
  // a password, containing a password, is exactly what a deployment security
  // scan exists to find: it blocked publishing.
  //
  // Requiring the secret is one action, permanent, and leaves nothing on disk.
  // The console still serves; its sign-in page says what to set. Refusing to
  // start would take the customer app down with it, and the customer app has no
  // need of that secret.
  const operatorConfigured = Boolean(configured);
  if (configured) {
    // Seeding has to survive a second boot. With in-memory stores the table was
    // empty every time and an unconditional create always worked; against a
    // real database the operator is already there, and creating them again
    // threw CONFLICT and took the whole server down on restart.
    //
    // The password is reset to the configured one rather than left alone, so
    // rotating the secret actually rotates the password. That is the behaviour
    // an operator locked out of the console will expect, and the secret remains
    // the only place the password exists.
    const existing = await users.byEmail('console', operatorEmail);
    if (existing) {
      // replacePassword takes a hash, not a password. Handing it the plaintext
      // would store the password verbatim and every sign-in would then compare
      // a hash against it and fail, after writing the secret into the database
      // in the clear.
      await users.replacePassword(existing.userId, await hashPassword(configured));
    } else {
      await users.create({
        realm: 'console',
        email: operatorEmail,
        name: 'Detent operator',
        password: configured,
        roles: CONSOLE_ROLES,
      });
    }
  }

  const asConsoleUser = (user: AuthUser): ConsoleUser => ({
    userId: user.userId,
    email: user.email,
    name: user.name,
    roles: user.roles as ConsoleUser['roles'],
    active: user.active,
    // Read, never asserted. This was hard-coded true with a comment saying it
    // came from the identity provider in production, and this is the
    // production path: every MFA gate on every money capability was bypassed
    // for every console user. It is now whatever the user actually proved,
    // which is false until they complete enrolment.
    mfaEnrolled: user.mfaEnrolled,
    createdAt: user.createdAt,
  });

  const consoleRouter = new SiteRouter({
    realm: 'console',
    prefix: '/console',
    users, sessions, secret,
    secureCookies: options.secureCookies,
    // Only when nobody configured a password. Says where to look, never what
    // the password is.
    // Says what to set, rather than refusing with the message a wrong password
    // gives, which is what sent somebody hunting in the wrong place before.
    operatorMissing: !operatorConfigured,
    passwordReset,
    baseUrl: options.baseUrl ?? '',
    async handler(request): Promise<SiteResponse> {
      const operator = asConsoleUser(request.user);
      const path = request.path.replace(/^\/console\/?/, '');
      const nowIso = clock.iso();

      /**
       * Server-side authorisation for a write.
       *
       * The screens already ask `can()` to decide which buttons to draw, and
       * that is presentation, not a control: a hidden button is a button
       * somebody can still POST to with curl. Every write below names the
       * capability it needs and is refused without it, so the button and the
       * endpoint cannot disagree.
       *
       * This also restores the point of the MFA gate. `can()` refuses the nine
       * money capabilities to a user who has not enrolled, and until these
       * calls existed nothing consulted it on the way to actually moving money.
       */
      const refuse = (capability: ConsoleCapability): SiteResponse | undefined => {
        if (can(operator, capability)) return undefined;
        return {
          status: 403,
          html: forbiddenPage({
            capability,
            roles: operator.roles,
            mfaEnrolled: operator.mfaEnrolled,
          }),
        };
      };

      if (path === 'new') {
        if (request.method === 'POST') {
          const denied = refuse('account.create');
          if (denied) return denied;
          try {
            const account = await accounts.create({
              name: request.form['name'] ?? '',
              tenantId: request.form['tenantId'] ?? '',
              billingEmail: request.form['billingEmail'] ?? '',
              countryCode: (request.form['countryCode'] ?? 'GB').toUpperCase(),
              vatNumber: request.form['vatNumber'] || undefined,
              accountManager: request.form['accountManager'] || undefined,
              createdBy: operator.userId,
            });
            const pounds = (key: string): number | undefined => {
              const raw = request.form[key];
              if (!raw || raw.trim() === '') return undefined;
              return Math.round(Number(raw) * 100);
            };
            const count = (key: string): number | undefined => {
              const raw = request.form[key];
              if (!raw || raw.trim() === '') return undefined;
              return Number(raw);
            };
            const spendCap = pounds('spendCap');
            await accounts.startSubscription({
              accountId: account.accountId,
              planCode: (request.form['planCode'] ?? 'growth') as PlanCode,
              term: (request.form['term'] ?? 'twelve_months') as ContractTerm,
              billingInterval: (request.form['billingInterval'] ?? 'monthly') as BillingInterval,
              startDate: new Date(`${request.form['startDate'] ?? nowIso.slice(0, 10)}T00:00:00.000Z`).toISOString(),
              billingDay: count('billingDay'),
              noticePeriodDays: count('noticePeriodDays'),
              renewalUpliftBasisPoints: request.form['renewalUplift']
                ? Math.round(Number(request.form['renewalUplift']) * 100)
                : undefined,
              monthlyCreditsPence: pounds('monthlyCredits'),
              limits: {
                seats: count('seats'),
                conversationsPerPeriod: count('conversations'),
                voiceMinutesPerPeriod: count('voiceMinutes'),
                ...(spendCap === undefined ? {} : { spendCap: money(spendCap) }),
              },
              createdBy: operator.userId,
            });
            return { status: 303, redirect: `/console/accounts/${encodeURIComponent(account.accountId)}` };
          } catch (error) {
            return {
              status: 400,
              html: newAccountPage({
                userEmail: request.user.email,
                error: error instanceof Error ? error.message : 'That did not work.',
                values: request.form,
                csrf: request.csrf,
              }),
            };
          }
        }
        return { status: 200, html: newAccountPage({ userEmail: request.user.email, csrf: request.csrf }) };
      }

      if (path.startsWith('website')) {
        const renderList = async (extra: { notice?: string; error?: string } = {}): Promise<SiteResponse> => ({
          status: extra.error ? 400 : 200,
          html: websiteListPage({
            userEmail: request.user.email, csrf: request.csrf,
            pages: await pages.list(), ...extra,
          }),
        });
        const renderEditor = async (pageId: string, extra: { notice?: string; error?: string } = {}) => {
          const found = await pages.get(pageId);
          if (!found) return renderList({ error: 'No such page.' });
          return {
            status: extra.error ? 400 : 200,
            html: pageEditorPage({
              userEmail: request.user.email, csrf: request.csrf, page: found, ...extra,
            }),
          } satisfies SiteResponse;
        };

        const rest = path.slice('website'.length).replace(/^\//, '');
        const [pageId, action, sectionId] = rest.split('/');

        try {
          if (request.method === 'POST' && pageId === 'new') {
            const created = await pages.create({
              slug: request.form['slug'] ?? '',
              title: request.form['title'] ?? '',
              description: request.form['description'] ?? '',
              navLabel: request.form['navLabel'] || undefined,
              navOrder: request.form['navOrder'] ? Number(request.form['navOrder']) : undefined,
              createdBy: request.user.email,
            });
            return { status: 303, redirect: `/console/website/${created.pageId}` };
          }

          if (pageId && request.method === 'POST') {
            if (action === 'details') {
              await pages.update(pageId, {
                title: request.form['title'],
                description: request.form['description'],
                navLabel: request.form['navLabel'] || undefined,
              }, request.user.email);
              return renderEditor(pageId, { notice: 'Saved. Publish to make it live.' });
            }
            if (action === 'publish') {
              const published = await pages.publish(pageId, request.user.email);
              return renderEditor(pageId, {
                notice: `Live at /${published.slug}.`,
              });
            }
            if (action === 'archive') {
              await pages.archive(pageId, request.user.email);
              return renderEditor(pageId, { notice: 'Taken off the site. Nothing is deleted.' });
            }
            if (action === 'section' && !sectionId) {
              await pages.addSection(
                pageId, (request.form['kind'] ?? 'prose') as SectionKind, request.user.email,
              );
              return renderEditor(pageId, { notice: 'Section added.' });
            }
            if (action === 'section' && sectionId) {
              if (request.form['remove']) {
                await pages.removeSection(pageId, sectionId, request.user.email);
                return renderEditor(pageId, { notice: 'Section removed.' });
              }
              if (request.form['move']) {
                await pages.moveSection(
                  pageId, sectionId,
                  request.form['move'] === 'up' ? 'up' : 'down', request.user.email,
                );
                return renderEditor(pageId);
              }

              const current = (await pages.get(pageId))?.sections
                .find((section) => section.sectionId === sectionId);
              // Items are numbered in the form, so they round-trip in order.
              const items: Section['items'][number][] = [];
              for (let index = 0; ; index += 1) {
                const heading = request.form[`itemHeading_${index}`];
                const body = request.form[`itemBody_${index}`];
                if (heading === undefined && body === undefined) break;
                items.push({
                  heading: heading || undefined,
                  body: body || undefined,
                  column: request.form[`itemColumn_${index}`] === 'right' ? 'right' : 'left',
                });
              }
              if (request.form['addItem']) items.push({ heading: '', body: '' });
              if (request.form['removeItem'] && items.length > 1) items.pop();

              await pages.updateSection(pageId, sectionId, {
                kicker: request.form['kicker'] || undefined,
                heading: request.form['heading'] || undefined,
                lede: request.form['lede'] || undefined,
                tone: (request.form['tone'] ?? 'light') as SectionTone,
                items: items.length > 0 ? items : (current?.items ?? []),
                primaryActionLabel: request.form['primaryActionLabel'] || undefined,
                primaryActionHref: request.form['primaryActionHref'] || undefined,
                secondaryActionLabel: request.form['secondaryActionLabel'] || undefined,
                secondaryActionHref: request.form['secondaryActionHref'] || undefined,
                // Present in the form only for a demo section. Testing for the
                // key rather than the value keeps a saved hero from wiping the
                // media off a section that never showed those fields, while
                // still letting an author clear one by emptying it.
                mediaSrc: 'mediaSrc' in request.form
                  ? (request.form['mediaSrc'] || undefined) : current?.mediaSrc,
                mediaPoster: 'mediaPoster' in request.form
                  ? (request.form['mediaPoster'] || undefined) : current?.mediaPoster,
                mediaDescription: 'mediaDescription' in request.form
                  ? (request.form['mediaDescription'] || undefined) : current?.mediaDescription,
                // Same key-presence rule as the media fields: a saved hero must
                // not wipe a table it never showed the author.
                columns: 'columns' in request.form
                  ? splitCells(request.form['columns']) : current?.columns,
                rows: 'rows' in request.form
                  ? (request.form['rows'] ?? '').split(/\r?\n/)
                      .map((line) => splitCells(line))
                      .filter((row): row is string[] => row !== undefined)
                  : current?.rows,
                highlightColumn: 'highlightColumn' in request.form
                  ? (request.form['highlightColumn']?.trim()
                      ? Number(request.form['highlightColumn']) : undefined)
                  : current?.highlightColumn,
              }, request.user.email);
              return renderEditor(pageId, { notice: 'Section saved.' });
            }
          }

          if (pageId === 'preview' || action === 'preview') {
            // A draft is rendered exactly as it would be live, with a bar
            // saying so and a noindex tag. Reviewing a page in a form field is
            // how a broken page gets published.
            const target = action === 'preview' ? pageId : undefined;
            const found = target ? await pages.get(target) : undefined;
            if (!found) return renderList({ error: 'No such page.' });
            return {
              status: 200,
              html: renderMarketingPage({
                page: found,
                navigation: await pages.navigation(),
                appBaseUrl,
                plans: await catalogue.selfServicePlans(),
                previewOf: found.state === 'published' ? undefined : `/${found.slug}`,
              }),
            };
          }

          if (pageId) return renderEditor(pageId);
          return renderList();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'That did not work.';
          return pageId && pageId !== 'new'
            ? renderEditor(pageId, { error: message })
            : renderList({ error: message });
        }
      }

      if (path.startsWith('pricing')) {
        const renderPricing = async (extra: { notice?: string; error?: string } = {}): Promise<SiteResponse> => {
          const versions = await catalogue.all();
          const impacts = new Map<string, PriceImpact>();
          for (const version of versions) {
            if (version.state !== 'draft') continue;
            try {
              impacts.set(
                `${version.planCode}:${version.version}`,
                await catalogue.impact(version.planCode, version.version),
              );
            } catch {
              // A draft with nothing published to compare against still shows;
              // it just has no impact panel.
            }
          }
          return {
            status: extra.error ? 400 : 200,
            html: pricingPage({
              userEmail: request.user.email, csrf: request.csrf, versions, impacts, ...extra,
            }),
          };
        };

        if (request.method !== 'POST') return renderPricing();
        const pence = (key: string): number | undefined => {
          const raw = request.form[key];
          if (raw === undefined || raw.trim() === '') return undefined;
          return Math.round(Number(raw) * 100);
        };
        const count = (key: string): number | undefined => {
          const raw = request.form[key];
          if (raw === undefined || raw.trim() === '') return undefined;
          return Number(raw);
        };
        const planCode = (request.form['planCode'] ?? 'growth') as PlanCode;

        try {
          if (path === 'pricing/draft') {
            const denied = refuse('plan.override');
            if (denied) return denied;
            const monthly = pence('platformFeeMonthly');
            const annual = pence('platformFeeAnnual');
            const activation = pence('activationFee');
            const credits = pence('includedCredits');
            const outcome = pence('outcomeFee');
            const spendCap = pence('spendCap');
            const draft = await catalogue.draft(planCode, {
              ...(monthly === undefined ? {} : { platformFeeMonthly: money(monthly) }),
              ...(annual === undefined ? {} : { platformFeeAnnual: money(annual) }),
              ...(activation === undefined ? {} : { activationFee: money(activation) }),
              ...(credits === undefined ? {} : { includedCreditsPence: credits }),
              ...(outcome === undefined ? {} : { outcomeFee: money(outcome) }),
              ...(request.form['outcomeBasis']
                ? { outcomeBasis: request.form['outcomeBasis'] as 'assistant_reply' | 'confirmed' }
                : {}),
              // Blank means uncapped, and blank has to be distinguishable from
              // zero: zero chargeable replies is a free plan, not an unlimited
              // one, and reading one as the other gets the price exactly
              // backwards.
              ...(request.form['billableReplies'] === undefined
                || request.form['billableReplies'].trim() === ''
                ? {}
                : { billableRepliesPerConversation: Number(request.form['billableReplies']) }),
              ...(spendCap === undefined ? {} : { defaultSpendCapPence: spendCap }),
              usageRates: {
                ...(count('conversationMillis') === undefined
                  ? {} : { conversationMillis: count('conversationMillis')! }),
                ...(count('voiceMinuteMillis') === undefined
                  ? {} : { voiceMinuteMillis: count('voiceMinuteMillis')! }),
              },
              connectorEntitlement: {
                ...(count('tier1') === undefined ? {} : { tier1: count('tier1')! }),
              },
              ...(count('maxConcurrentVoice') === undefined
                ? {} : { maxConcurrentVoice: count('maxConcurrentVoice')! }),
              selfServiceAvailable: request.form['selfServiceAvailable'] === 'true',
            }, { createdBy: request.user.email, changeNote: request.form['changeNote'] ?? '' });
            return renderPricing({
              notice: `Version ${draft.version} drafted. Nothing has changed for anyone yet, `
                + 'review the impact, then publish.',
            });
          }

          if (path === 'pricing/publish') {
            const denied = refuse('plan.override');
            if (denied) return denied;
            const published = await catalogue.publish(
              planCode, Number(request.form['version']), request.user.email,
            );
            return renderPricing({
              notice: `Version ${published.version} is live for new sales. `
                + 'No existing subscription changed price.',
            });
          }

          if (path === 'pricing/discard') {
            const denied = refuse('plan.override');
            if (denied) return denied;
            await catalogue.discard(planCode, Number(request.form['version']));
            return renderPricing({ notice: 'Draft discarded.' });
          }
        } catch (error) {
          return renderPricing({
            error: error instanceof Error ? error.message : 'That did not work.',
          });
        }
        return renderPricing();
      }

      if (path === 'bundles' || path === 'bundles/grant') {
        const renderBundles = async (notice?: string): Promise<SiteResponse> => ({
          status: 200,
          html: bundlesPage({
            userEmail: request.user.email,
            csrf: request.csrf,
            accounts: (await accounts.list())
              .map((one) => ({ accountId: one.accountId, name: one.name })),
            notice,
          }),
        });

        if (path === 'bundles/grant') {
          const denied = refuse('credit.grant');
          if (denied) return denied;
          if (request.method !== 'POST') return { status: 303, redirect: '/console/bundles' };
          if (request.form['csrf'] !== request.csrf) {
            return { status: 403, html: 'Stale form. Go back and try again.' };
          }
          const bundle = bundleByCode(request.form['bundle'] ?? '');
          if (!bundle) return renderBundles('No such bundle.');
          const accountId = request.form['accountId'] ?? '';
          const reason = (request.form['reason'] ?? '').trim();
          if (!reason) {
            return renderBundles('Say why. A credit nobody can explain at the year end is one '
              + 'nobody should have granted.');
          }
          try {
            assertSellable(bundle);
            await credits.grant({
              accountId,
              // Granted at list value rather than at what was paid. That is
              // what the discount is: the customer gets the replies they were
              // sold, not the ones their money would buy at list.
              amount: creditValueOf(bundle),
              kind: 'grant_purchased',
              reason: `${bundle.name}: ${reason}`,
              grantedBy: request.user.email,
              correlationId: newId('corr', clock.nowMs()),
              sourceRef: bundle.code,
            });
          } catch (error) {
            return renderBundles(error instanceof Error ? error.message : 'That did not work.');
          }
          return renderBundles(
            `Granted ${bundle.name} to that account, ${bundle.replies} replies at the `
            + `${LIST_PENCE_PER_REPLY}p list price.`,
          );
        }

        return renderBundles();
      }

      // ------------------------------------------------------------ channel
      if (path === 'resellers' || path.startsWith('resellers/')) {
        const rest = path.replace(/^resellers\/?/, '');

        const statementsFor = async (resellerId: string) => {
          const reseller = await resellers.get(resellerId);
          const links = await resellers.allLinksFor(resellerId);
          const raised = await invoicesForAccounts([...new Set(links.map((one) => one.accountId))]);
          return { reseller, links, statements: commission.statements({ reseller, links, invoices: raised }) };
        };

        const renderList = async (notice?: string): Promise<SiteResponse> => {
          const all = await resellers.list();
          const rows = await Promise.all(all.map(async (reseller) => {
            const { statements } = await statementsFor(reseller.resellerId);
            const lifetime = commission.lifetime(statements);
            return {
              reseller,
              customerCount: (await resellers.accountsFor(reseller.resellerId)).length,
              commissionEarned: lifetime.commissionEarned,
              commissionPending: lifetime.commissionPending,
            };
          }));
          return {
            status: 200,
            html: resellerListPage({
              userEmail: request.user.email, csrf: request.csrf, resellers: rows, notice,
            }),
          };
        };

        if (rest === '') {
          if (request.method === 'POST') {
            if (request.form['csrf'] !== request.csrf) {
              return { status: 403, html: 'Stale form. Go back and try again.' };
            }
            const denied = refuse('reseller.manage');
            if (denied) return denied;
            try {
              await resellers.create({
                name: request.form['name'] ?? '',
                contactEmail: request.form['contactEmail'] ?? '',
                marginBasisPoints: basisPointsFrom(request.form['margin']),
                agreementStart: request.form['agreementStart'] ?? clock.iso().slice(0, 10),
                createdBy: operator.userId,
              });
            } catch (error) {
              return renderList(error instanceof Error ? error.message : 'That did not work.');
            }
            return { status: 303, redirect: '/console/resellers' };
          }
          return renderList();
        }

        const [resellerId, action] = rest.split('/');
        if (!resellerId) return { status: 404, html: 'No such reseller.' };

        const renderDetail = async (notice?: string): Promise<SiteResponse> => {
          const { reseller, statements } = await statementsFor(resellerId);
          const links = await resellers.accountsFor(resellerId);
          const customers = await Promise.all(links.map(async (link) => {
            const account = await accounts.get(link.accountId);
            return {
              accountId: link.accountId,
              name: account?.name ?? link.accountId,
              since: link.since,
              marginBasisPoints: link.marginBasisPoints ?? reseller.marginBasisPoints,
              isOverride: link.marginBasisPoints !== undefined,
            };
          }));
          return {
            status: 200,
            html: resellerDetailPage({
              userEmail: request.user.email, csrf: request.csrf, reseller, statements, customers,
              portalUserExists: Boolean(await users.byEmail('reseller', reseller.contactEmail)),
              territories: await territories.heldBy(resellerId),
              notice,
            }),
          };
        };

        if (request.method === 'POST') {
          if (request.form['csrf'] !== request.csrf) {
            return { status: 403, html: 'Stale form. Go back and try again.' };
          }

          if (action === 'portal') {
            // Creating a sign-in for a partner is user management.
            const deniedPortal = refuse('user.manage');
            if (deniedPortal) return deniedPortal;
            // Creating the sign-in does not set a password: the reseller sets
            // their own through the reset flow. An operator who types a
            // password for somebody else knows that password.
            const reseller = await resellers.get(resellerId);
            const existing = await users.byEmail('reseller', reseller.contactEmail);
            if (!existing) {
              await users.create({
                realm: 'reseller',
                email: reseller.contactEmail,
                name: reseller.contactName ?? reseller.name,
                password: randomBytes(24).toString('base64url'),
                roles: ['reseller'],
                resellerId,
              });
            }
            return renderDetail(
              `Portal sign-in created for ${reseller.contactEmail}. They set their own password `
              + 'from the sign-in page.',
            );
          }

          if (action === 'territory') {
            const grant = (request.form['area'] ?? '').trim();
            const withdraw = (request.form['withdraw'] ?? '').trim();
            try {
              if (withdraw) await territories.withdraw(withdraw);
              if (grant) {
                await territories.grant({
                  area: grant, resellerId, grantedBy: operator.userId, at: clock.iso(),
                });
              }
            } catch (error) {
              return renderDetail(error instanceof Error ? error.message : 'That did not work.');
            }
            return renderDetail('Territory updated.');
          }

          if (action === 'unlink') {
            await resellers.unlinkAccount(request.form['accountId'] ?? '');
            return renderDetail('Customer detached. Commission already earned is unchanged.');
          }

          try {
            await resellers.update(resellerId, {
              name: request.form['name'] || undefined,
              contactEmail: request.form['contactEmail'] || undefined,
              status: (request.form['status'] as 'active' | 'closed_to_new' | 'terminated')
                || undefined,
              marginBasisPoints: request.form['margin']
                ? basisPointsFrom(request.form['margin']) : undefined,
              banded: request.form['banded']
                ? request.form['banded'] === 'banded' : undefined,
            });
          } catch (error) {
            return renderDetail(error instanceof Error ? error.message : 'That did not work.');
          }
          return renderDetail('Terms saved.');
        }

        return renderDetail();
      }

      if (path === '' || path === 'accounts') {
        const list = await accounts.list();
        const subscriptions = new Map(
          (await Promise.all(list.map(async (account) => [
            account.accountId, await accounts.subscription(account.accountId),
          ] as const)))
            .filter((entry): entry is [string, NonNullable<typeof entry[1]>] => entry[1] !== undefined),
        );
        const pending = await consoleService.pendingApprovals(operator);
        return {
          status: 200,
          html: accountsListPage({
            accounts: list, subscriptions, nowIso,
            userEmail: request.user.email, pendingCount: pending.length,
          }),
        };
      }

      if (path.startsWith('accounts/')) {
        const tail = path.slice('accounts/'.length);

        // Attaching a customer to a reseller is a commercial commitment, so it
        // is a POST that records who made it, not a link.
        if (tail.endsWith('/reseller')) {
          const targetId = decodeURIComponent(tail.slice(0, -'/reseller'.length));
          if (request.method !== 'POST') {
            return { status: 303, redirect: `/console/accounts/${encodeURIComponent(targetId)}` };
          }
          if (request.form['csrf'] !== request.csrf) {
            return { status: 403, html: 'Stale form. Go back and try again.' };
          }
          const denied = refuse('reseller.manage');
          if (denied) return denied;
          const chosen = request.form['resellerId'] ?? '';
          if (chosen === '') {
            await resellers.unlinkAccount(targetId);
          } else {
            const override = (request.form['overrideMargin'] ?? '').trim();
            await resellers.linkAccount({
              accountId: targetId,
              resellerId: chosen,
              marginBasisPoints: override === '' ? undefined : basisPointsFrom(override),
              linkedBy: operator.userId,
            });
          }
          return { status: 303, redirect: `/console/accounts/${encodeURIComponent(targetId)}` };
        }

        const accountId = decodeURIComponent(tail);
        const account = await accounts.get(accountId);
        const subscription = account ? await accounts.subscription(accountId) : undefined;
        const rendered = await consoleSite.render({
          path: `/console/accounts/${accountId}`,
          query: { ...request.query, tenant: account?.tenantId ?? accountId },
          user: operator,
        });
        // The commercial terms are appended to the money summary the console
        // already renders, so an operator sees both without changing page.
        const link = await resellers.linkFor(accountId);
        const standard = link ? (await resellers.get(link.resellerId)).marginBasisPoints : undefined;
        const resellerControl = accountResellerControl({
          csrf: request.csrf,
          accountId,
          resellers: await resellers.list(),
          currentResellerId: link?.resellerId,
          currentMarginBasisPoints: link?.marginBasisPoints ?? standard,
          isOverride: link?.marginBasisPoints !== undefined,
        });
        let html = rendered.html.replace(
          '<h2>Credit lots</h2>',
          `${accountTermsSection(subscription, nowIso)}${resellerControl}<h2>Credit lots</h2>`,
        );
        if (account) {
          // An operator identifies a customer by name, not by an opaque id. The
          // id stays, below, because it is what they quote in a support thread.
          html = html
            .replace(`<h1>${escapeHtml(accountId)}</h1>`, `<h1>${escapeHtml(account.name)}</h1>`)
            .replace(
              /plan none · subscription none/,
              subscription
                ? `plan ${escapeHtml(subscription.planCode)} · ${escapeHtml(account.status)} · ${escapeHtml(accountId)}`
                : `no subscription · ${escapeHtml(account.status)} · ${escapeHtml(accountId)}`,
            );
        }
        return { status: rendered.status, html };
      }

      const rendered = await consoleSite.render({
        path: request.path, query: request.query, user: operator,
      });
      return { status: rendered.status, html: rendered.html };
    },
  });

  /**
   * The reseller portal.
   *
   * Every query is scoped by the signed-in user's own resellerId. There is no
   * route that takes a reseller id as a parameter, because a portal that
   * decided what to show from the URL would be one guessed id away from
   * showing a competitor's book.
   */
  const resellerRouter = new SiteRouter({
    realm: 'reseller',
    prefix: '/reseller',
    users, sessions, secret,
    secureCookies: options.secureCookies,
    passwordReset,
    baseUrl: options.baseUrl ?? '',
    async handler(request): Promise<SiteResponse> {
      const path = request.path.replace(/^\/reseller\/?/, '');
      const resellerId = request.user.resellerId;
      if (!resellerId) {
        // A reseller-realm user with no reseller attached is a configuration
        // error, not an intruder. Say so rather than showing an empty portal
        // that looks like they have no customers.
        return {
          status: 403,
          html: 'This sign-in is not attached to a reseller. Ask your Detent contact to fix it.',
        };
      }

      const reseller = await resellers.get(resellerId);
      const links = await resellers.allLinksFor(resellerId);
      const raised = await invoicesForAccounts([...new Set(links.map((one) => one.accountId))]);
      const statements = commission.statements({ reseller, links, invoices: raised });
      const sumMoney = (amounts: readonly Money[]): Money => sum(amounts, 'GBP');

      if (path === 'statements') {
        return {
          status: 200,
          html: resellerStatementsPage({ user: request.user, reseller, statements }),
        };
      }

      if (path === 'customers') {
        const current = await resellers.accountsFor(resellerId);
        const customers = await Promise.all(current.map(async (link) => {
          const account = await accounts.get(link.accountId);
          const lines = statements.flatMap((statement) =>
            statement.lines.filter((line) => line.accountId === link.accountId));
          return {
            accountId: link.accountId,
            name: account?.name ?? link.accountId,
            since: link.since,
            marginBasisPoints: link.marginBasisPoints ?? reseller.marginBasisPoints,
            lifetimeSpend: sumMoney(lines.filter((line) => line.state === 'earned')
              .map((line) => line.netAmount)),
            lifetimeCommission: sumMoney(lines.filter((line) => line.state === 'earned')
              .map((line) => line.commission)),
          };
        }));
        return {
          status: 200,
          html: resellerCustomersPage({ user: request.user, reseller, customers }),
        };
      }

      return {
        status: 200,
        html: resellerOverviewPage({
          user: request.user,
          reseller,
          statements,
          lifetime: commission.lifetime(statements),
          customerCount: (await resellers.accountsFor(resellerId)).length,
          territories: await territories.heldBy(resellerId),
        }),
      };
    },
  });

  const appRouter = new SiteRouter({
    realm: 'app',
    prefix: '/app',
    users, sessions, secret,
    allowSignUp: true,
    secureCookies: options.secureCookies,
    passwordReset,
    baseUrl: options.baseUrl ?? '',
    federated: [
      {
        id: 'google', label: 'Google', href: '/app/auth/google',
        configured: Boolean(options.googleConfigured),
      },
      {
        id: 'apple', label: 'Apple', href: '/app/auth/apple',
        configured: Boolean(options.appleConfigured),
      },
    ],
    async onSignUp(form) {
      const organisation = (form['organisation'] ?? '').trim();
      if (!organisation) throw new Error('An organisation name is required.');
      // Signing up creates the tenant and the account together, so a customer
      // never exists in one system and not the other.
      const tenantId = `t_${organisation.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24)}`;
      const account = await accounts.create({
        name: organisation,
        tenantId,
        billingEmail: form['email'] ?? '',
        countryCode: 'GB',
        createdBy: 'self_service',
      });
      // A self-service customer starts on Starter, rolling monthly, with the
      // plan's included credits. Leaving them with no subscription would show
      // them an empty billing page on their first visit and give the product
      // nothing to meter against.
      //
      // COMMERCIAL DECISION: this is the self-service default. Change the plan,
      // the term or the credits here when the trial terms are settled.
      await accounts.startSubscription({
        accountId: account.accountId,
        planCode: 'starter',
        term: 'rolling_monthly',
        billingInterval: 'monthly',
        startDate: clock.iso(),
        billingDay: Math.min(new Date(clock.iso()).getUTCDate(), 28),
        createdBy: 'self_service',
      });

      return users.create({
        realm: 'app',
        email: form['email'] ?? '',
        name: form['name'] ?? '',
        password: form['password'] ?? '',
        roles: ['owner'],
        tenantId,
        accountId: account.accountId,
      });
    },
    async handler(request): Promise<SiteResponse> {
      const path = request.path.replace(/^\/app\/?/, '');
      // Scoped by session, never by a parameter: a customer cannot ask for
      // another tenant's page because they never name a tenant at all.
      const account = request.user.accountId
        ? await accounts.get(request.user.accountId)
        : request.user.tenantId ? await accounts.byTenant(request.user.tenantId) : undefined;
      const subscription = account ? await accounts.subscription(account.accountId) : undefined;
      const balance = account ? await credits.balance(account.accountId) : undefined;

      if (path === 'billing') {
        return {
          status: 200,
          html: appBillingPage({ user: request.user, account, subscription, credits: balance }),
        };
      }

      // Support is deliberately not gated on paying. A customer whose
      // subscription has lapsed still needs to read how to restore it, and
      // putting that answer behind the thing that is broken is a support
      // policy that generates its own tickets.
      if (path === 'support' || path.startsWith('support/')) {
        const rest = path.replace(/^support\/?/, '');

        if (rest === 'request') {
          if (request.method === 'POST') {
            if (request.form['csrf'] !== request.csrf) {
              return { status: 403, html: 'Stale form. Go back and try again.' };
            }
            try {
              await supportRequests.raise({
                tenantId: request.user.tenantId ?? '',
                accountId: account?.accountId ?? '',
                raisedBy: request.user.email,
                subject: request.form['subject'] ?? '',
                detail: request.form['detail'] ?? '',
                askedFirst: request.form['askedFirst'],
              });
            } catch (error) {
              return {
                status: 400,
                html: supportRequestPage({
                  user: request.user, csrf: request.csrf,
                  about: request.form['subject'],
                  error: error instanceof Error ? error.message : 'That could not be sent.',
                }),
              };
            }
            return { status: 303, redirect: '/app/support?raised=1' };
          }
          return {
            status: 200,
            html: supportRequestPage({
              user: request.user, csrf: request.csrf, about: request.query['about'],
            }),
          };
        }

        if (rest.length > 0) {
          const article = articleBySlug(rest);
          if (!article) return { status: 404, html: 'No such support article.' };
          return {
            status: 200,
            html: supportArticlePage({
              user: request.user, article, related: relatedArticles(article),
            }),
          };
        }

        const asked = request.query['q'];
        return {
          status: 200,
          html: supportHomePage({
            user: request.user,
            asked,
            answer: asked ? supportAgent.ask(asked) : undefined,
            requests: account ? await supportRequests.forAccount(account.accountId) : [],
            csrf: request.csrf,
            notice: request.query['raised'] ? 'Request sent. We will reply by email.' : undefined,
            setupVideo: setupVideo,
          }),
        };
      }

      // Install, API and status are the product rather than a description of
      // it, so they sit behind a paying subscription. A prospect who can read
      // the integration guide and lift the endpoints has had the evaluation
      // free, and a public health endpoint tells anyone whether the service is
      // up, which is the first thing an attacker checks.
      if (path === 'install' || path === 'api' || path === 'status') {
        const entitlement = entitlementOf(subscription, account);
        const titles: Record<string, string> = {
          install: 'Install the assistant', api: 'API', status: 'Service status',
        };
        if (entitlement.state !== 'entitled' || !account || !subscription) {
          return {
            status: 402,
            html: upgradeRequiredPage({
              user: request.user, entitlement, what: titles[path]!, current: path,
            }),
          };
        }
        const apiBaseUrl = options.baseUrl || '';
        if (path === 'install') {
          return {
            status: 200,
            html: installPage({
              user: request.user, account, subscription, apiBaseUrl,
              widgetKey: options.widgetKeyFor?.(account.tenantId)
                ?? 'awa_pub_(issued when you go live)',
              panelUrl: `${apiBaseUrl}/widget/panel.html`,
            }),
          };
        }
        if (path === 'api') {
          return { status: 200, html: apiPage({ user: request.user, account, apiBaseUrl }) };
        }
        return {
          status: 200,
          html: statusPage({
            user: request.user, account, subscription, apiBaseUrl, killSwitch: 'OFF',
          }),
        };
      }

      if (path.startsWith('knowledge')) {
        const tenantId = request.user.tenantId ?? '';
        const render = async (extra: { notice?: string; error?: string } = {}): Promise<SiteResponse> => ({
          status: extra.error ? 400 : 200,
          html: knowledgePage({
            userEmail: request.user.email,
            csrf: request.csrf,
            documents: await documents.list(tenantId),
            queue: await knowledge.awaitingReview(tenantId),
            published: await knowledge.published(tenantId),
            summary: await knowledge.summary(tenantId),
            ...extra,
          }),
        });

        if (request.method !== 'POST') return render();

        try {
          if (path === 'knowledge/upload') {
            const boundary = boundaryOf(request.headers['content-type']);
            const raw = request.rawBodyBuffer;
            if (!boundary || !raw) return render({ error: 'That upload was not readable.' });
            const parts = parseMultipart(raw, boundary);
            if (!parts) return render({ error: 'That upload was not readable.' });
            // CSRF is checked here rather than by the router, because the router
            // only parses urlencoded bodies and a multipart post never reaches
            // its check. Skipping it would leave the one endpoint that accepts
            // files as the only one without the control.
            if (fieldOf(parts, 'csrf') !== request.csrf) {
              return { status: 403, html: '<p>That form has expired. Go back and try again.</p>' };
            }
            const file = fileOf(parts, 'file');
            if (!file) return render({ error: 'Choose a file to upload.' });

            const uploaded = await documents.upload({
              tenantId,
              filename: file.filename ?? 'document',
              bytes: file.bytes,
              uploadedBy: request.user.email,
              description: fieldOf(parts, 'description') || undefined,
            });
            const extracted = await documents.extract(uploaded.documentId, file.bytes);
            if (extracted.state === 'failed') {
              return render({ error: extracted.failureReason ?? 'That document could not be read.' });
            }
            const report = await knowledgeAgent.readDocument(extracted);
            await documents.markProcessed(extracted.documentId, report.proposed);
            return render({
              notice: `Read ${report.passagesRead} sections and proposed ${report.proposed} items`
                + (report.quarantined > 0
                  ? `. ${report.quarantined} passage${report.quarantined === 1 ? '' : 's'} quarantined, read those first.`
                  : '. Review them below; nothing is used until you approve it.'),
            });
          }

          if (path === 'knowledge/approve') {
            const draftId = request.form['draftId'] ?? '';
            // Only the figures actually ticked are confirmed. An unticked
            // figure blocks approval, which is the point.
            const confirmedFigures = Object.entries(request.form)
              .filter(([key]) => key.startsWith('figure_'))
              .map(([, value]) => value);
            await knowledge.approve({
              draftId,
              reviewedBy: request.user.email,
              editedTitle: request.form['editedTitle'],
              editedBody: request.form['editedBody'],
              editedQuestion: request.form['editedQuestion'],
              confirmedFigures,
            });
            return render({ notice: 'Published. The assistant can use it now.' });
          }

          if (path === 'knowledge/reject') {
            await knowledge.reject(
              request.form['draftId'] ?? '', request.user.email, request.form['reason'] ?? '',
            );
            return render({ notice: 'Rejected.' });
          }

          if (path === 'knowledge/manual') {
            await knowledge.addManual({
              tenantId,
              kind: (request.form['kind'] ?? 'faq') as KnowledgeKind,
              title: request.form['title'] ?? '',
              body: request.form['body'] ?? '',
              question: request.form['question'] || undefined,
              authoredBy: request.user.email,
            });
            return render({ notice: 'Published.' });
          }

          if (path === 'knowledge/remove') {
            await documents.remove(request.form['documentId'] ?? '');
            return render({ notice: 'Document removed.' });
          }
        } catch (error) {
          return render({ error: error instanceof Error ? error.message : 'That did not work.' });
        }
        return render();
      }
      return {
        status: 200,
        html: appOverviewPage({
          user: request.user, account, subscription, credits: balance, nowIso: clock.iso(),
        }),
      };
    },
  });

  return {
    consoleRouter, appRouter, resellerRouter, accounts, users, operatorEmail, operatorConfigured,
    emailSender, marketing, pages, copy,
    paymentProviderName: paymentProvider.name,
    sessionsPersist: !secretTooShort && Boolean(configuredSecret),
    sessionStoreDurable: Boolean(database),
  };
}
