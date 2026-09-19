import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { securityHeaders } from '@detent/awa-server';
import { SUPPORTED_LOCALES, localeBundle, negotiateLocale } from '@detent/awa-server';
import { buildHarness, bearer } from './fixtures/tenant.js';

/**
 * CI gate: the visitor-facing findings of the September 2026 audit.
 *
 * Pass threshold: the panel is escapable, translatable and resumable, and the
 * headers that make it safe to embed are present. Several of these assert on
 * the shipped markup rather than in a browser, there is no DOM in this suite,
 * which is a weaker check than a real accessibility audit and is stated as
 * such in the assurance pack rather than dressed up as one.
 */
const here = dirname(fileURLToPath(import.meta.url));
const widgetPublic = resolve(here, '../packages/widget/public');
const serverPublic = resolve(here, '../packages/server/public');

const read = (path: string) => readFile(path, 'utf8');

describe('UX-1 · the panel can be left from the keyboard', () => {
  it('ships a close control and handles Escape inside the iframe', async () => {
    const html = await read(`${widgetPublic}/panel.html`);
    const script = await read(`${widgetPublic}/panel.js`);

    expect(html).toContain('id="close"');
    expect(html).toContain('aria-label="Close"');
    // Escape bound on the *host* document never fired: the panel is a
    // cross-origin iframe, which is exactly how the trap happened.
    expect(script).toContain("document.addEventListener('keydown'");
    expect(script).toContain("event.key === 'Escape'");
    expect(script).toContain("postMessage({ source: 'detent-assistant', type: 'close' }");
  });

  it('moves focus to the heading on open', async () => {
    const html = await read(`${widgetPublic}/panel.html`);
    const script = await read(`${widgetPublic}/panel.js`);
    expect(html).toContain('id="title" tabindex="-1"');
    expect(script).toContain('title.focus(');
  });

  it('returns focus to the launcher on close', async () => {
    const launcher = await read(resolve(here, '../packages/widget/src/launcher.ts'));
    expect(launcher).toContain('button.focus();');
    // And only honours a close message from the panel's own origin.
    expect(launcher).toContain('event.origin !== panelOrigin');
  });
});

describe('UX-5 · the panel is usable on a phone', () => {
  it('is a full-screen sheet below 640px with safe-area padding', async () => {
    const css = await read(`${widgetPublic}/panel.css`);
    const launcher = await read(resolve(here, '../packages/widget/src/launcher.ts'));
    expect(css).toContain('env(safe-area-inset-bottom)');
    expect(launcher).toContain('@media (max-width: 640px)');
  });

  it('follows the visual viewport so the keyboard does not cover the composer', async () => {
    const script = await read(`${widgetPublic}/panel.js`);
    expect(script).toContain('visualViewport');
    expect(script).toContain('--panel-height');
  });
});

describe('UX-6 · the surface is translatable', () => {
  it('ships a bundle for every locale it claims to support', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const bundle = localeBundle(locale);
      expect(bundle.strings.consentWording.length).toBeGreaterThan(20);
      expect(bundle.strings.disclosure.length).toBeGreaterThan(20);
    }
  });

  it('every bundle carries every key, so nothing falls back to English silently', () => {
    const reference = Object.keys(localeBundle('en-GB').strings).sort();
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(localeBundle(locale).strings).sort(), locale).toEqual(reference);
    }
  });

  it('negotiates a language-only match and falls back to the tenant default', () => {
    expect(negotiateLocale('fr-CA')).toBe('fr');
    expect(negotiateLocale('de-AT')).toBe('de');
    expect(negotiateLocale('ja')).toBe('en-GB');
    // A tenant that has only approved English copy gets English, whatever the
    // visitor's browser says: serving unapproved consent wording would make the
    // consent record disagree with what was shown.
    expect(negotiateLocale('fr', ['en-GB'])).toBe('en-GB');
  });

  it('serves a bundle over the API without a key', async () => {
    const harness = await buildHarness();
    const response = await harness.api.handle({ method: 'GET', path: '/v1/locales/de', headers: {} });
    expect(response.status).toBe(200);
    expect((response.body as { locale: string }).locale).toBe('de');
  });

  it('holds no inline English in the panel markup beyond the pre-load defaults', async () => {
    const html = await read(`${widgetPublic}/panel.html`);
    // The consent wording used to be a hardcoded constant in the panel; it is
    // now supplied per locale and recorded verbatim as the consent evidence.
    expect(html).not.toContain('CONSENT_WORDING');
    expect(html).not.toContain('May we check whether we already know you');
  });
});

