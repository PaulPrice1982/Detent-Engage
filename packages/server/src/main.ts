/**
 * The entry point, in both modes.
 *
 * Boots a platform with the in-memory stores, one demo tenant on the sandbox
 * connector, and the HTTP gateway. Production wiring differs in exactly two
 * places, the store implementations and the model provider passed to
 * `new Platform(...)`, because both are behind interfaces.
 *
 *   pnpm serve
 *
 * The audit's SEC-3 finding applies to this file as much as to the composition
 * root: a deployment that boots on the in-memory stores loses its audit chain,
 * its consent events and its spend counters on restart. That is fine for a demo
 * and not fine for a pilot.
 *
 * So this file mode-switches rather than warning. On a development machine it
 * boots the demo tenant on in-memory stores as before. In a deployment
 * (DETENT_DEPLOYED, REPLIT_DEPLOYMENT or NODE_ENV=production) it first checks
 * that everything a durable boot needs is present and that the database
 * actually answers, and if anything is missing it serves the reasons instead of
 * starting. It does not exit: a process that exits is restarted, called a crash
 * loop, and its explanation ends up in a log somebody has to go and find.
 */
import { SandboxConnector } from '@detent/awa-connectors';
import { AnthropicModelProvider, ScriptedModelProvider, type ModelProvider } from '@detent/awa-agent';
import { ALL_FEATURES, JsonLogger, LocalKeyProvider, MetricsRegistry, featuresFromEnv } from '@detent/awa-core';
import { Api, ApiKeyService, Platform, RequestRateLimiter, createHttpServer, listenFailureMessage } from './index.js';
import { bootEnvironmentFrom, configurationProblems, databaseProblem } from './boot-config.js';
import { createNotConfiguredServer } from './not-configured-server.js';
import { buildDevSites } from './dev-sites.js';
import { createSiteMount } from './site-mount.js';
import { baseUrlFor, checkHosts, hostConfigFrom, recognisedHosts } from './host-routing.js';
import { senderFromEnvironment } from '@detent/awa-auth';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const logger = new JsonLogger({ service: 'awa', level: (process.env['AWA_LOG_LEVEL'] as 'info') ?? 'info' });
const metrics = new MetricsRegistry();

const port = Number(process.env['PORT'] ?? 8787);
// Bind to every interface by default. A loopback-only bind is unreachable from
// a container's preview proxy (Replit, Codespaces, Docker port mapping), which
// presents as "the preview is not loading" with a perfectly healthy process.
const host = process.env['HOST'] ?? '0.0.0.0';

/**
 * The deployment gate, before anything that could throw.
 *
 * Deliberately the first thing that runs. The fault this guards against is an
 * ordering fault: the code that explains a bad configuration existed and was
 * correct both times the deployment crash-looped, and both times something
 * above it constructed a store, threw, and took the process down before the
 * explanation could be served.
 */
const boot = bootEnvironmentFrom(process.env);
if (boot.deployed) {
  const problems = configurationProblems(boot);
  const unreachable = await databaseProblem(boot.databaseUrl, async (url) => {
    const { Database } = await import('@detent/awa-persistence');
    const probe = new Database({ connectionString: url, maxConnections: 1 });
    try {
      return await probe.healthy();
    } finally {
      await probe.close().catch(() => undefined);
    }
  });
  if (unreachable) problems.push(unreachable);

  if (problems.length > 0) {
    const refusal = createNotConfiguredServer({
      problems,
      log: (line) => console.error(line),
    });
    refusal.on('error', (error: NodeJS.ErrnoException) => {
      console.error(listenFailureMessage(error, port, host));
      process.exit(75);
    });
    refusal.listen(port, host);
    // Nothing below this point runs. Returning rather than exiting is the
    // whole point: the container stays up and answers with the reason.
    await new Promise<never>(() => {});
  }
}

/** Only ever reached on a development machine; a deployment must set AWA_MODEL. */
const DEVELOPMENT_MODEL = 'claude-sonnet-5';

