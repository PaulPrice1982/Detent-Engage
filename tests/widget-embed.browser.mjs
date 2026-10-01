// Run with the repository TS loader; PLAYWRIGHT_MODULE can name an installed
// playwright package and BROWSER_EXECUTABLE can select a local Chromium binary.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHttpServer } from '@detent/awa-server';
import { buildHarness } from './fixtures/tenant.ts';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const harness = await buildHarness({ script: [{ match: /.*/, output: { text: 'We audit commercial agreements.' } }] });
const origins = [];
const traffic = [];
const api = createHttpServer({ handle: async request => {
  traffic.push({ path: request.path, origin: request.headers.origin });
  return harness.api.handle(request);
} }, {
  allowedOrigins: origins, panelFrameAncestors: origins,
  staticMounts: [{ prefix: '/widget', dir: fileURLToPath(new URL('../packages/widget/public', import.meta.url)) }],
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
let browser;
let host;
let outsider;
try {
  const apiOrigin = await listen(api);
  host = createServer((_request, response) => response.end(`<!doctype html><html><body>
    <script type="module" src="${apiOrigin}/widget/loader.js" data-detent-assistant
      data-api="${apiOrigin}" data-panel="${apiOrigin}/widget/panel.html" data-key="${harness.widgetKey}"></script>
    </body></html>`));
  outsider = createServer((_request, response) => response.end('<!doctype html><title>Unregistered</title>'));
  const hostOrigin = await listen(host);
  const outsiderOrigin = await listen(outsider);
  // CORS allows both test origins so a 403 demonstrates API enforcement, not
  // just unreadable responses. Only the customer origin belongs to the tenant.
  origins.push(hostOrigin, outsiderOrigin);
  await harness.platform.tenants.applyOperatorPatch(harness.config.tenantId, { origins: [hostOrigin] }, 'browser test');
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(hostOrigin);
  const launcher = page.locator('detent-assistant button.launcher');
  await launcher.click();
  const panel = page.frameLocator('detent-assistant iframe');
  await panel.locator('#message').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('detent-assistant')?.shadowRoot?.querySelector('iframe'));
  await panel.locator('#message').fill('What do you do?');
  await panel.locator('#send').click();
  await panel.locator('#log').getByText('We audit commercial agreements.', { exact: true }).waitFor();
  assert(traffic.some(t => t.path === '/v1/sessions' && t.origin === hostOrigin));
  assert(traffic.some(t => t.path.endsWith('/stream')));
  assert(traffic.filter(t => t.path.startsWith('/v1/sessions')).every(t => t.origin === hostOrigin));
  assert.equal(await page.locator('detent-assistant iframe').getAttribute('sandbox'), 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox');
  const count = traffic.length;
  const frame = page.frames().find(f => f.url().includes('/panel.html'));
  const forbidden = await frame.evaluate(() => new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data.status); };
    parent.postMessage({ source: 'detent-assistant', type: 'request', method: 'POST', path: '/v1/admin/t_acme/keys', body: '{}' },
      new URLSearchParams(location.search).get('host_origin'), [channel.port2]);
  }));
  assert.equal(forbidden, 400);
  await page.evaluate(() => new Promise(resolve => {
    window.postMessage({ source: 'detent-assistant', type: 'close' }, '*');
    setTimeout(resolve, 50);
  }));
  assert.equal(await page.locator('detent-assistant iframe').count(), 1);
  assert.equal(traffic.length, count);
  await panel.locator('#close').click();
  await page.locator('detent-assistant iframe').waitFor({ state: 'detached' });
  assert.equal(await launcher.evaluate(element => element.getRootNode().activeElement === element), true);
  const other = await browser.newPage();
  await other.goto(outsiderOrigin);
  const status = await other.evaluate(async ({ apiOrigin, key }) => (await fetch(`${apiOrigin}/v1/sessions`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{}',
  })).status, { apiOrigin, key: harness.widgetKey });
  assert.equal(status, 403);
  const opaque = await harness.api.handle({ method: 'POST', path: '/v1/sessions', headers: { authorization: `Bearer ${harness.widgetKey}`, origin: 'null' }, body: {} });
  assert.equal(opaque.status, 403);
  assert.deepEqual(errors, []);
  console.log('PASS: cross-origin embedded conversation, customer Origin, sandbox, close/focus, forged close, unregistered and null-origin rejection');
} finally {
  await browser?.close();
  if (host) await close(host);
  if (outsider) await close(outsider);
  await close(api);
}
