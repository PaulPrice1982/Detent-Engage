import { registerLauncher } from './launcher.js';

/**
 * The loader. Under 40KB gzipped and never in the host page's critical path
 * (NFR-013): the conversation bundle lives in the sandboxed panel and is
 * fetched only when someone actually opens the assistant, so a host page that
 * nobody interacts with pays for one small script and nothing else.
 */
declare global {
  interface Window { DetentAssistant?: { mount(options?: MountOptions): void } }
}

export interface MountOptions {
  readonly api?: string;
  readonly key?: string;
  readonly panel?: string;
  readonly label?: string;
  readonly jurisdiction?: string;
  readonly accent?: string;
}

function currentScript(): HTMLScriptElement | undefined {
  return (document.currentScript as HTMLScriptElement | null)
    ?? document.querySelector<HTMLScriptElement>('script[data-detent-assistant]')
    ?? undefined;
}

export function mount(options: MountOptions = {}): void {
  registerLauncher();
  if (document.querySelector('detent-assistant')) return;

  const script = currentScript();
  const element = document.createElement('detent-assistant');
  const attribute = (name: string, value: string | null | undefined) => {
    if (value) element.setAttribute(name, value);
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
  } else {
    mount();
  }
}