/**
 * A real provider when a key is present, the scripted one otherwise.
 *
 * Not a fallback for convenience: the scripted provider is what makes the
 * governance suite deterministic, and a developer without an API key should
 * still be able to run the whole platform end to end.
 */
// The model id comes from configuration and is validated against
// SUPPORTED_MODELS at the gate above before a deployment reaches this line. A
// hard-coded default is a guess that goes wrong silently: the provider answers
// 404 for a retired name and the assistant is simply unavailable, with nothing
// pointing at a string in a source file as the reason.
const model: ModelProvider = boot.modelKey
  ? new AnthropicModelProvider({ model: boot.model ?? DEVELOPMENT_MODEL })
  // Without a key there is no model, and the reference provider answers
  // everything with one sentence. For a demonstration that is indistinguishable
  // from a broken assistant, so the demo flag also loads a scripted
  // qualification. It is fixed text, never a model, and never reachable in a
  // deployment, which cannot boot without a key in the first place.
  : new ScriptedModelProvider(process.env['AWA_DEMO_SEED'] === '1' && !boot.deployed
    ? (await import('./demo-seed.js')).DEMO_CONVERSATION
    : [{ match: /.*/, output: { text: 'Thanks, what are you trying to solve?', confidence: 0.9 } }]);

const crm = new SandboxConnector({ hasSeparateLeadObject: true });
const platform = new Platform({
  model,
  connectors: [crm],
  logger,
  metrics,
  // Everything on in development, so the surfaces behind flags are reachable.
  // A deployment gets `SPINE_FEATURES` unless it says otherwise.
  features: featuresFromEnv(process.env, ALL_FEATURES),
  // Credentials are encrypted at rest even here (audit SEC-4). A generated
  // root key means a restart cannot read the previous run's credentials, which
  // is the honest behaviour for a process that also loses everything else.
  keyProvider: new LocalKeyProvider(process.env['AWA_ROOT_KEY'] ?? LocalKeyProvider.generateRootKey()),
  checkpointKey: process.env['AWA_CHECKPOINT_KEY'],
  // Install verification fetches the tenant's own page and looks for the
  // snippet. Disabled unless the deployment opts in, because an endpoint that
  // fetches an arbitrary URL on request is a server-side request forgery
  // surface and the allowlist belongs to the operator.
  pageProbe: process.env['AWA_ALLOW_PAGE_PROBE'] === '1'
    ? async (url: string) => {
        const target = new URL(url);
        if (target.protocol !== 'https:') throw new Error('only https pages can be verified');
        const response = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(5_000) });
        return (await response.text()).slice(0, 200_000);
      }
    : undefined,
});

const TENANT = process.env['AWA_TENANT_ID'] ?? 't_demo';
const ORIGINS = (process.env['AWA_ORIGINS'] ?? 'http://localhost:8787').split(',').map((o) => o.trim()).filter(Boolean);

platform.tenants.create({
  tenantId: TENANT,
  name: process.env['AWA_TENANT_NAME'] ?? 'Demo Ltd',
  connector: 'sandbox',
  serviceCatalogue: ['contract-review', 'revenue-recovery'],
  outboundAllowlist: (process.env['AWA_ALLOWLIST'] ?? '').split(',').filter(Boolean),
  // A widget key is refused from any origin not registered here (audit SEC-5).
  origins: ORIGINS,
});
await platform.tenants.recordDpa(TENANT, 'DPA-DEV');
await platform.connectCrm(TENANT, 'sandbox', { kind: 'oauth2', accessToken: 'dev-token' });
await platform.tenants.transition(TENANT, 'CRM_CONNECTED', 'tenant');
await platform.tenants.transition(TENANT, 'MAPPED', 'tenant');
platform.tenants.acceptFieldMapping(TENANT);
await platform.tenants.transition(TENANT, 'TEST_MODE', 'tenant');
await platform.tenants.transition(TENANT, 'LIVE', 'tenant');