describe('UX-4 · a conversation survives a page navigation', () => {
  it('replays a session transcript from the server', async () => {
    const harness = await buildHarness();
    const opened = await harness.api.handle({
      method: 'POST', path: '/v1/sessions', headers: bearer(harness.widgetKey), body: {},
    });
    const sessionId = (opened.body as { session_id: string }).session_id;

    await harness.api.handle({
      method: 'POST', path: `/v1/sessions/${sessionId}/messages`,
      headers: bearer(harness.widgetKey), body: { text: 'what do you charge?' },
    });

    const replayed = await harness.api.handle({
      method: 'GET', path: `/v1/sessions/${sessionId}`, headers: bearer(harness.widgetKey),
    });
    const body = replayed.body as { turns: { role: string; text: string }[] };
    expect(replayed.status).toBe(200);
    expect(body.turns.length).toBeGreaterThanOrEqual(2);
    expect(body.turns[0]!.role).toBe('visitor');
  });

  it('refuses to replay another tenant session', async () => {
    const alpha = await buildHarness({ tenantId: 't_alpha' });
    const beta = await buildHarness({ tenantId: 't_beta' });
    const opened = await alpha.api.handle({
      method: 'POST', path: '/v1/sessions', headers: bearer(alpha.widgetKey), body: {},
    });
    const sessionId = (opened.body as { session_id: string }).session_id;

    const response = await beta.api.handle({
      method: 'GET', path: `/v1/sessions/${sessionId}`, headers: bearer(beta.widgetKey),
    });
    // Beta's platform has never heard of it; alpha's would refuse on tenant.
    expect(response.status).toBe(404);
  });

  it('persists the session id in the panel so a navigation does not open a new one', async () => {
    const script = await read(`${widgetPublic}/panel.js`);
    expect(script).toContain('sessionStorage');
    // Every storage access is guarded: it throws in a private window.
    expect(script).toContain('catch { /* storage unavailable */ }');
  });
});

describe('UX-7 · an escalation offers the visitor a route on', () => {
  it('returns a structured next action rather than a sentence', async () => {
    const harness = await buildHarness({
      script: [{ match: /.*/, output: { text: 'I am not sure about that.', confidence: 0.1 } }],
    });
    await harness.platform.tenants.update(harness.config.tenantId, {
      escalation: {
        ...harness.config.escalation,
        humanResponsePromise: 'Sam usually replies within the hour.',
      },
    }, 'tenant_admin');

    const opened = await harness.api.handle({
      method: 'POST', path: '/v1/sessions', headers: bearer(harness.widgetKey), body: {},
    });
    const sessionId = (opened.body as { session_id: string }).session_id;
    const response = await harness.api.handle({
      method: 'POST', path: `/v1/sessions/${sessionId}/messages`,
      headers: bearer(harness.widgetKey),
      body: { text: 'can I speak to a person?' },
    });

    const body = response.body as { escalated: boolean; next_action: { kind: string; promise?: string; notified?: boolean } };
    expect(body.escalated).toBe(true);
    expect(body.next_action.kind).toBe('await_human');
    expect(body.next_action.promise).toContain('within the hour');
    // Says explicitly whether a human was actually notified, rather than
    // implying it.
    expect(typeof body.next_action.notified).toBe('boolean');
  });

  it('prefers a booking link where the tenant has one', async () => {
    const harness = await buildHarness({
      script: [{ match: /.*/, output: { text: 'I am not sure.', confidence: 0.1 } }],
    });
    await harness.platform.tenants.update(harness.config.tenantId, {
      bookingLinkUrl: 'https://acme.co.uk/book',
    }, 'tenant_admin');

    const opened = await harness.api.handle({
      method: 'POST', path: '/v1/sessions', headers: bearer(harness.widgetKey), body: {},
    });
    const sessionId = (opened.body as { session_id: string }).session_id;
    const response = await harness.api.handle({
      method: 'POST', path: `/v1/sessions/${sessionId}/messages`,
      headers: bearer(harness.widgetKey), body: { text: 'put me through to someone' },
    });
    const body = response.body as { next_action: { kind: string; url?: string } };
    expect(body.next_action.kind).toBe('booking_link');
    expect(body.next_action.url).toBe('https://acme.co.uk/book');
  });
});

