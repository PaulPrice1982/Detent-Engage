import { readHostConsent, type ConsentSignal } from './consent-signal.js';
import { BRAND, detentMark } from './brand.js';

/**
 * The launcher: a Web Component with Shadow DOM (section 26, table 37).
 *
 * Shadow DOM for the launcher and inline surfaces because style and DOM
 * isolation is what stops a host page's CSS breaking us and our CSS breaking
 * the host page. A sandboxed iframe for the conversation panel because that is
 * a genuine security boundary, and the panel is where visitor text lives.
 *
 * Accessibility is not a later pass: WCAG 2.2 AA is the standard, a text-only
 * route is always available and never presented as degraded, all controls are
 * keyboard reachable, and state changes are announced.
 *
 * Three audit findings shaped this file:
 *
 *   UX-1  Escape was bound on the host document while the conversation lived in
 *         a cross-origin iframe, so a visitor who tabbed into the panel could
 *         never get out. The panel now owns its own close control and tells the
 *         launcher over `postMessage`; the launcher restores focus.
 *   UX-5  `width: min(400px, 100vw - 40px)` is a desktop card squeezed onto a
 *         phone, and most of the traffic this product monetises is mobile.
 *         Below 640px the panel is a full-screen sheet.
 *   UX-10 branding was one accent colour and a label. Position, avatar,
 *         assistant name, greeting and font are configurable, which is what a
 *         multi-brand group asks for on day one.
 */
export interface WidgetConfig {
  readonly apiBaseUrl: string;
  readonly publicKey: string;
  readonly panelUrl: string;
  readonly launcherLabel?: string;
  readonly jurisdiction?: string;
  readonly accentColour?: string;
  readonly position?: 'bottom-right' | 'bottom-left';
  readonly locale?: string;
  readonly avatarUrl?: string;
  /** A one-line prompt shown beside the launcher before anyone clicks it. */
  readonly greeting?: string;
}

const STYLES = `
  :host { all: initial; font: inherit; }
  .launcher {
    position: fixed; inset-block-end: calc(20px + env(safe-area-inset-bottom));
    z-index: 2147483000;
    display: inline-flex; align-items: center; gap: 8px;
    padding: 12px 18px; border: 0; border-radius: 999px;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 15px; line-height: 1.2; font-weight: 600;
    color: ${BRAND.paper}; background: var(--awa-accent, ${BRAND.ink}); cursor: pointer;
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.18);
  }
  .launcher.right { inset-inline-end: 20px; }
  .launcher.left { inset-inline-start: 20px; }
  .launcher:focus-visible { outline: 3px solid #2563eb; outline-offset: 3px; }
  .mark { display: inline-flex; align-items: center; color: ${BRAND.paper}; }
  .avatar { width: 20px; height: 20px; border-radius: 50%; object-fit: cover; }
  .launcher:hover { filter: brightness(1.08); }
  .badge {
    font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
    padding: 2px 6px; border-radius: 4px; background: rgb(255 255 255 / 0.18);
    /* Deliberately not the brand accent: an Article 50 disclosure is not decoration. */
  }
  .greeting {
    position: fixed; inset-block-end: calc(76px + env(safe-area-inset-bottom));
    z-index: 2147483000; max-width: min(280px, calc(100vw - 40px));
    padding: 10px 12px; border-radius: 12px; border: 1px solid #e5e7eb;
    background: #fff; color: ${BRAND.ink};
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 14px;
    box-shadow: 0 10px 30px rgb(0 0 0 / 0.16);
    display: flex; gap: 8px; align-items: flex-start;
  }
  .greeting.right { inset-inline-end: 20px; }
  .greeting.left { inset-inline-start: 20px; }
  .greeting button.dismiss {
    border: 0; background: none; padding: 0 2px; cursor: pointer; color: #6b7280; font-size: 15px; line-height: 1;
  }
  .panel {
    position: fixed; z-index: 2147483000;
    inset-block-end: calc(84px + env(safe-area-inset-bottom));
    width: min(400px, calc(100vw - 40px)); height: min(620px, calc(100vh - 120px));
    border: 1px solid #e5e7eb; border-radius: 14px; background: #fff;
    box-shadow: 0 18px 48px rgb(0 0 0 / 0.22); overflow: hidden;
  }
  .panel.right { inset-inline-end: 20px; }
  .panel.left { inset-inline-start: 20px; }
  .panel iframe { width: 100%; height: 100%; border: 0; display: block; }
  /* UX-5: a phone gets a sheet, not a shrunken card. Full height, no rounded
     corners fighting the status bar, and the launcher hidden behind it. */
  @media (max-width: 640px) {
    .panel, .panel.right, .panel.left {
      inset: 0; width: 100%; height: 100%;
      border: 0; border-radius: 0;
    }
    .greeting { display: none; }
  }
  .visually-hidden {
    position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
  @media (prefers-reduced-motion: no-preference) {
    .panel { animation: rise .16s ease-out; }
    @keyframes rise { from { transform: translateY(8px); opacity: 0 } to { transform: none; opacity: 1 } }
  }
  @media (prefers-color-scheme: dark) {
    .panel { background: #111827; border-color: #374151; }
    .greeting { background: #111827; border-color: #374151; color: #fff; }
  }
`;

