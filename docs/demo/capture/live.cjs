/**
 * Films the product being used, rather than photographing it.
 *
 * Playwright drives a real browser, so the navigation, the typing and the
 * responses are the product's own. What a recording of that lacks is the
 * person: the OS cursor is not in the frame, input appears instantaneously,
 * and scrolling jumps. Each of those is supplied below, so the footage reads
 * as somebody working rather than as a page being repainted.
 */
const { chromium } = require('./node_modules/playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:8901';
const OUT = path.join(__dirname, 'clips');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
/**
 * The recording size is the film's window size, exactly.
 *
 * Filmed at 1280x800 the product sat as a small island inside a 1920 frame,
 * with a quarter of the width dead dark bar either side, and tall pages were
 * cut at the viewport edge. Recording at the size the frame actually gives
 * the picture means no scaling, no bars, and the most page that will fit.
 */
const SIZE = { width: 1920, height: 904 };

const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name}. See docs/demo/capture/README.md.`);
  return v;
};

/** A cursor the camera can see, plus a ring on every click. */
const CURSOR = `
(() => {
  if (window.__cursor) return;
  const add = () => {
    const c = document.createElement('div');
    c.id = '__cursor';
    c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;' +
      'pointer-events:none;transform:translate(-3px,-3px);transition:none;' +
      'filter:drop-shadow(0 2px 4px rgba(0,0,0,.45))';
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22">' +
      '<path d="M3 2 L3 17 L7.2 13.2 L9.9 19.4 L12.7 18.2 L10 12.2 L15.6 12.2 Z" ' +
      'fill="#fff" stroke="#0F1B2A" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    window.__cursor = c;
  };
  if (document.documentElement) add(); else addEventListener('DOMContentLoaded', add);
  window.__moveCursor = (x, y) => { if (window.__cursor) window.__cursor.style.transform =
    'translate(' + (x - 3) + 'px,' + (y - 3) + 'px)'; };
  window.__clickRing = (x, y) => {
    const r = document.createElement('div');
    r.style.cssText = 'position:fixed;left:' + (x - 5) + 'px;top:' + (y - 5) + 'px;width:10px;height:10px;' +
      'border:2px solid #EFA13C;border-radius:50%;z-index:2147483646;pointer-events:none;' +
      'opacity:.95;transition:all .45s ease-out';
    document.documentElement.appendChild(r);
    requestAnimationFrame(() => {
      r.style.width = '42px'; r.style.height = '42px';
      r.style.left = (x - 21) + 'px'; r.style.top = (y - 21) + 'px'; r.style.opacity = '0';
    });
    setTimeout(() => r.remove(), 520);
  };
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeHand(page) {
  let at = { x: 250, y: 160 };
  /** Eased travel, so the pointer accelerates and settles like a hand does. */
  const glide = async (x, y, steps = 26) => {
    const from = { ...at };
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const nx = from.x + (x - from.x) * e;
      const ny = from.y + (y - from.y) * e;
      await page.mouse.move(nx, ny);
      await page.evaluate(([a, b]) => window.__moveCursor && window.__moveCursor(a, b), [nx, ny]);
      await sleep(11);
    }
    at = { x, y };
  };
  const centre = async (locator) => {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const box = await locator.boundingBox();
    if (!box) return null;
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + Math.min(box.height / 2, 22)) };
  };
  return {
    glide,
    async point(locator) {
      const p = await centre(locator);
      if (p) await glide(p.x, p.y);
      return p;
    },
    async click(locator, settle = 420) {
      const p = await this.point(locator);
      if (!p) return;
      await page.evaluate(([a, b]) => window.__clickRing && window.__clickRing(a, b), [p.x, p.y]);
      await sleep(130);
      await locator.click({ force: true }).catch(() => {});
      await sleep(settle);
    },
    async type(locator, text, delay = 58) {
      await this.click(locator, 160);
      await locator.pressSequentially(text, { delay });
      await sleep(260);
    },
    async pick(locator, value) {
      await this.point(locator);
      await sleep(180);
      await locator.selectOption(value).catch(() => {});
      await sleep(360);
    },
    async scroll(to, ms = 1400) {
      await page.evaluate(([y, d]) => new Promise((done) => {
        const start = window.scrollY;
        const delta = (y === 'end' ? document.body.scrollHeight : y) - start;
        const t0 = performance.now();
        const step = (t) => {
          const k = Math.min(1, (t - t0) / d);
          const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
          window.scrollTo(0, start + delta * e);
          k < 1 ? requestAnimationFrame(step) : done();
        };
        requestAnimationFrame(step);
      }), [to, ms]);
    },
  };
}

