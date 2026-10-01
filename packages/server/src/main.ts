/**
 * The entry point, in both modes.
 *
 * Without a database, boots a development demo in memory. With a database,
 * restores assistant state under a single-writer lease and wires Postgres
 * evidence stores before accepting traffic. Production never seeds demo CRM
 * credentials or replaces existing API keys at boot.
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
import { SandboxConnector, FetchHttpClient, HubSpotConnector, SalesforceConnector, DynamicsConnector, PipedriveConnector, ZohoConnector } from '@detent/awa-connectors';
import { Database, PostgresPlanCatalogueStore } from '@detent/awa-persistence';
import { PlanCatalogueService, InMemoryPlanCatalogueStore } from '@detent/awa-billing';
import { DurableRuntime } from './runtime-state.js';
import { PostgresRuntimeArchive, durablePlatformStores } from './runtime-postgres.js';
import { AnthropicModelProvider, ScriptedModelProvider, type ModelProvider } from '@detent/awa-agent';
import { ALL_FEATURES, JsonLogger, LocalKeyProvider, MetricsRegistry, featuresFromEnv } from '@detent/awa-core';
import { Api, ApiKeyService, Platform, RequestRateLimiter, createHttpServer, listenFailureMessage } from './index.js';
import { bootEnvironmentFrom, configurationProblems, databaseProblem } from './boot-config.js';
import { createNotConfiguredServer } from './not-configured-server.js';
import {
  ElevenLabsSpeech, VoiceNotConfigured, type SpeechSynthesiser,
} from '@detent/awa-voice';
import { buildDevSites } from './dev-sites.js';
import { CustomerWidgetProvisioner } from './customer-widgets.js';
import { InMemoryDocumentStore, InMemoryDraftStore } from '@detent/awa-ingestion';
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

/**
 * The assistant's mouth, or one that refuses and says why.
 *
 * Constructed here rather than inside the platform so that the vendor key
 * never leaves this file's scope, and so a deployment that does not want a
 * spoken assistant simply does not set it. The text assistant is the full
 * product; voice is an addition to it and never a prerequisite.
 */
const demoVoiceDirectory = new URL('../../../docs/demo/audio/voice/', import.meta.url).pathname;
const speech: SpeechSynthesiser = boot.voiceKey
  ? new ElevenLabsSpeech({ apiKey: boot.voiceKey, voiceId: boot.voiceId })
  // Without a key there is no vendor. The demonstration flag serves the same
  // words from recordings made by the configured voice, exactly as it serves
  // a scripted conversation in place of a model. Never in a deployment, which
  // cannot boot without its own keys in the first place.
  : process.env['AWA_DEMO_SEED'] === '1' && !boot.deployed
    ? new (await import('./demo-speech.js')).DemoSpeech(demoVoiceDirectory)
    : new VoiceNotConfigured();

// A database-backed runtime owns an exclusive lease before reading cached state.
// Until the synchronous domain models support distributed transactions, refuse
// a second serving instance rather than let it overwrite another's state.
const siteDatabase = boot.databaseUrl ? new Database({ connectionString: boot.databaseUrl }) : undefined;
if (siteDatabase && !boot.rootKey) throw new Error('AWA_ROOT_KEY is required for durable runtime storage.');
if (siteDatabase && !boot.checkpointKey) throw new Error('AWA_CHECKPOINT_KEY is required for durable audit checkpoints.');
const releaseRuntimeLease = await siteDatabase?.acquireRuntimeLease(() => {
  console.error('Runtime database lease lost; stopping to prevent conflicting writers.');
  process.exit(75);
});
const http = new FetchHttpClient();
const realConnectors = [new HubSpotConnector(http), new SalesforceConnector(http),
  new DynamicsConnector(http), new PipedriveConnector(http), new ZohoConnector(http)];
