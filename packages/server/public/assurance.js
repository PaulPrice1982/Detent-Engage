/**
 * Builds the assurance pack from the API and renders it as a document
 * (audit BIZ-2). Everything on the page comes from the pack endpoint; nothing
 * is computed here, because a figure computed in the browser is a figure the
 * audit chain does not stand behind.
 */
const $ = (id) => document.getElementById(id);

const escape = (text) => String(text).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const stat = (label, value, tone = '') =>
  `<div class="stat ${tone}"><div class="value">${escape(String(value))}</div><div class="label">${escape(label)}</div></div>`;

const store = {
  get: (key) => sessionStorage.getItem(`awa.assurance.${key}`) ?? '',
  set: (key, value) => sessionStorage.setItem(`awa.assurance.${key}`, value),
};

async function call(path) {
  const response = await fetch(`${$('api').value.trim()}${path}`, {
    headers: { authorization: `Bearer ${$('key').value.trim()}` },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message ?? `request failed (${response.status})`);
  return payload;
}

function windowQuery() {
  const from = $('from').value.trim();
  const to = $('to').value.trim();
  const params = new URLSearchParams();
  if (from && to) { params.set('from', from); params.set('to', to); }
  const correlationId = new URLSearchParams(location.search).get('correlation_id');
  if (correlationId) params.set('correlation_id', correlationId);
  const query = params.toString();
  return query ? `?${query}` : '';
}

async function build() {
  const tenant = $('tenant').value.trim();
  if (!tenant) { $('status').textContent = 'A tenant id is required.'; return; }
  for (const key of ['api', 'tenant', 'from', 'to']) store.set(key, $(key).value.trim());
  $('status').textContent = 'Building…';

  let pack;
  try {
    pack = await call(`/v1/admin/tenants/${encodeURIComponent(tenant)}/assurance${windowQuery()}`);
  } catch (error) {
    $('status').textContent = error.message;
    return;
  }
  $('status').textContent = '';
  $('pack').hidden = false;

  const compliance = pack.compliance ?? {};
  const evidence = compliance.evidence ?? {};

  $('pack-title').textContent = `${pack.tenantName ?? tenant}, behavioural assurance`;
  $('pack-meta').textContent = [
    `Generated ${(pack.generatedAt ?? '').slice(0, 19).replace('T', ' ')} UTC`,
    pack.window?.from?.startsWith('0000')
      ? 'All recorded activity'
      : `Period ${(pack.window?.from ?? '').slice(0, 10)} to ${(pack.window?.to ?? '').slice(0, 10)}`,
    `Tenant ${tenant}`,
  ].join(' · ');

  // 1 · integrity
  $('integrity').innerHTML = `
    <div class="banner ${evidence.chainVerified ? 'ok' : 'bad'}">
      ${evidence.chainVerified
        ? 'The audit chain verifies. Every figure below is derived from it.'
        : `The audit chain DOES NOT verify${evidence.brokenAtSequence ? ` (broken at sequence ${evidence.brokenAtSequence})` : ''}. This pack is not evidence and must not be filed as such.`}
    </div>
    <div class="stats">
      ${stat('Audit entries examined', evidence.auditEntriesExamined ?? 0)}
      ${stat('Chain verified', evidence.chainVerified ? 'yes' : 'no', evidence.chainVerified ? 'good' : 'bad')}
    </div>`;

  // 2 · disclosure
  const coverage = compliance.aiDisclosureCoveragePct ?? 0;
  $('disclosure').innerHTML = `<div class="stats">
    ${stat('Sessions opened', compliance.sessionsOpened ?? 0)}
    ${stat('Disclosures shown', compliance.sessionsWithDisclosure ?? 0)}
    ${stat('Coverage', `${coverage}%`, coverage >= 100 ? 'good' : 'bad')}
  </div>`;

  // 3 · consent
  const rows = compliance.consentEvents ?? [];
  $('consent').innerHTML = `
    <thead><tr><th>Purpose</th><th>Jurisdiction</th><th>Granted</th><th>Refused</th><th>Withdrawn</th></tr></thead>
    <tbody>${rows.length
      ? rows.map((row) => `<tr><td>${escape(row.purpose)}</td><td>${escape(row.jurisdiction)}</td><td>${row.granted}</td><td>${row.refused}</td><td>${row.withdrawn}</td></tr>`).join('')
      : '<tr><td colspan="5">No consent events in this period.</td></tr>'}
    <tr><td colspan="3"><strong>Identity resolutions blocked for consent</strong></td><td colspan="2">${compliance.identityResolutionsBlockedForConsent ?? 0}</td></tr>
    <tr><td colspan="3"><strong>Marketing enrolments blocked</strong></td><td colspan="2">${compliance.marketingEnrolmentsBlocked ?? 0}</td></tr>
    </tbody>`;

  // 4 · deterministic boundaries
  const boundaries = pack.deterministicBoundaries ?? [];
  $('boundaries').innerHTML = `
    <thead><tr><th>Control</th><th>Enforced by</th><th>Evidence</th></tr></thead>
    <tbody>${boundaries.map((row) => `
      <tr>
        <td>${escape(row.control ?? row.name ?? '')}</td>
        <td>${escape(row.enforcedBy ?? row.mechanism ?? '')}</td>
        <td>${escape(row.evidence ?? row.test ?? '')}</td>
      </tr>`).join('') || '<tr><td colspan="3">None declared.</td></tr>'}</tbody>`;

  // 5 · security
  $('security').innerHTML = `<div class="stats">
    ${stat('Injection attempts refused', compliance.injectionAttemptsRefused ?? 0)}
    ${stat('Cross-tenant denials', compliance.crossTenantDenials ?? 0)}
    ${stat('Outputs blocked', compliance.outputsBlocked ?? 0)}
    ${stat('CRM disclosure denials', compliance.crmDisclosureDenials ?? 0)}
  </div>`;
  const detection = pack.injectionDetection;
  $('injection-note').textContent = detection
    ? `Measured against the held-out adversarial corpus at this release: ${detection.hostileCaught} of ${detection.hostileTotal} hostile cases detected (${detection.detectionRatePct}%), ${detection.benignFlagged} of ${detection.benignTotal} benign commercial messages incorrectly flagged (${detection.falsePositiveRatePct}%). The pattern pass is a first stage; a deployment may add a classifier behind it.`
    : '';

  // 6 · accessibility
  const accessibility = pack.accessibility ?? {};
  $('accessibility').innerHTML = `
    <div class="stats">
      ${stat('Standard', accessibility.standard ?? '-')}
      ${stat('Conformance', accessibility.conformance ?? 'not assessed')}
    </div>
    <p class="note">${escape(accessibility.statement ?? '')}</p>
    <ul>${(accessibility.knownLimitations ?? []).map((limitation) => `<li>${escape(limitation)}</li>`).join('')}</ul>`;

  // 7 · replay
  if (pack.sampleReplay) {
    const replay = pack.sampleReplay;
    $('replay').innerHTML = `
      <p class="note">Correlation id <code>${escape(replay.correlationId)}</code>, replayed against the
        prompt, policy and model versions pinned at the time.</p>
      <table>
        <thead><tr><th>#</th><th>At</th><th>Event</th><th>Actor</th></tr></thead>
        <tbody>${(replay.entries ?? []).map((entry) => `
          <tr><td>${entry.sequence}</td><td>${escape((entry.at ?? '').slice(0, 19).replace('T', ' '))}</td>
          <td>${escape(entry.type)}</td><td>${escape(entry.actor)}</td></tr>`).join('')}</tbody>
      </table>`;
  }

  // 8 · caveats
  $('caveats').innerHTML = (pack.caveats ?? []).map((caveat) => `<li>${escape(caveat)}</li>`).join('');
  $('colophon').textContent =
    `Prepared by the Detent Agentic Website Assistant from tenant ${tenant}'s own audit log. `
    + 'Figures are derived, not asserted: the chain verification above is the warrant for every number in this document.';
}

$('load').addEventListener('click', build);
$('print').addEventListener('click', () => window.print());

$('api').value = store.get('api') || location.origin;
$('tenant').value = store.get('tenant');
$('from').value = store.get('from');
$('to').value = store.get('to');
