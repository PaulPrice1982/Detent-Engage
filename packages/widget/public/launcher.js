import { readHostConsent } from './consent-signal.js';
import { BRAND, detentMark } from './brand.js';
import { LAUNCHER_BOX, monogramOf, planLogo, } from './tenant-brand.js';
const STYLES = `
  :host { all: initial; font: inherit; }
  .launcher {
    position: fixed; inset-block-end: 20px; inset-inline-end: 20px; z-index: 2147483000;
    display: inline-flex; align-items: center; gap: 8px;
    padding: 12px 18px; border: 0; border-radius: 999px;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 15px; line-height: 1.2; font-weight: 600;
    color: ${BRAND.paper}; background: var(--awa-accent, ${BRAND.ink}); cursor: pointer;
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.18);
  }
  .launcher:focus-visible { outline: 3px solid #2563eb; outline-offset: 3px; }
  .mark { display: inline-flex; align-items: center; color: ${BRAND.paper}; }
  /* A customer logo is always an <img>. An SVG inside an <img> cannot execute
     script, which an inlined one could. */
  .mark img { display: block; object-fit: contain; }
  /* The chip carries a light ground under a logo that would otherwise vanish
     into the launcher, and gives an opaque logo a margin of its own. */
  .mark.chip {
    background: ${BRAND.paper}; border-radius: 5px; padding: 3px 5px;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.12);
  }
  .monogram {
    display: inline-flex; align-items: center; justify-content: center;
    width: 20px; height: 20px; border-radius: 5px; font-size: 10px;
    font-weight: 700; letter-spacing: .02em;
    background: rgb(255 255 255 / 0.2); color: ${BRAND.paper};
  }
  .launcher:hover { filter: brightness(1.08); }
  .badge {
    font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
    padding: 2px 6px; border-radius: 4px; background: rgb(255 255 255 / 0.18);
    /* Deliberately not the brand accent: an Article 50 disclosure is not decoration. */
  }
  .panel {
    position: fixed; inset-block-end: 84px; inset-inline-end: 20px; z-index: 2147483000;
    width: min(400px, calc(100vw - 40px)); height: min(620px, calc(100vh - 120px));
    border: 1px solid #e5e7eb; border-radius: 14px; background: #fff;
    box-shadow: 0 18px 48px rgb(0 0 0 / 0.22); overflow: hidden;
  }
  .panel iframe { width: 100%; height: 100%; border: 0; display: block; }
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
  }
`;
export class DetentAssistantLauncher extends HTMLElement {
    open = false;
    consent = { identityResolution: false, source: 'none' };
    shadow;
    constructor() {
        super();
        this.shadow = this.attachShadow({ mode: 'open' });
    }
    connectedCallback() {
        this.consent = readHostConsent(window, this);
        this.render();
    }
    config() {
        return {
            apiBaseUrl: this.getAttribute('data-api') ?? '',
            publicKey: this.getAttribute('data-key') ?? '',
            panelUrl: this.getAttribute('data-panel') ?? '',
            launcherLabel: this.getAttribute('data-label') ?? 'Ask a question',
            jurisdiction: this.getAttribute('data-jurisdiction') ?? undefined,
            accentColour: this.getAttribute('data-accent') ?? undefined,
            organisationName: this.getAttribute('data-org') ?? undefined,
            logo: this.logoFromAttributes(),
        };
    }
    /**
     * Reads the logo from data attributes on the host element.
     *
     * Everything needed to draw it comes from the snippet, so the launcher paints
     * correctly on first render without waiting for an API call. A logo that
     * arrives a second late is a visible flash of our branding on the customer's
     * site.
     */
    logoFromAttributes() {
        const source = this.getAttribute('data-logo');
        if (!source)
            return undefined;
        const width = Number(this.getAttribute('data-logo-width') ?? '0');
        const height = Number(this.getAttribute('data-logo-height') ?? '0');
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            // Without intrinsic dimensions the shape cannot be classified, and a
            // guess is how a wordmark ends up squashed into a square.
            return undefined;
        }
        const format = (this.getAttribute('data-logo-format') ?? 'svg');
        return {
            source,
            format,
            widthPx: width,
            heightPx: height,
            altText: this.getAttribute('data-org') ?? 'Logo',
            onDark: this.getAttribute('data-logo-dark') ?? undefined,
            needsPadding: this.getAttribute('data-logo-padded') === 'true',
        };
    }
    monogram(config) {
        const element = document.createElement('span');
        element.className = 'monogram';
        element.textContent = monogramOf(config.organisationName ?? 'Assistant');
        element.setAttribute('role', 'img');
        element.setAttribute('aria-label', config.organisationName ?? 'Assistant');
        return element;
    }
    render() {
        const config = this.config();
        const style = document.createElement('style');
        style.textContent = STYLES;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'launcher';
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-controls', 'awa-panel');
        if (config.accentColour)
            button.style.setProperty('--awa-accent', config.accentColour);
        const mark = document.createElement('span');
        mark.className = 'mark';
        let hideLabel = false;
        if (config.logo) {
            const plan = planLogo(config.logo, LAUNCHER_BOX, {
                backgroundColour: config.accentColour ?? BRAND.ink,
                isLauncher: true,
            });
            hideLabel = plan.hideLabel;
            if (plan.useMonogram) {
                // Too wide to read at launcher size. Initials go here; the real logo
                // still appears in the panel header, which has the width to carry it.
                // An unreadable smear of a customer's wordmark looks like a broken
                // widget, which is worse than showing their initials on purpose.
                mark.append(this.monogram(config));
            }
            else {
                if (plan.treatment === 'chip')
                    mark.classList.add('chip');
                // Never innerHTML. A customer-supplied SVG inlined into this shadow
                // root would execute on the customer's own site under their origin;
                // inside an <img> it cannot.
                const image = document.createElement('img');
                image.src = plan.source;
                image.alt = plan.altText;
                image.width = plan.widthPx;
                image.height = plan.heightPx;
                image.decoding = 'async';
                // A broken image icon on a customer's own website is worse than no
                // logo, so a failed load falls back to initials rather than nothing.
                image.addEventListener('error', () => {
                    mark.replaceChildren(this.monogram(config));
                    mark.classList.remove('chip');
                }, { once: true });
                mark.append(image);
            }
        }
        else if (config.organisationName) {
            mark.append(this.monogram(config));
        }
        else {
            // Detent's own mark, inline. It is ours and it is constant, so there is
            // no untrusted content to worry about and no network fetch to make.
            mark.innerHTML = detentMark(15);
        }
        const label = document.createElement('span');
        label.textContent = config.launcherLabel ?? 'Ask a question';
        if (hideLabel)
            label.className = 'visually-hidden';
        // The Article 50 disclosure begins on the launcher itself, before anyone
        // has typed anything. It is in the surface, not in a privacy policy.
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'AI';
        const hint = document.createElement('span');
        hint.className = 'visually-hidden';
        hint.textContent = 'Opens an AI assistant. You are not speaking with a person. A text-only route is available.';
        button.append(mark, label, badge, hint);
        button.addEventListener('click', () => this.toggle(button));
        // Announces open and close to assistive technology.
        const live = document.createElement('div');
        live.setAttribute('role', 'status');
        live.setAttribute('aria-live', 'polite');
        live.className = 'visually-hidden';
        live.id = 'awa-live';
        this.shadow.replaceChildren(style, button, live);
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.open)
                this.toggle(button);
        });
    }
    toggle(button) {
        this.open = !this.open;
        button.setAttribute('aria-expanded', String(this.open));
        const live = this.shadow.getElementById('awa-live');
        if (live)
            live.textContent = this.open ? 'Assistant opened.' : 'Assistant closed.';
        const existing = this.shadow.getElementById('awa-panel');
        if (!this.open) {
            existing?.remove();
            button.focus();
            return;
        }
        if (existing)
            return;
        const config = this.config();
        const panel = document.createElement('div');
        panel.className = 'panel';
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
        // Resolved against the page, so the panel may be given either an absolute
        // URL, which is what a customer's snippet carries, since their page is on
        // their domain and has to point at ours, or a relative one, which is what
        // our own site uses. Without the base, a relative URL throws and the panel
        // never opens at all.
        const url = new URL(config.panelUrl, window.location.href);
        url.searchParams.set('key', config.publicKey);
        url.searchParams.set('api', config.apiBaseUrl);
        // The host's consent decision travels to the panel. The panel never decides
        // it for itself.
        url.searchParams.set('consent_personalisation', String(this.consent.identityResolution));
        url.searchParams.set('consent_source', this.consent.source);
        if (config.jurisdiction)
            url.searchParams.set('jurisdiction', config.jurisdiction);
        frame.src = url.toString();
        panel.append(frame);
        this.shadow.append(panel);
        frame.focus();
    }
}
export function registerLauncher() {
    if (!customElements.get('detent-assistant')) {
        customElements.define('detent-assistant', DetentAssistantLauncher);
    }
}