const crm = new SandboxConnector({ hasSeparateLeadObject: true });
const catalogue = new PlanCatalogueService(siteDatabase ? new PostgresPlanCatalogueStore(siteDatabase) : new InMemoryPlanCatalogueStore());
await catalogue.seed();
const platform = new Platform({
  catalogue,
  model,
  speech,
  connectors: boot.deployed ? realConnectors : [crm, ...realConnectors],
  ...(siteDatabase ? durablePlatformStores(siteDatabase, boot.rootKey!) : {}),
  logger,
  metrics,
  // Everything on in development, so the surfaces behind flags are reachable.
  // A deployment gets `SPINE_FEATURES` unless it says otherwise.
  features: featuresFromEnv(process.env, ALL_FEATURES),
  // Durable boots require the stable key above. Only an ephemeral development
  // runtime may generate one.
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

const keys = new ApiKeyService();
const customerKnowledge = { corpus: platform.corpus, documents: new InMemoryDocumentStore(), drafts: new InMemoryDraftStore() };
const customerWidgets = new CustomerWidgetProvisioner(platform.tenants, keys, boot.deployed ? 'unconfigured' : 'sandbox');
const runtime = siteDatabase ? new DurableRuntime(
  new PostgresRuntimeArchive(siteDatabase, platform.keyring), platform, keys, customerWidgets, customerKnowledge,
) : undefined;
await runtime?.restore();
await runtime?.flush();
if (boot.deployed && !platform.durable) throw new Error('Deployment requires durable assistant stores.');

// Demo fixtures and printed credentials exist only in an ephemeral development
// runtime. A durable boot restores its identities and never reissues its keys.
let widget: ReturnType<ApiKeyService['issue']> | undefined;
let admin: ReturnType<ApiKeyService['issue']> | undefined;
let platformAdmin: ReturnType<ApiKeyService['issue']> | undefined;
if (!siteDatabase && !boot.deployed) {
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
  widget = keys.issue(TENANT, 'widget', { label: 'development', origins: ORIGINS });
  admin = keys.issue(TENANT, 'tenant_admin', { label: 'development' });
  platformAdmin = keys.issue('*platform*', 'platform_admin', { label: 'development' });
}

const api = new Api(platform, {
  keys,
  logger,
  metrics,
  limiter: new RequestRateLimiter(undefined, platform.clock),
});


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

const sites = await buildDevSites({
  catalogue,
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
  customerWidgets,
  customerKnowledge,
});

/**
 * Demonstration fixtures, off unless explicitly asked for and never deployed.
 *
 * Fixtures exercise dual control without operator setup in a local demo.
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
if (!runtime) platform.startMaintenance();
const durableMaintenance = runtime ? setInterval(() => {
  void runtime.run(async () => {
    platform.sessions.sweep();
    await platform.reconciliation.runOnce();
  }).catch(() => console.error('Durable runtime maintenance failed; restart required.'));
}, 60_000) : undefined;
durableMaintenance?.unref();

const server = createHttpServer(runtime ? { handle: request => {
  // Probes must not queue behind a slow model call or rewrite the snapshot.
  if (request.method === 'GET' && ['/health', '/livez'].includes(request.path)) return api.handle(request);
  if (request.method === 'GET' && request.path === '/readyz') {
    return runtime.ready ? api.handle(request)
      : Promise.resolve({ status: 503, body: { status: 'not_ready', durable: true } });
  }
  return runtime.api(() => api.handle(request));
} } : api, {
  port,
  sites: [runtime ? { ...siteMount, handle: request => runtime.run(() => siteMount.handle(request)) } : siteMount],
  get allowedOrigins() { return [...new Set([...ORIGINS, ...platform.tenants.list().flatMap(t => t.origins)])]; },
  get panelFrameAncestors() { return [...new Set([...ORIGINS, ...platform.tenants.list().flatMap(t => t.origins)])]; },
  hsts: process.env['AWA_HSTS'] === '1',
  trustProxy: process.env['AWA_TRUST_PROXY'] === '1',
  staticMounts,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    platform.stopMaintenance();
    if (durableMaintenance) clearInterval(durableMaintenance);
    server.close(() => {
      void (async () => {
        await runtime?.run(async () => undefined);
        await releaseRuntimeLease?.();
        await siteDatabase?.close();
        process.exit(0);
      })().catch(() => process.exit(1));
    });
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
  // Both halves, because the two failures look identical from the outside and
  // need different fixes: a flag that is off is a decision, and a flag that is
  // on with nothing behind it is a microphone that does nothing.
  console.log(`  voice            ${platform.canSpeak
    ? `${platform.speech.name}, speaking`
    : platform.features.spokenVoice
      ? 'OFFERED BUT SILENT; set DETENT_VOICE_API_KEY'
      : 'text only (AWA_FEATURE_SPOKEN_VOICE=1 to offer it)'}`);
  for (const action of demoSeeded) console.log(`  demo action      ${action.state.padEnd(16)} ${action.summary}`);
  if (boot.printKeys && widget && admin && platformAdmin) {
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
  if (boot.printKeys && widget) {
    console.log(`  curl -s -XPOST localhost:${port}/v1/sessions -H "authorization: Bearer ${widget.key}" -H 'origin: ${ORIGINS[0]}' -H 'content-type: application/json' -d '{"jurisdiction":"UK"}'`);
  }
});