const keys = new ApiKeyService();
const api = new Api(platform, {
  keys,
  logger,
  metrics,
  limiter: new RequestRateLimiter(undefined, platform.clock),
});

const widget = keys.issue(TENANT, 'widget', { label: 'development', origins: ORIGINS });
const admin = keys.issue(TENANT, 'tenant_admin', { label: 'development' });
const platformAdmin = keys.issue('*platform*', 'platform_admin', { label: 'development' });

/**
 * The websites: marketing, the customer area, the reseller portal, the console.
 *
 * Built here and passed to the transport. Until this existed every sign-in
 * page, the console and the customer area answered 404 in a deployment,
 * because the pieces were all written and none of them were joined.
 */
const hosts = hostConfigFrom(process.env, boot.deployed);
const hostProblems = checkHosts(hosts, boot.deployed);
if (hostProblems.length > 0 && boot.deployed) {
  const refusal = createNotConfiguredServer({
    problems: hostProblems.map((problem) => problem.message),
    log: (line) => console.error(line),
  });
  refusal.on('error', (error: NodeJS.ErrnoException) => {
    console.error(listenFailureMessage(error, port, host));
    process.exit(75);
  });
  refusal.listen(port, host);
  await new Promise<never>(() => {});
}

// Where this deployment is reachable, for links in emails and social cards.
// A reset link is followed from a mail client, so a relative one is useless.
const fallbackOrigin = process.env['DETENT_BASE_URL']?.trim() || `http://localhost:${port}`;

/**
 * The database, when one is configured.
 *
 * Every store in the sites below is Postgres-backed when this is present and
 * in memory when it is not, which is the difference between a console user who
 * still exists after a restart and one who does not. The entry point passed
 * nothing here, so the staff accounts, their sessions and their password-reset
 * tokens were in memory even in a deployment that had a database.
 */
const siteDatabase = boot.databaseUrl
  ? new (await import('@detent/awa-persistence')).Database({ connectionString: boot.databaseUrl })
  : undefined;

const sites = await buildDevSites({
  audit: platform.audit,
  clock: platform.clock,
  ...(siteDatabase ? { database: siteDatabase } : {}),
  sessionSecret: process.env['DETENT_SESSION_SECRET'],
  operatorEmail: process.env['DETENT_CONSOLE_EMAIL'],
  operatorPassword: process.env['DETENT_CONSOLE_PASSWORD'],
  // A cookie without Secure is a cookie sent over plain HTTP, which on a
  // development box is the only way it can be sent at all.
  secureCookies: boot.deployed,
  // Reset links are followed from a mail client, so a relative one is useless.
  baseUrl: baseUrlFor('app', hosts, fallbackOrigin),
  appBaseUrl: baseUrlFor('app', hosts, fallbackOrigin),
  // Without this a reset email is written to stdout, which looks like it
  // worked and delivers a credential to the log aggregator instead of to the
  // person who asked for it.
  emailSender: senderFromEnvironment(process.env),
  deployed: boot.deployed,
  stripeSecretKey: process.env['STRIPE_SECRET_KEY'],
  stripeWebhookSecret: process.env['STRIPE_WEBHOOK_SECRET'],
  widgetKeyFor: () => widget.key,
});

/**
 * Demonstration fixtures, off unless explicitly asked for and never deployed.
 *
 * The approval queue is in process memory, so the only place that can put an
 * action on it is this process. Without this, a walkthrough of dual control
 * has to be described rather than shown.
 */
