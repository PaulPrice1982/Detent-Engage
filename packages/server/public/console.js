// --- session -------------------------------------------------------------
  const store = {
    get base() { return sessionStorage.getItem('awa.console.base') ?? ''; },
    get tenant() { return sessionStorage.getItem('awa.console.tenant') ?? ''; },
    get key() { return sessionStorage.getItem('awa.console.key') ?? ''; },
    set(base, tenant, key) {
      sessionStorage.setItem('awa.console.base', base);
      sessionStorage.setItem('awa.console.tenant', tenant);
      sessionStorage.setItem('awa.console.key', key);
    },
    clear() {
      for (const k of ['base', 'tenant', 'key']) sessionStorage.removeItem(`awa.console.${k}`);
    },
  };

  const $ = (id) => document.getElementById(id);
  let auditCursor;

  function toast(message, bad = false) {
    const el = $('toast');
    el.textContent = message;
    el.className = bad ? 'toast bad' : 'toast';
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 6000);
  }

  async function call(path, options = {}) {
    const response = await fetch(`${store.base}${path}`, {
      method: options.method ?? 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${store.key}` },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const error = new Error(payload.message ?? `request failed (${response.status})`);
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  const tenantPath = (suffix = '') => `/v1/admin/tenants/${encodeURIComponent(store.tenant)}${suffix}`;

  // --- navigation ----------------------------------------------------------
  const screens = ['connect', 'generate', 'dryrun', 'golive', 'evidence'];
  function show(name) {
    for (const screen of screens) $(`screen-${screen}`).hidden = screen !== name;
    for (const button of document.querySelectorAll('nav.steps button')) {
      if (button.dataset.screen === name) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    }
    location.hash = name;
  }
  for (const button of document.querySelectorAll('nav.steps button')) {
    button.addEventListener('click', () => show(button.dataset.screen));
  }

  // --- connect -------------------------------------------------------------
  $('sign-in').addEventListener('click', async () => {
    const base = $('api-base').value.trim().replace(/\/+$/, '');
    const tenant = $('tenant-id').value.trim();
    const key = $('admin-key').value.trim();
    if (!tenant || !key) return toast('A tenant id and an admin key are required.', true);
    store.set(base, tenant, key);
    await loadConfig();
  });

  $('sign-out').addEventListener('click', () => { store.clear(); location.reload(); });

  function stat(label, value) {
    return `<div class="stat"><div class="value">${escape(String(value))}</div><div class="label">${escape(label)}</div></div>`;
  }

  function escape(text) {
    return String(text).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  async function loadConfig() {
    let config;
    try {
      config = await call(tenantPath());
    } catch (error) {
      return toast(error.message, true);
    }
    $('tenant-name').textContent = config.name;
    $('state-pill').textContent = config.state;
    $('state-pill').className = `pill ${config.state === 'LIVE' ? 'ok' : 'warn'}`;
    $('sign-out').hidden = false;
    $('signin-card').hidden = true;
    for (const id of ['config-card', 'origins-card', 'keys-card', 'snippet-card']) $(id).hidden = false;

    $('config-stats').innerHTML = [
      stat('State', config.state),
      stat('Config version', config.version),
      stat('Residency', config.residency),
      stat('Connector', config.connector),
      stat('Dry run', config.dry_run ? 'on' : 'off'),
      stat('Kill switch', config.kill_switch),
    ].join('');

    $('origins').value = (config.origins ?? []).join('\n');
    renderSnippet(config);
    await loadKeys();
    await loadChecklist(config);

    // Durability, stated rather than assumed. A deployment running on the
    // in-memory stores loses its evidence on restart, and the person operating
    // the console is the person who should know that.
    try {
      const status = await call('/v1/admin/status');
      const pill = $('durability-pill');
      pill.hidden = false;
      pill.textContent = status.durable ? 'durable storage' : 'in-memory storage';
      pill.className = `pill ${status.durable ? 'ok' : 'bad'}`;
    } catch { /* a tenant admin may not read platform status */ }
  }

  function renderSnippet(config) {
    const panel = `${store.base}/widget/panel.html`;
    $('snippet').textContent = `<script
  src="${store.base}/widget/loader.js"
  data-detent-assistant
  data-api="${store.base}"
  data-key="awa_pub_…"
  data-panel="${panel}"
  data-label="${config.branding?.launcherLabel ?? 'Ask a question'}"
  data-jurisdiction="UK"
  async></script>`;
    const origin = safeOrigin(store.base);
    $('csp').textContent = [
      `script-src  ${origin};`,
      `frame-src   ${origin};`,
      `connect-src ${origin};`,
    ].join('\n');
  }

  function safeOrigin(base) {
    try { return new URL(base, location.href).origin; } catch { return base; }
  }

  async function loadKeys() {
    try {
      const { keys } = await call(tenantPath('/keys'));
      $('keys-body').innerHTML = keys.map((key) => `
        <tr>
          <td><code>${escape(key.prefix)}</code></td>
          <td>${escape(key.audience)}</td>
          <td>${escape(key.createdAt.slice(0, 10))}</td>
          <td>${escape(key.lastUsedAt?.slice(0, 16).replace('T', ' ') ?? 'never')}</td>
          <td>${escape(key.expiresAt?.slice(0, 10) ?? '—')}</td>
          <td>
            ${key.active
              ? `<button class="secondary" data-rotate="${escape(key.id)}">Rotate</button>
                 <button class="secondary" data-revoke="${escape(key.id)}">Revoke</button>`
              : '<span class="muted">inactive</span>'}
          </td>
        </tr>`).join('') || '<tr><td colspan="6" class="muted">No keys issued.</td></tr>';

      for (const button of $('keys-body').querySelectorAll('[data-rotate]')) {
        button.addEventListener('click', async () => {
          const result = await call(tenantPath('/keys'), { method: 'POST', body: { rotate: button.dataset.rotate } });
          revealKey(result.key);
          await loadKeys();
        });
      }
      for (const button of $('keys-body').querySelectorAll('[data-revoke]')) {
        button.addEventListener('click', async () => {
          await call(`${tenantPath('/keys')}?key_id=${encodeURIComponent(button.dataset.revoke)}`, { method: 'DELETE' });
          toast('Key revoked.');
          await loadKeys();
        });
      }
    } catch (error) { toast(error.message, true); }
  }

  function revealKey(key) {
    $('new-key').hidden = false;
    $('new-key-value').textContent = key;
  }

  $('issue-widget-key').addEventListener('click', async () => {
    try {
      const result = await call(tenantPath('/keys'), {
        method: 'POST',
        body: { audience: 'widget', label: 'website' },
      });
      revealKey(result.key);
      await loadKeys();
    } catch (error) { toast(error.message, true); }
  });
  $('refresh-keys').addEventListener('click', loadKeys);

  $('save-origins').addEventListener('click', async () => {
    const origins = $('origins').value.split('\n').map((line) => line.trim()).filter(Boolean);
    const verifyUrl = $('verify-url').value.trim() || undefined;
    try {
      const result = await call(tenantPath('/origins'), { method: 'POST', body: { origins, verifyUrl } });
      $('verify-result').textContent = result.verification?.reason ?? '';
      toast(`${result.origins.length} origin(s) registered.`);
    } catch (error) { toast(error.message, true); }
  });

  // --- generate ------------------------------------------------------------
  $('run-generation').addEventListener('click', async () => {
    const rootUrl = $('root-url').value.trim();
    if (!rootUrl) return toast('A root URL is required.', true);
    try {
      const result = await call(tenantPath('/generation'), { method: 'POST', body: { rootUrl } });
      toast(`Generated in ${result.durationMs}ms. Nothing serves until approved.`);
      await loadCoverage();
    } catch (error) { toast(error.message, true); }
  });

  async function loadCoverage() {
    try {
      const result = await call(tenantPath('/generation'));
      const coverage = result.coverage ?? {};
      const cells = Object.entries(coverage).map(([section, value]) =>
        stat(section, typeof value === 'number' ? `${Math.round(value * 100)}%` : String(value)));
      $('coverage-stats').innerHTML = cells.join('') || '<p class="muted">Nothing generated yet.</p>';
    } catch (error) {
      $('coverage-stats').innerHTML = `<p class="muted">${escape(error.message)}</p>`;
    }
  }

  $('sign-off').addEventListener('click', async () => {
    const section = $('approve-section').value;
    const approvedBy = $('approved-by').value.trim();
    if (!approvedBy) return toast('Approval needs a named person.', true);
    try {
      const result = await call(tenantPath('/approve'), {
        method: 'POST', body: { section, approvedBy, signOff: true },
      });
      toast(result.fullyApproved ? 'Approved. Every section is now signed off.' : 'Section approved.');
      await loadCoverage();
    } catch (error) { toast(error.message, true); }
  });

  // --- dry run -------------------------------------------------------------
  $('load-diff').addEventListener('click', async () => {
    try {
      const diff = await call(tenantPath('/dry-run'));
      const writes = diff.writes ?? diff.staged ?? [];
      $('diff-body').innerHTML = `
        <div class="grid">
          ${stat('Total writes', diff.totalWrites ?? writes.length)}
          ${stat('Creates', diff.creates ?? '—')}
          ${stat('Updates', diff.updates ?? '—')}
        </div>
        <pre>${escape(JSON.stringify(diff, null, 2))}</pre>`;
    } catch (error) { toast(error.message, true); }
  });

  $('accept-diff').addEventListener('click', async () => {
    try {
      const result = await call(tenantPath('/dry-run'), { method: 'POST', body: {} });
      toast(`Accepted ${result.applied} staged write(s). CRM writes are enabled.`);
      await loadConfig();
    } catch (error) { toast(error.message, true); }
  });

  // --- go live -------------------------------------------------------------
  async function loadChecklist(config) {
    const items = [
      ['DPA recorded', Boolean(config.dpa_signed_at)],
      ['CRM connected', ['CRM_CONNECTED', 'MAPPED', 'TEST_MODE', 'LIVE', 'DEGRADED'].includes(config.state)],
      ['Field mapping accepted', Boolean(config.field_mapping_accepted_at)],
      ['Dry run accepted', config.dry_run === false],
      ['Origins registered', (config.origins ?? []).length > 0],
      ['Disclosure present', Boolean(config.disclosure?.text)],
      ['Live', config.state === 'LIVE'],
    ];
    $('golive-checklist').innerHTML = items.map(([label, done]) => `
      <li><span class="tick ${done ? 'done' : 'todo'}">${done ? '✓' : '·'}</span>
      <span>${escape(label)}</span></li>`).join('');
    $('kill-switch').value = config.kill_switch ?? 'OFF';
    await loadPlaybooks();
  }

  async function loadPlaybooks() {
    try {
      const result = await call(tenantPath('/playbooks'));
      $('playbooks-body').innerHTML = (result.versions ?? []).map((version) => `
        <tr>
          <td>${version.version}${version.version === result.active ? ' <span class="pill ok">active</span>' : ''}</td>
          <td>${escape(version.author ?? '—')}</td>
          <td>${escape((version.publishedAt ?? '').slice(0, 16).replace('T', ' '))}</td>
          <td>${escape(version.note ?? '')}</td>
          <td>${version.version === result.active ? '' : `<button class="secondary" data-rollback="${version.version}">Roll back</button>`}</td>
        </tr>`).join('') || '<tr><td colspan="5" class="muted">No published versions.</td></tr>';

      for (const button of $('playbooks-body').querySelectorAll('[data-rollback]')) {
        button.addEventListener('click', async () => {
          const author = prompt('Rolling back is an audited change. Who is doing it?');
          if (!author) return;
          await call(tenantPath('/rollback'), {
            method: 'POST', body: { version: Number(button.dataset.rollback), author },
          });
          toast('Rolled back.');
          await loadPlaybooks();
        });
      }
    } catch (error) {
      $('playbooks-body').innerHTML = `<tr><td colspan="5" class="muted">${escape(error.message)}</td></tr>`;
    }
  }

  $('transition').addEventListener('click', async () => {
    try {
      await call(tenantPath('/lifecycle'), { method: 'POST', body: { to: $('lifecycle-target').value } });
      toast('Lifecycle state changed.');
      await loadConfig();
    } catch (error) { toast(error.message, true); }
  });

  $('set-kill-switch').addEventListener('click', async () => {
    try {
      await call(tenantPath(), { method: 'PATCH', body: { killSwitch: $('kill-switch').value } });
      toast('Kill switch applied.');
      await loadConfig();
    } catch (error) {
      // A tenant admin may not set the kill switch: it is operator-authority.
      toast(error.message, true);
    }
  });

  // --- evidence ------------------------------------------------------------
  function windowQuery() {
    const from = $('from').value.trim();
    const to = $('to').value.trim();
    return from && to ? `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : '';
  }

  $('load-evidence').addEventListener('click', async () => {
    auditCursor = undefined;
    const query = windowQuery();
    try {
      const analytics = await call(tenantPath('/analytics') + query);
      const headline = analytics.headline ?? {};
      $('value-stats').innerHTML = [
        stat('Meetings held', headline.meetings_held ?? 0),
        stat('Qualified leads', headline.qualified_leads ?? 0),
        stat('Deflection rate', `${headline.deflection_rate_pct ?? 0}%`),
        stat('Hours saved', headline.implied_hours_saved ?? 0),
        stat('Out-of-hours sessions', headline.outside_business_hours_sessions ?? 0),
        stat('Cost per conversation', `${analytics.cost?.costPerConversationPence?.toFixed?.(2) ?? '—'}p`),
      ].join('');
    } catch (error) { toast(error.message, true); }

    try {
      const compliance = await call(tenantPath('/compliance') + query);
      $('compliance-stats').innerHTML = [
        stat('AI disclosure coverage', `${compliance.aiDisclosureCoveragePct}%`),
        stat('Sessions', compliance.sessionsOpened),
        stat('Consent events', (compliance.consentEvents ?? []).reduce((sum, row) => sum + row.granted + row.refused + row.withdrawn, 0)),
        stat('Resolutions blocked', compliance.identityResolutionsBlockedForConsent),
        stat('Injection attempts refused', compliance.injectionAttemptsRefused),
        stat('Cross-tenant denials', compliance.crossTenantDenials),
        stat('Outputs blocked', compliance.outputsBlocked),
        stat('Chain verified', compliance.evidence?.chainVerified ? 'yes' : 'NO'),
      ].join('');
    } catch (error) { toast(error.message, true); }

    try {
      const ledger = await call(tenantPath('/outcome-ledger') + query);
      $('ledger-body').innerHTML = (ledger.rows ?? []).map((row) => `
        <tr>
          <td>${escape(row.outcome)}</td>
          <td>${escape(row.state)}</td>
          <td>${row.billable ? 'yes' : 'no'}</td>
          <td>${escape((row.recorded_at ?? '').slice(0, 16).replace('T', ' '))}</td>
          <td><button class="secondary" data-replay="${escape(row.correlation_id)}">Replay</button></td>
        </tr>`).join('') || '<tr><td colspan="5" class="muted">No outcomes in this window.</td></tr>';

      for (const button of $('ledger-body').querySelectorAll('[data-replay]')) {
        button.addEventListener('click', async () => {
          const replay = await call(`${tenantPath('/replay')}?correlation_id=${encodeURIComponent(button.dataset.replay)}`);
          $('audit-summary').innerHTML = `<pre>${escape(JSON.stringify(replay, null, 2))}</pre>`;
        });
      }
    } catch (error) { toast(error.message, true); }

    await loadAudit(true);
  });

  async function loadAudit(reset) {
    if (reset) { auditCursor = undefined; $('audit-body').innerHTML = ''; }
    const query = auditCursor === undefined ? '?limit=100' : `?limit=100&since=${auditCursor}`;
    try {
      const page = await call(tenantPath('/audit') + query);
      const verification = page.verification ?? {};
      $('audit-summary').innerHTML = `
        <p>
          <span class="pill ${verification.valid ? 'ok' : 'bad'}">${verification.valid ? 'chain verifies' : 'CHAIN BROKEN'}</span>
          <span class="muted">${page.page.returned} of ${page.page.total} entries${
            verification.resumedFromSequence ? `, verified from a signed checkpoint at #${verification.resumedFromSequence}` : ''
          }</span>
        </p>`;
      $('audit-body').insertAdjacentHTML('beforeend', page.entries.map((entry) => `
        <tr>
          <td>${entry.sequence}</td>
          <td>${escape(entry.recordedAt.slice(0, 19).replace('T', ' '))}</td>
          <td>${escape(entry.type)}</td>
          <td>${escape(entry.actor)}</td>
          <td><code>${escape(entry.correlationId)}</code></td>
        </tr>`).join(''));
      auditCursor = page.page.nextCursor;
      $('load-more-audit').hidden = auditCursor === undefined;
    } catch (error) { toast(error.message, true); }
  }

  $('load-more-audit').addEventListener('click', () => loadAudit(false));

  $('download-compliance').addEventListener('click', async () => {
    try {
      const scorecard = await call(tenantPath('/compliance') + windowQuery());
      const blob = new Blob([JSON.stringify(scorecard, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `compliance-${store.tenant}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (error) { toast(error.message, true); }
  });

  // --- boot ----------------------------------------------------------------
  $('api-base').value = store.base || location.origin;
  $('tenant-id').value = store.tenant;
  if (store.key) loadConfig().then(loadCoverage);
  const initial = location.hash.slice(1);
  show(screens.includes(initial) ? initial : 'connect');