describe('UX-8 · consent is a screen a DPO can read', () => {
  it('offers an explanation, a privacy link and a way to withdraw', async () => {
    const html = await read(`${widgetPublic}/panel.html`);
    expect(html).toContain('id="consent-explain"');
    expect(html).toContain('id="privacy-link"');
    expect(html).toContain('id="forget"');
  });

  it('records a refusal and clears the transcript when a visitor asks to be forgotten', async () => {
    const harness = await buildHarness();
    const opened = await harness.api.handle({
      method: 'POST', path: '/v1/sessions', headers: bearer(harness.widgetKey), body: {},
    });
    const sessionId = (opened.body as { session_id: string }).session_id;

    const response = await harness.api.handle({
      method: 'POST', path: `/v1/sessions/${sessionId}/forget`,
      headers: bearer(harness.widgetKey), body: {},
    });
    expect(response.status).toBe(200);
    expect(harness.platform.sessions.get(sessionId)).toBeUndefined();

    // The erasure is itself audited, the evidence that an erasure happened
    // cannot itself be erased, and the audit holds no personal data.
    const audit = await harness.platform.audit.export(harness.config.tenantId);
    expect(audit.entries.some((entry) => entry.type === 'erasure_executed')).toBe(true);
  });
});

describe('SEC-7 · the headers that make the panel safe to embed', () => {
  it('constrains frame-ancestors on the panel to the tenant origins', () => {
    const headers = securityHeaders({ kind: 'panel', frameAncestors: ['https://www.acme.co.uk'] });
    expect(headers['content-security-policy']).toContain('frame-ancestors https://www.acme.co.uk');
    expect(headers['permissions-policy']).toContain('microphone=()');
  });

  it('refuses framing entirely when no origin is registered', () => {
    const headers = securityHeaders({ kind: 'panel' });
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('locks the API surface down to nothing', () => {
    const headers = securityHeaders({ kind: 'api' });
    expect(headers['content-security-policy']).toContain("default-src 'none'");
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  });

  it('emits HSTS only when the deployment asks for it', () => {
    expect(securityHeaders({ kind: 'api' })['strict-transport-security']).toBeUndefined();
    expect(securityHeaders({ kind: 'api', hsts: true })['strict-transport-security']).toContain('preload');
  });

  it('ships no inline script or style on any served page', async () => {
    for (const file of [
      `${widgetPublic}/panel.html`,
      `${widgetPublic}/install.html`,
      `${serverPublic}/console.html`,
      `${serverPublic}/index.html`,
      `${serverPublic}/assurance.html`,
      `${serverPublic}/trust.html`,
    ]) {
      const html = await read(file);
      // `script-src 'self'` and `style-src 'self'` mean an inline block does
      // not run. A page that needs `'unsafe-inline'` has no CSP worth the name.
      expect(html, file).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/);
      expect(html, file).not.toMatch(/<style[^>]*>[\s\S]*?\S[\s\S]*?<\/style>/);
      expect(html, file).not.toMatch(/\sstyle="/);
    }
  });
});

describe('UX-3 · the approval console exists and covers the five screens', () => {
  it('ships all five steps', async () => {
    const html = await read(`${serverPublic}/console.html`);
    for (const screen of ['Connect', 'Generate &amp; approve', 'Dry run', 'Go live', 'Evidence']) {
      expect(html, screen).toContain(screen);
    }
  });

  it('never stores the admin key anywhere but the tab', async () => {
    const script = await read(`${serverPublic}/console.js`);
    expect(script).toContain('sessionStorage');
    expect(script).not.toContain('localStorage');
  });
});
