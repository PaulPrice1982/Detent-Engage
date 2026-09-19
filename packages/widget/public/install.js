const $ = (id) => document.getElementById(id);
  const fields = ['api', 'key', 'label', 'position', 'locale', 'mode'];

  function originOf(value) {
    try { return new URL(value, location.href).origin; } catch { return value || 'https://api.detentgtm.io'; }
  }

  function render() {
    const api = $('api').value.trim() || location.origin;
    const origin = originOf(api);
    const attributes = [
      `  src="${origin}/widget/loader.js"`,
      '  data-detent-assistant',
      `  data-api="${api}"`,
      `  data-key="${$('key').value.trim() || 'awa_pub_…'}"`,
      `  data-panel="${origin}/widget/panel.html"`,
      `  data-label="${$('label').value.trim() || 'Ask a question'}"`,
      `  data-position="${$('position').value}"`,
    ];
    if ($('locale').value) attributes.push(`  data-locale="${$('locale').value}"`);
    // Test mode is a gate on the loader, not a different build: the same
    // snippet, inert unless the page asks for it.
    if ($('mode').value === 'test') attributes.push('  data-test-mode="query:detent=test"');
    attributes.push('  async');

    $('snippet').textContent = `<script\n${attributes.join('\n')}></script>`;
    $('csp').textContent = [
      `script-src  ${origin};`,
      `frame-src   ${origin};`,
      `connect-src ${origin};`,
    ].join('\n');
  }

  for (const id of fields) $(id).addEventListener('input', render);
  $('api').value = location.origin;
  render();

  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('snippet').textContent);
      $('copied').hidden = false;
      setTimeout(() => { $('copied').hidden = true; }, 2500);
    } catch {
      $('copied').hidden = false;
      $('copied').textContent = 'Select the snippet and copy it.';
    }
  });

  $('verify').addEventListener('click', async () => {
    const result = $('verify-result');
    const api = $('api').value.trim() || location.origin;
    const tenant = $('tenant').value.trim();
    const admin = $('admin').value.trim();
    const url = $('verify-url').value.trim();
    if (!tenant || !admin || !url) {
      result.className = 'bad';
      result.textContent = 'A page URL, a tenant id and an admin key are all needed.';
      return;
    }
    result.className = '';
    result.textContent = 'Checking…';
    try {
      const response = await fetch(`${api}/v1/admin/tenants/${encodeURIComponent(tenant)}/origins`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
        body: JSON.stringify({ origins: [originOf(url)], verifyUrl: url }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? 'verification failed');
      result.className = payload.verification?.verified ? 'ok' : 'bad';
      result.textContent = payload.verification?.reason ?? 'No verification result returned.';
    } catch (error) {
      result.className = 'bad';
      result.textContent = error.message;
    }
  });
