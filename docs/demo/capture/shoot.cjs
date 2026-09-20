const { chromium } = require('./node_modules/playwright');
const fs = require('fs');
const need = function (name) {
  var value = process.env[name];
  // Refuse rather than sign in as nobody: a capture that runs with an
  // empty password photographs a sign-in page and calls it a console.
  if (!value) throw new Error('Set ' + name + '. See docs/demo/capture/README.md.');
  return value;
};
const OUT = __dirname + '/shots';
const BASE = 'http://127.0.0.1:8901';
const WK = fs.readFileSync(__dirname + '/wk.txt', 'utf8').trim();

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const log = [];

  const shot = async (name, path, opts = {}) => {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: opts.full ?? false });
    log.push(`${name}  <-  ${path}  (${page.url()})`);
  };

  // ---- public surfaces -----------------------------------------------------
  await shot('01-marketing-home', '/');
  await shot('02-product', '/product.html', { full: true });
  await shot('03-trust', '/trust.html', { full: true });
  await shot('04-assurance', '/assurance.html', { full: true });
  await shot('05-pricing-public', '/pricing.html', { full: true });

  // ---- staff console: signed out then in -----------------------------------
  await shot('06-console-signin', '/console/signin');

  await page.goto(`${BASE}/console/signin`, { waitUntil: 'networkidle' });
  await page.fill('input[name="email"]', 'ops@detentgtm.io');
  await page.fill('input[name="password"]', need('OPERATOR_PASSWORD'));
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
                     page.click('button[type="submit"]')]);
  await page.waitForTimeout(800);
  await shot('07-console-accounts', '/console', { full: true });
  await shot('08-console-new-account', '/console/new', { full: true });
  await shot('09-console-pricing', '/console/pricing', { full: true });
  await shot('10-console-bundles', '/console/bundles', { full: true });
  await shot('11-console-resellers', '/console/resellers', { full: true });
  await shot('12-console-approvals', '/console/approvals', { full: true });

  // The account with the contract on it.
  const accounts = await page.$$eval('a[href^="/console/accounts/"]', (as) => as.map((a) => a.getAttribute('href')));
  await page.goto(`${BASE}/console`, { waitUntil: 'networkidle' });
  const rows = await page.$$eval('a[href^="/console/accounts/"]', (as) =>
    as.map((a) => [a.getAttribute('href'), a.textContent.trim()]));
  log.push('account links: ' + JSON.stringify(rows.slice(0, 8)));
  const northwind = (rows.find((r) => /Northwind/i.test(r[1])) ?? rows[0] ?? [])[0];
  if (northwind) await shot('13-console-account-contract', northwind, { full: true });

  // ---- customer app --------------------------------------------------------
  const app = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const ap = await app.newPage();
  const ashot = async (name, path, full = true) => {
    await ap.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }).catch(() => {});
    await ap.waitForTimeout(500);
    await ap.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
    log.push(`${name}  <-  ${path}  (${ap.url()})`);
  };
  await ashot('14-app-signin', '/app/signin', false);
  await ap.goto(`${BASE}/app/signin`, { waitUntil: 'networkidle' });
  await ap.fill('input[name="email"]', 'd.harper@northwind.example');
  await ap.fill('input[name="password"]', need('APP_PASSWORD'));
  await Promise.all([ap.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
                     ap.click('button[type="submit"]')]);
  await ap.waitForTimeout(800);
  await ashot('15-app-overview', '/app');
  await ashot('16-app-install', '/app/install');
  await ashot('17-app-knowledge', '/app/knowledge');
  await ashot('18-app-billing', '/app/billing');
  await ashot('19-app-branding', '/app/branding');

  // ---- the visitor panel, driven for real ---------------------------------
  const panel = `/widget/panel.html?key=${encodeURIComponent(WK)}&api=${encodeURIComponent(BASE)}&jurisdiction=UK`;
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const mp = await phone.newPage();
  await mp.goto(`${BASE}${panel}`, { waitUntil: 'networkidle' });
  await mp.waitForTimeout(1500);
  await mp.screenshot({ path: `${OUT}/20-widget-open-mobile.png` });
  log.push('20-widget-open-mobile');

  const dp = await ctx.newPage();
  await dp.goto(`${BASE}${panel}`, { waitUntil: 'networkidle' });
  await dp.waitForTimeout(1500);
  await dp.screenshot({ path: `${OUT}/21-widget-open.png` });

  const say = async (text) => {
    const box = await dp.$('textarea, input[type="text"]:not([type=hidden])');
    if (!box) { log.push('NO COMPOSER FOUND'); return false; }
    await box.fill(text);
    await box.press('Enter');
    await dp.waitForTimeout(2200);
    return true;
  };
  const lines = [
    "We run 40 vans out of two depots in the Midlands. Our telematics contract ends in March and I'm looking at replacing it.",
    '40 vehicles, and we’d want driver behaviour scoring as well as tracking.',
    "There's a 90 day notice period before March, so it's tighter than it looks.",
    "It's my call, I run the fleet.",
    'd.harper@northwind.example',
  ];
  for (let i = 0; i < lines.length; i += 1) {
    const ok = await say(lines[i]);
    if (!ok) break;
    await dp.screenshot({ path: `${OUT}/22-widget-turn-${i + 1}.png` });
  }
  log.push('widget transcript captured');
  await mp.goto(`${BASE}${panel}`, { waitUntil: 'networkidle' });
  await mp.waitForTimeout(1200);
  const mbox = await mp.$('textarea, input[type="text"]:not([type=hidden])');
  if (mbox) { await mbox.fill(lines[0]); await mbox.press('Enter'); await mp.waitForTimeout(2500); }
  await mp.screenshot({ path: `${OUT}/23-widget-mobile-conversation.png` });

  await shot('24-install-guide', '/widget/install.html', { full: true });

  fs.writeFileSync(__dirname + '/shots/MANIFEST.txt', log.join('\n'));
  console.log(log.join('\n'));
  await browser.close();
})();
