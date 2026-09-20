const { chromium } = require('./node_modules/playwright');
const need = function (name) {
  var value = process.env[name];
  // Refuse rather than sign in as nobody: a capture that runs with an
  // empty password photographs a sign-in page and calls it a console.
  if (!value) throw new Error('Set ' + name + '. See docs/demo/capture/README.md.');
  return value;
};
const OUT = __dirname + '/shots';
const BASE = 'http://127.0.0.1:8901';
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/console/signin`, { waitUntil: 'networkidle' });
  await p.fill('input[name="email"]', 'ops@detentgtm.io');
  await p.fill('input[name="password"]', need('OPERATOR_PASSWORD'));
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}), p.click('button[type="submit"]')]);
  await p.goto(`${BASE}/console`, { waitUntil: 'networkidle' });
  const href = await p.$$eval('a[href^="/console/accounts/"]', (as) => {
    const m = as.find((a) => /Northwind/i.test(a.textContent)); return m ? m.getAttribute('href') : as[0].getAttribute('href');
  });
  await p.goto(`${BASE}${href}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${OUT}/29-account-after-approval.png`, fullPage: true });
  console.log('29 captured from', href);
  await browser.close();
})();
