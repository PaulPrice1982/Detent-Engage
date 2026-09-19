/**
 * Reading the host page's consent signal (section 25.2, table 35).
 *
 * The identifier is set in the tenant's context, so the tenant obtains consent
 * through its own consent management platform and the widget reads that signal.
 * A widget that sets identifiers regardless of the host page's consent state
 * makes the platform complicit in the tenant's breach, so the default when no
 * signal can be read is "no consent", never "assume yes".
 */
export type ConsentSignal = {
  readonly identityResolution: boolean;
  readonly source: 'tcf' | 'onetrust' | 'cookiebot' | 'dataLayer' | 'attribute' | 'none';
};

const NO_CONSENT: ConsentSignal = { identityResolution: false, source: 'none' };

interface TcfApi {
  (command: string, version: number, callback: (data: unknown, success: boolean) => void): void;
}

export function readHostConsent(root: Window, element?: Element): ConsentSignal {
  // 1. An explicit attribute on the script tag wins: it is the tenant stating
  //    its position directly, and it is testable at install time.
  const attribute = element?.getAttribute('data-consent-personalisation');
  if (attribute === 'granted') return { identityResolution: true, source: 'attribute' };
  if (attribute === 'denied') return { identityResolution: false, source: 'attribute' };

  // 2. IAB TCF, where the host runs one. Purpose 1 is storage and access.
  const tcf = (root as unknown as { __tcfapi?: TcfApi }).__tcfapi;
  if (typeof tcf === 'function') {
    let signal: ConsentSignal | undefined;
    try {
      tcf('getTCData', 2, (data, success) => {
        if (!success) return;
        const purposes = (data as { purpose?: { consents?: Record<string, boolean> } }).purpose?.consents;
        signal = { identityResolution: purposes?.['1'] === true, source: 'tcf' };
      });
    } catch { /* a broken CMP is treated as absent, i.e. no consent */ }
    if (signal) return signal;
  }

  // 3. OneTrust and Cookiebot, the two most common in the UK mid-market.
  const oneTrust = (root as unknown as { OnetrustActiveGroups?: string }).OnetrustActiveGroups;
  if (typeof oneTrust === 'string') {
    // Group C0003 is "functional"; C0004 is "targeting". Personalisation
    // against a CRM is at least functional.
    return { identityResolution: oneTrust.includes('C0003') || oneTrust.includes('C0004'), source: 'onetrust' };
  }

  const cookiebot = (root as unknown as { Cookiebot?: { consent?: { preferences?: boolean } } }).Cookiebot;
  if (cookiebot?.consent) {
    return { identityResolution: cookiebot.consent.preferences === true, source: 'cookiebot' };
  }

  // 4. A dataLayer flag, for tenants wiring this through a tag manager.
  const dataLayer = (root as unknown as { dataLayer?: Array<Record<string, unknown>> }).dataLayer;
  if (Array.isArray(dataLayer)) {
    const latest = [...dataLayer].reverse().find((entry) => 'detent_consent_personalisation' in entry);
    if (latest) {
      return { identityResolution: latest['detent_consent_personalisation'] === true, source: 'dataLayer' };
    }
  }

  return NO_CONSENT;
}