const demoSeeded = process.env['AWA_DEMO_SEED'] === '1' && !boot.deployed
  // A fixture must never be able to stop the server starting. It writes to the
  // same services the console writes to, and those refuse things: the point of
  // the refusal is lost if the refusal takes the process down.
  ? await (await import('./demo-seed.js')).seedDemoActions({
      consoleService: sites.consoleService,
      users: sites.users,
      accounts: sites.accounts,
      deployed: boot.deployed,
    }).catch((error: unknown) => {
      console.error(`  demo seed failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    })
  : [];

const siteMount = createSiteMount({
  sites,
  hosts,
  canonicalOrigin: baseUrlFor('marketing', hosts, fallbackOrigin),
});

const here = dirname(fileURLToPath(import.meta.url));
const staticMounts = [
  { prefix: '/widget', dir: resolve(here, '../../widget/public') },
  { prefix: '', dir: resolve(here, '../public') },
];

// Sweeps expired sessions and publishes gauges (audit PERF-7).
platform.startMaintenance();

const server = createHttpServer(api, {
  port,
  sites: [siteMount],
  allowedOrigins: ORIGINS,
  panelFrameAncestors: ORIGINS,
  hsts: process.env['AWA_HSTS'] === '1',
  trustProxy: process.env['AWA_TRUST_PROXY'] === '1',
  staticMounts,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    platform.stopMaintenance();
    server.close(() => process.exit(0));
  });
}

// A failed listen is a message, not a stack trace through node:net. The
// commonest cause is an earlier instance still holding the port, which on a
// platform running a managed process presents as the new release simply not
// starting, with the reason four lines into an exception nobody reads.
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(listenFailureMessage(error, port, host));
  // 75 is EX_TEMPFAIL: a supervisor should retry, because the port may be
  // freed by whatever is holding it. A crash loop here is a true statement
  // about the environment rather than a fault in the release.
  process.exit(75);
});

server.listen(port, host, () => {
  // Printed once, at boot, on a development server only. Keys are stored as
  // digests, so this is the only moment they exist in readable form.
  console.log(`Detent Agentic Website Assistant listening on ${host}:${port}`);
  console.log(`  open             http://localhost:${port}/`);
  console.log(`  console          http://localhost:${port}/console.html`);
  console.log(`  tenant           ${TENANT}`);
  console.log(`  model            ${model.id}`);
  console.log(`  hosts            ${recognisedHosts(hosts).join(', ') || '(path prefixes)'}`);
  console.log(`  operator         ${sites.operatorConfigured ? sites.operatorEmail : 'not configured; set DETENT_CONSOLE_PASSWORD'}`);
  // Both, because they fail differently: a regenerated secret invalidates every
  // cookie, and an in-memory store loses the sessions the cookies name.
  console.log(`  sessions         ${sites.sessionsPersist && sites.sessionStoreDurable
    ? 'survive a restart'
    : `lost on restart (${[
        sites.sessionsPersist ? undefined : 'no stable DETENT_SESSION_SECRET',
        sites.sessionStoreDurable ? undefined : 'no DATABASE_URL',
      ].filter(Boolean).join(', ')})`}`);
  console.log(`  payments         ${sites.paymentProviderName}`);
  for (const action of demoSeeded) console.log(`  demo action      ${action.state.padEnd(16)} ${action.summary}`);
  if (boot.printKeys) {
    // Keys are stored as digests, so this is the only moment they exist in
    // readable form. Printed only when asked for, and never in production:
    // a key on stdout is a key in whatever aggregates the logs, held by
    // whoever can read them and for as long as they are retained.
    console.log(`  widget key       ${widget.key}`);
    console.log(`  tenant admin key ${admin.key}`);
    console.log(`  platform key     ${platformAdmin.key}`);
  } else {
    console.log('  api keys         hidden; set AWA_DEV_PRINT_KEYS=1 to print them');
  }
  console.log('');
  if (!platform.durable) {
    console.log('  NOTE: this process is running on the in-memory stores. The audit chain,');
    console.log('        consent events, spend counters and tenant configuration are lost on');
    console.log('        restart. Pass the Postgres adapters from @detent/awa-db before a pilot.');
    console.log('');
  }
  if (boot.printKeys) {
    console.log(`  curl -s -XPOST localhost:${port}/v1/sessions -H "authorization: Bearer ${widget.key}" -H 'origin: ${ORIGINS[0]}' -H 'content-type: application/json' -d '{"jurisdiction":"UK"}'`);
  }
});
