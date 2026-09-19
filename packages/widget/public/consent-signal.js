const NO_CONSENT = { identityResolution: false, source: 'none' };
export function readHostConsent(root, element) {
    // 1. An explicit attribute on the script tag wins: it is the tenant stating
    //    its position directly, and it is testable at install time.
    const attribute = element?.getAttribute('data-consent-personalisation');
    if (attribute === 'granted')
        return { identityResolution: true, source: 'attribute' };
    if (attribute === 'denied')
        return { identityResolution: false, source: 'attribute' };
    // 2. IAB TCF, where the host runs one. Purpose 1 is storage and access.
    const tcf = root.__tcfapi;
    if (typeof tcf === 'function') {
        let signal;
        try {
            tcf('getTCData', 2, (data, success) => {
                if (!success)
                    return;
                const purposes = data.purpose?.consents;
                signal = { identityResolution: purposes?.['1'] === true, source: 'tcf' };
            });
        }
        catch { /* a broken CMP is treated as absent, i.e. no consent */ }
        if (signal)
            return signal;
    }
    // 3. OneTrust and Cookiebot, the two most common in the UK mid-market.
    const oneTrust = root.OnetrustActiveGroups;
    if (typeof oneTrust === 'string') {
        // Group C0003 is "functional"; C0004 is "targeting". Personalisation
        // against a CRM is at least functional.
        return { identityResolution: oneTrust.includes('C0003') || oneTrust.includes('C0004'), source: 'onetrust' };
    }
    const cookiebot = root.Cookiebot;
    if (cookiebot?.consent) {
        return { identityResolution: cookiebot.consent.preferences === true, source: 'cookiebot' };
    }
    // 4. A dataLayer flag, for tenants wiring this through a tag manager.
    const dataLayer = root.dataLayer;
    if (Array.isArray(dataLayer)) {
        const latest = [...dataLayer].reverse().find((entry) => 'detent_consent_personalisation' in entry);
        if (latest) {
            return { identityResolution: latest['detent_consent_personalisation'] === true, source: 'dataLayer' };
        }
    }
    return NO_CONSENT;
}