export class DetentAssistantLauncher extends HTMLElement {
  private open = false;
  private consent: ConsentSignal = { identityResolution: false, source: 'none' };
  private readonly shadow: ShadowRoot;
  private button?: HTMLButtonElement;
  private messageListener?: (event: MessageEvent) => void;
  private keyListener?: (event: KeyboardEvent) => void;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.consent = readHostConsent(window, this);
    this.render();
  }

  disconnectedCallback(): void {
    // Listeners are removed on teardown. A widget removed by a single-page
    // application used to leave a document-level keydown handler behind.
    if (this.messageListener) window.removeEventListener('message', this.messageListener);
    if (this.keyListener) document.removeEventListener('keydown', this.keyListener);
  }

  private config(): WidgetConfig {
    const position = this.getAttribute('data-position');
    return {
      apiBaseUrl: this.getAttribute('data-api') ?? '',
      publicKey: this.getAttribute('data-key') ?? '',
      panelUrl: this.getAttribute('data-panel') ?? '',
      launcherLabel: this.getAttribute('data-label') ?? 'Ask a question',
      jurisdiction: this.getAttribute('data-jurisdiction') ?? undefined,
      accentColour: this.getAttribute('data-accent') ?? undefined,
      position: position === 'bottom-left' ? 'bottom-left' : 'bottom-right',
      // The host page's own language is the honest default for a visitor's
      // locale; a tenant can override it per page.
      locale: this.getAttribute('data-locale') ?? document.documentElement.lang ?? undefined,
      avatarUrl: this.getAttribute('data-avatar') ?? undefined,
      greeting: this.getAttribute('data-greeting') ?? undefined,
    };
  }

  private side(): 'left' | 'right' {
    return this.config().position === 'bottom-left' ? 'left' : 'right';
  }

  private render(): void {
    const config = this.config();
    const style = document.createElement('style');
    style.textContent = STYLES;

    const button = document.createElement('button');
    this.button = button;
    button.type = 'button';
    button.className = `launcher ${this.side()}`;
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'awa-panel');
    if (config.accentColour) button.style.setProperty('--awa-accent', config.accentColour);

    if (config.avatarUrl) {
      const avatar = document.createElement('img');
      avatar.className = 'avatar';
      avatar.src = config.avatarUrl;
      avatar.alt = '';
      button.append(avatar);
    } else {
      // The Detent mark, inline. No network fetch, no CSP allowlist entry.
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.innerHTML = detentMark(15);
      button.append(mark);
    }

    const label = document.createElement('span');
    label.textContent = config.launcherLabel ?? 'Ask a question';

    // The Article 50 disclosure begins on the launcher itself, before anyone
    // has typed anything. It is in the surface, not in a privacy policy.
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'AI';

    const hint = document.createElement('span');
    hint.className = 'visually-hidden';
    hint.textContent = 'Opens an AI assistant. You are not speaking with a person. A text-only route is available.';

    button.append(label, badge, hint);
    button.addEventListener('click', () => this.toggle());

    // Announces open and close to assistive technology.
    const live = document.createElement('div');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.className = 'visually-hidden';
    live.id = 'awa-live';

    this.shadow.replaceChildren(style, button, live);
    if (config.greeting) this.renderGreeting(config.greeting);

    // The panel is a cross-origin iframe, so it reports its own close (UX-1).
    // Only messages from the panel's own origin are honoured; a host page or a
    // third-party script cannot drive the widget by posting to the window.
    const panelOrigin = originOf(config.panelUrl);
    this.messageListener = (event: MessageEvent) => {
      if (panelOrigin && event.origin !== panelOrigin) return;
      const data = event.data as { source?: string; type?: string } | undefined;
      if (data?.source !== 'detent-assistant') return;
      if (data.type === 'close' && this.open) this.toggle();
    };
    window.addEventListener('message', this.messageListener);

    // Escape on the host document still closes the panel when focus has not
    // moved into the iframe. It is a convenience; the panel's own handler is
    // the control.
    this.keyListener = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && this.open) this.toggle();
    };
    document.addEventListener('keydown', this.keyListener);
  }

  /**
   * The proactive prompt (audit UX-9).
   *
   * A visible, dismissible bubble rather than an auto-opening panel: opening
   * itself over someone's reading is the behaviour that makes this category of
   * widget hated, and a dismissal is respected for the session.
   */
  private renderGreeting(text: string): void {
    let dismissed = false;
    try { dismissed = sessionStorage.getItem('awa:greeting-dismissed') === '1'; } catch { /* storage blocked */ }
    if (dismissed) return;

    const bubble = document.createElement('div');
    bubble.className = `greeting ${this.side()}`;
    bubble.setAttribute('role', 'status');

    const message = document.createElement('span');
    message.textContent = text;

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.textContent = '✕';
    dismiss.addEventListener('click', () => {
      bubble.remove();
      try { sessionStorage.setItem('awa:greeting-dismissed', '1'); } catch { /* storage blocked */ }
    });

    bubble.append(message, dismiss);
    this.shadow.append(bubble);
  }

  private toggle(): void {
    const button = this.button;
    if (!button) return;
    this.open = !this.open;
    button.setAttribute('aria-expanded', String(this.open));
    const live = this.shadow.getElementById('awa-live');
    if (live) live.textContent = this.open ? 'Assistant opened.' : 'Assistant closed.';

    const existing = this.shadow.getElementById('awa-panel');
    if (!this.open) {
      existing?.remove();
      // Focus returns to the control that opened the panel (WCAG 2.4.3).
      button.focus();
      return;
    }
    if (existing) return;

    const config = this.config();
    const panel = document.createElement('div');
    panel.className = `panel ${this.side()}`;
    panel.id = 'awa-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'AI assistant');
    panel.setAttribute('aria-modal', 'false');

    const frame = document.createElement('iframe');
    frame.title = 'AI assistant conversation';
    // A genuine security boundary. allow-same-origin is deliberately absent
    // relative to the host: the panel is served from the platform origin, so it
    // gets its own partitioned storage and no access to the host page's DOM.
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('loading', 'lazy');

    const url = new URL(config.panelUrl);
    url.searchParams.set('key', config.publicKey);
    url.searchParams.set('api', config.apiBaseUrl);
    // The host's consent decision travels to the panel. The panel never decides
    // it for itself.
    url.searchParams.set('consent_personalisation', String(this.consent.identityResolution));
    url.searchParams.set('consent_source', this.consent.source);
    if (config.jurisdiction) url.searchParams.set('jurisdiction', config.jurisdiction);
    if (config.locale) url.searchParams.set('locale', config.locale);
    frame.src = url.toString();

    panel.append(frame);
    this.shadow.append(panel);
    frame.focus();
  }
}

function originOf(url: string): string | undefined {
  try { return new URL(url, location.href).origin; } catch { return undefined; }
}

export function registerLauncher(): void {
  if (!customElements.get('detent-assistant')) {
    customElements.define('detent-assistant', DetentAssistantLauncher);
  }
}
