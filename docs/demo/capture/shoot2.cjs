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
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const signIn = async (page, prefix, email, password) => {
  await page.goto(`${BASE}${prefix}/signin`, { waitUntil: 'networkidle' });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
                     page.click('button[type="submit"]')]);
  await page.waitForTimeout(700);
};

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const mk = async () => (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();

  // --- support: can look, cannot move money ------------------------------
  const sup = await mk();
  await signIn(sup, '/console', 's.ibrahim@detentgtm.io', need('SUPPORT_PASSWORD'));
  await sup.goto(`${BASE}/console`, { waitUntil: 'networkidle' });
  const href = await sup.$eval('a[href^="/console/accounts/"]', (a) => a.getAttribute('href')).catch(() => null);
  if (href) {
    await sup.goto(`${BASE}${href}`, { waitUntil: 'networkidle' });
    await sup.waitForTimeout(400);
    await sup.screenshot({ path: `${OUT}/25-support-cannot-move-money.png`, fullPage: true });
  }
  // The same refusal from the endpoint, not just the button.
  await sup.goto(`${BASE}/console/pricing`, { waitUntil: 'networkidle' });
  await sup.waitForTimeout(400);
  await sup.screenshot({ path: `${OUT}/26-support-forbidden.png`, fullPage: true });

  // --- viewer ------------------------------------------------------------
  const vw = await mk();
  await signIn(vw, '/console', 'r.okonjo@detentgtm.io', need('VIEWER_PASSWORD'));
  await vw.goto(`${BASE}/console`, { waitUntil: 'networkidle' });
  await vw.waitForTimeout(400);
  await vw.screenshot({ path: `${OUT}/27-viewer-console.png`, fullPage: true });

  // --- the second approver, approving ------------------------------------
  const ops = await mk();
  await signIn(ops, '/console', 'ops@detentgtm.io', need('OPERATOR_PASSWORD'));
  await ops.goto(`${BASE}/console/approvals`, { waitUntil: 'networkidle' });
  await ops.waitForTimeout(400);
  const before = await ops.$$eval('tbody tr', (rs) => rs.length);
  const approve = await ops.$('form[action*="/approve"] button, form[action*="/approve"] input[type=submit]');
  if (approve) {
    await Promise.all([ops.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}), approve.click()]);
    await ops.waitForTimeout(800);
  }
  await ops.goto(`${BASE}/console/approvals`, { waitUntil: 'networkidle' });
  await ops.waitForTimeout(400);
  const after = await ops.$$eval('tbody tr', (rs) => rs.length);
  await ops.screenshot({ path: `${OUT}/28-approvals-after-approval.png`, fullPage: true });
  console.log('approvals rows before/after:', before, after);

  fs.appendFileSync(`${OUT}/MANIFEST.txt`, `\n25..28 captured; approvals ${before} -> ${after}\n`);
  await browser.close();
})();