async function record(browser, name, storageState, body, size = SIZE) {
  const dir = path.join(OUT, '.raw', name);
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: size, recordVideo: { dir, size },
    ...(storageState ? { storageState } : {}),
  });
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  const hand = makeHand(page);
  try {
    await body(page, hand, ctx);
  } catch (e) {
    console.log('  ! ' + name + ': ' + e.message);
  }
  await sleep(700);
  await page.close();
  await ctx.close();
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.webm'));
  if (!file) { console.log('  ! no video for ' + name); return; }
  const target = path.join(OUT, name + '.webm');
  fs.renameSync(path.join(dir, file), target);
  console.log('  ' + name + '.webm  ' + Math.round(fs.statSync(target).size / 1024) + ' KB');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const WK = fs.readFileSync(path.join(__dirname, 'wk.txt'), 'utf8').trim();

  // --- one sign-in each, kept so the filmed scenes start already inside ----
  const sign = async (prefix, email, password, file) => {
    const ctx = await browser.newContext({ viewport: SIZE });
    const page = await ctx.newPage();
    await page.goto(`${BASE}${prefix}/signin`, { waitUntil: 'networkidle' });
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
                       page.click('button[type="submit"]')]);
    await ctx.storageState({ path: path.join(OUT, '.raw', file) });
    await ctx.close();
    return path.join(OUT, '.raw', file);
  };
  fs.mkdirSync(path.join(OUT, '.raw'), { recursive: true });
  const opsState = await sign('/console', 'ops@detentgtm.io', need('OPERATOR_PASSWORD'), 'ops.json');
  const supState = await sign('/console', 's.ibrahim@detentgtm.io', need('SUPPORT_PASSWORD'), 'sup.json');
  const appState = await sign('/app', 'd.harper@northwind.example', need('APP_PASSWORD'), 'app.json');

  // --- 01 the public site -------------------------------------------------
  await record(browser, '01-marketing', null, async (page, hand) => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await sleep(1400);
    await hand.glide(640, 300, 20);
    await hand.scroll(700, 2000);
    await sleep(900);
    await hand.scroll(1500, 2000);
    await sleep(1200);
  });

  // --- 02 signing in, then setting a customer up --------------------------
  await record(browser, '02-signin-and-setup', null, async (page, hand) => {
    await page.goto(`${BASE}/console/signin`, { waitUntil: 'networkidle' });
    await sleep(900);
    await hand.type(page.locator('input[name="email"]'), 'ops@detentgtm.io', 52);
    await hand.type(page.locator('input[name="password"]'), need('OPERATOR_PASSWORD'), 42);
    await sleep(300);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
      hand.click(page.locator('button[type="submit"]'), 900),
    ]);
    await sleep(1100);
    await hand.click(page.locator('nav a[href="/console/new"], a[href="/console/new"]').first(), 1200)
      .catch(async () => { await page.goto(`${BASE}/console/new`, { waitUntil: 'networkidle' }); });
    if (!page.url().includes('/console/new')) {
      await page.goto(`${BASE}/console/new`, { waitUntil: 'networkidle' });
    }
    await sleep(900);
    await hand.type(page.locator('#name'), 'Caldera Marine Services', 46);
    await hand.type(page.locator('#tenantId'), 't_caldera', 60);
    await hand.type(page.locator('#billingEmail'), 'ap@calderamarine.example', 40);
    await hand.pick(page.locator('#planCode'), 'command');
    await hand.pick(page.locator('#term'), 'twenty_four_months');
    await hand.type(page.locator('#accountManager'), 'Grace Aldridge', 50);
    await hand.scroll(420, 900);
    await sleep(500);
    await page.fill('#startDate', '2026-10-01');
    await hand.point(page.locator('#noticePeriodDays'));
    await page.fill('#noticePeriodDays', '');
    await page.locator('#noticePeriodDays').pressSequentially('120', { delay: 130 });
    await sleep(500);
    await page.fill('#renewalUplift', '');
    await hand.type(page.locator('#renewalUplift'), '3.9', 150);
    await hand.type(page.locator('#monthlyCredits'), '2750', 110);
    await hand.scroll(760, 900);
    await hand.type(page.locator('#seats'), '65', 140);
    await hand.type(page.locator('#conversations'), '15000', 110);
    await hand.type(page.locator('#voiceMinutes'), '2400', 110);
    await hand.type(page.locator('#spendCap'), '4200', 110);
    await sleep(600);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
      hand.click(page.locator('button[type="submit"]'), 1500),
    ]);
    await sleep(1800);
  });

  // --- 03 the contract the form produced ----------------------------------
  await record(browser, '03-contract', opsState, async (page, hand) => {
    await page.goto(`${BASE}/console`, { waitUntil: 'networkidle' });
    await sleep(900);
    const link = page.locator('a[href^="/console/accounts/"]').filter({ hasText: /Northwind/i }).first();
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
      hand.click(link, 1200),
    ]);
    await sleep(1200);
    await hand.scroll(560, 1800);
    await sleep(1800);
    await hand.scroll(1100, 1600);
    await sleep(1600);
  });

  // --- 04 packaging --------------------------------------------------------
  await record(browser, '04-pricing', opsState, async (page, hand) => {
    await page.goto(`${BASE}/console/pricing`, { waitUntil: 'networkidle' });
    await sleep(1600);
    await hand.glide(500, 220, 18);
    await hand.scroll(650, 2200);
    await sleep(1400);
    await hand.scroll(1400, 2000);
    await sleep(1200);
  });

  // --- 05 installation -----------------------------------------------------
  await record(browser, '05-install', null, async (page, hand) => {
    await page.goto(`${BASE}/widget/install.html`, { waitUntil: 'networkidle' });
    await sleep(1300);
    await hand.scroll(520, 1800);
    await sleep(1600);
    await hand.scroll(1200, 1800);
    await sleep(1200);
  });

  // --- 06 the conversation, typed ------------------------------------------
  await record(browser, '06-conversation', null, async (page, hand) => {
    const panel = `/widget/panel.html?key=${encodeURIComponent(WK)}&api=${encodeURIComponent(BASE)}&jurisdiction=UK`;
    await page.goto(`${BASE}${panel}`, { waitUntil: 'networkidle' });
    await sleep(1800);
    const box = page.locator('textarea, input[type="text"]:not([type=hidden])').first();
    const lines = [
      'We run 40 vans out of two depots in the Midlands. Our telematics contract ends in March and I am looking at replacing it.',
      '40 vehicles, and we would want driver behaviour scoring as well as tracking.',
      'There is a 90 day notice period before March, so it is tighter than it looks.',
      'It is my call, I run the fleet.',
      'd.harper@northwind.example',
    ];
    for (const line of lines) {
      await hand.type(box, line, 26);
      await page.keyboard.press('Enter');
      await sleep(2400);
    }
    await sleep(1400);
  });

  // --- 07 the same thing on a phone ----------------------------------------
  await record(browser, '07-mobile', null, async (page, hand) => {
    const panel = `/widget/panel.html?key=${encodeURIComponent(WK)}&api=${encodeURIComponent(BASE)}&jurisdiction=UK`;
    await page.goto(`${BASE}${panel}`, { waitUntil: 'networkidle' });
    await sleep(1600);
    const box = page.locator('textarea, input[type="text"]:not([type=hidden])').first();
    await hand.type(box, 'We run 40 vans out of two depots in the Midlands.', 30);
    await page.keyboard.press('Enter');
    await sleep(3000);
  }, { width: 430, height: 904 });

  // --- 09 a second person approving ----------------------------------------
  await record(browser, '09-dual-control', opsState, async (page, hand) => {
    await page.goto(`${BASE}/console/approvals`, { waitUntil: 'networkidle' });
    await sleep(2200);
    const approve = page.locator('form[action*="/approve"] button').first();
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
      hand.click(approve, 1400),
    ]);
    await sleep(2000);
    const link = page.locator('a[href^="/console/accounts/"]').first();
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
      hand.click(link, 1200),
    ]);
    await sleep(2400);
  });

  // --- 10 the same account, without the authority --------------------------
  await record(browser, '10-roles', supState, async (page, hand) => {
    await page.goto(`${BASE}/console`, { waitUntil: 'networkidle' });
    await sleep(900);
    const link = page.locator('a[href^="/console/accounts/"]').first();
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
      hand.click(link, 1400),
    ]);
    await sleep(1400);
    for (const label of ['Grant credit', 'Refund', 'Change spend cap']) {
      await hand.point(page.locator(`text=${label}`).first()).catch(() => {});
      await sleep(900);
    }
    await hand.scroll('end', 2000);
    await sleep(1800);
  });

  // --- 11 the customer's own view ------------------------------------------
  await record(browser, '11-customer', appState, async (page, hand) => {
    await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
    await sleep(2000);
    await hand.point(page.locator('a[href="/app/billing"]').first()).catch(() => {});
    await sleep(600);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
      hand.click(page.locator('a[href="/app/billing"]').first(), 1200),
    ]);
    await sleep(2200);
  });

  // --- 14 the public assurance pages ---------------------------------------
  await record(browser, '14-assurance', null, async (page, hand) => {
    await page.goto(`${BASE}/trust.html`, { waitUntil: 'networkidle' });
    await sleep(1400);
    await hand.scroll(800, 2200);
    await sleep(1400);
    await page.goto(`${BASE}/assurance.html`, { waitUntil: 'networkidle' });
    await sleep(1400);
    await hand.scroll(700, 2000);
    await sleep(1400);
  });

  await browser.close();
  console.log('\ndone');
})();
