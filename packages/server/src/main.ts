/**
 * Development entry point.
 *
 * Boots a platform with the in-memory stores, one demo tenant on the sandbox
 * connector, and the HTTP gateway. Production wiring differs in exactly two
 * places — the store implementations and the model provider passed to
 * `new Platform(...)` — because both are behind interfaces.
 *
 *   pnpm serve
 *
 * The audit's SEC-3 finding applies to this file as much as to the composition
 * root: a deployment that boots on the in-memory stores loses its audit chain,
 * its consent events and its spend counters on restart. That is fine for a demo
 * and not fine for a pilot, so this says so on stdout at boot rather than
 * leaving someone to find out.
 */
import { SandboxConnector } from '@detent/awa-connectors';
import { AnthropicModelProvider, ScriptedModelProvider, type ModelProvider } from '@detent/awa-agent';
import { ALL_FEATURES, JsonLogger, LocalKeyProvider, MetricsRegistry, featuresFromEnv } from '@detent/awa-core';
import { Api, ApiKeyService, Platform, RequestRateLimiter, createHttpServer } from './index.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const logger = new JsonLogger({ service: 'awa', level: (process.env['AWA_LOG_LEVEL'] as 'info') ?? 'info' });
const metrics = new MetricsRegistry();

/**
 * A real provider when a key is present, the scripted one otherwise.
 *
 * Not a fallback for convenience: the scripted provider is what makes the
 * governance suite deterministic, and a developer without an API key should
 * still be able to run the whole platform end to end.
 */
const model: ModelProvider = process.env['ANTHROPIC_API_KEY']
  ? new AnthropicModelProvider({ model: process.env['AWA_MODEL'] ?? 'claude-opus-5' })
  : new ScriptedModelProvider([
      { match: /.*/, output: { text: 'Thanks — what are you trying to solve?', confidence: 0.9 } },
    ]);

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

const port = Number(process.env['PORT'] ?? 8787);
// Bind to every interface by default. A loopback-only bind is unreachable from
// a container's preview proxy (Replit, Codespaces, Docker port mapping), which
// presents as "the preview is not loading" with a perfectly healthy process.
const host = process.env['HOST'] ?? '0.0.0.0';

const here = dirname(fileURLToPath(import.meta.url));
const staticMounts = [
  { prefix: '/widget', dir: resolve(here, '../../widget/public') },
  { prefix: '', dir: resolve(here, '../public') },
];

// Sweeps expired sessions and publishes gauges (audit PERF-7).
platform.startMaintenance();

const server = createHttpServer(api, {
  port,
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

server.listen(port, host, () => {
  // Printed once, at boot, on a development server only. Keys are stored as
  // digests, so this is the only moment they exist in readable form.
  console.log(`Detent Agentic Website Assistant listening on ${host}:${port}`);
  console.log(`  open             http://localhost:${port}/`);
  console.log(`  console          http://localhost:${port}/console.html`);
  console.log(`  tenant           ${TENANT}`);
  console.log(`  model            ${model.id}`);
  console.log(`  widget key       ${widget.key}`);
  console.log(`  tenant admin key ${admin.key}`);
  console.log(`  platform key     ${platformAdmin.key}`);
  console.log('');
  if (!platform.durable) {
    console.log('  NOTE: this process is running on the in-memory stores. The audit chain,');
    console.log('        consent events, spend counters and tenant configuration are lost on');
    console.log('        restart. Pass the Postgres adapters from @detent/awa-db before a pilot.');
    console.log('');
  }
  console.log(`  curl -s -XPOST localhost:${port}/v1/sessions -H "authorization: Bearer ${widget.key}" -H 'origin: ${ORIGINS[0]}' -H 'content-type: application/json' -d '{"jurisdiction":"UK"}'`);
});
