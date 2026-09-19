import { registerLauncher } from './launcher.js';
function currentScript() {
    return document.currentScript
        ?? document.querySelector('script[data-detent-assistant]')
        ?? undefined;
}
export function mount(options = {}) {
    registerLauncher();
    if (document.querySelector('detent-assistant'))
        return;
    const script = currentScript();
    const element = document.createElement('detent-assistant');
    const attribute = (name, value) => {
        if (value)
            element.setAttribute(name, value);
    };
    attribute('data-api', options.api ?? script?.dataset['api']);
    attribute('data-key', options.key ?? script?.dataset['key']);
    attribute('data-panel', options.panel ?? script?.dataset['panel']);
    attribute('data-label', options.label ?? script?.dataset['label']);
    attribute('data-jurisdiction', options.jurisdiction ?? script?.dataset['jurisdiction']);
    attribute('data-accent', options.accent ?? script?.dataset['accent']);
    // Passed through so an attribute set by the tenant's tag manager is honoured.
    attribute('data-consent-personalisation', script?.dataset['consentPersonalisation']);
    document.body.append(element);
}
if (typeof window !== 'undefined') {
    window.DetentAssistant = { mount };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => mount(), { once: true });
    }
    else {
        mount();
    }
}
