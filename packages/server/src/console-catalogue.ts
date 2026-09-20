import { format, money, type PlanVersion, type PriceImpact } from '@detent/awa-billing';
import { escape, page, pill } from './site-html.js';

/**
 * The pricing screen of the back office.
 *
 * The one thing this page must make unmissable is that **editing a price does
 * not change what existing customers pay**. Every operator who has used a
 * billing tool has been bitten by one that did, and the fear of it is what
 * makes people avoid the screen and email a developer instead.
 */

const NAV = (current: string) => [
  { href: '/console', label: 'Accounts', current: current === 'accounts' },
  { href: '/console/new', label: 'New account' },
  { href: '/console/pricing', label: 'Pricing', current: current === 'pricing' },
  { href: '/console/approvals', label: 'Approvals' },
  { href: '/', label: 'Service' },
];

const pounds = (pence: number) => (pence / 100).toFixed(2);

export function pricingPage(input: {
  readonly userEmail: string;
  readonly csrf: string;
  readonly versions: readonly PlanVersion[];
  readonly impacts: ReadonlyMap<string, PriceImpact>;
  readonly notice?: string;
  readonly error?: string;
}): string {
  const published = input.versions.filter((version) => version.state === 'published');
  const drafts = input.versions.filter((version) => version.state === 'draft');

  return page(
    { title: 'Pricing', site: 'console', nav: NAV('pricing'), user: input.userEmail },
    `<h1>Packages and pricing</h1>
<p class="sub">Edit what a new customer is offered. <strong>Changing a price here never changes
what an existing customer pays</strong>: every subscription is pinned to the version it was sold
on and the fee it was contracted at. A customer moves only by a deliberate plan change, or at
renewal with an agreed uplift.</p>

${input.error ? `<div class="banner bad">${escape(input.error)}</div>` : ''}
${input.notice ? `<div class="banner">${escape(input.notice)}</div>` : ''}

${drafts.length > 0 ? `<h2>Drafts awaiting publication</h2>
${drafts.map((draft) => draftCard(draft, input.impacts.get(`${draft.planCode}:${draft.version}`), input.csrf)).join('')}` : ''}

<h2>Live packages</h2>
${published.map((version) => planCard(version, input.csrf)).join('')}

`,
  );
}

function planCard(version: PlanVersion, csrf: string): string {
  const id = `${version.planCode}_${version.version}`;
  return `<div class="card">
  <div class="row" style="margin-bottom:14px">
    <div><h2 style="margin:0;text-transform:none;font-size:17px;letter-spacing:0;color:#0F1B2A">
      ${escape(version.name)}</h2>
      <span class="version">${escape(version.planCode)} &middot; version ${version.version}
      &middot; published ${escape((version.publishedAt ?? '').slice(0, 10))}</span></div>
    <div style="flex:0">${version.selfServiceAvailable
      ? pill('self-service', 'ok') : pill('sales only')}</div>
  </div>

  <form method="post" action="/console/pricing/draft">
    <input type="hidden" name="csrf" value="${escape(csrf)}">
    <input type="hidden" name="planCode" value="${escape(version.planCode)}">
    <div class="plan">
      <div><label for="fee_m_${id}">Monthly price (&pound;)</label>
        <input class="field" id="fee_m_${id}" name="platformFeeMonthly" type="number" step="0.01"
               value="${pounds(version.platformFee.monthly.amount)}"></div>
      <div><label for="fee_a_${id}">Annual price (&pound;)</label>
        <input class="field" id="fee_a_${id}" name="platformFeeAnnual" type="number" step="0.01"
               value="${pounds(version.platformFee.annual.amount)}"></div>

      <div><label for="act_${id}">One-off activation fee (&pound;)</label>
        <input class="field" id="act_${id}" name="activationFee" type="number" step="0.01" min="0"
               value="${pounds(version.activationFee.amount)}"></div>
      <div><label for="cred_${id}">Credits each period (&pound;)</label>
        <input class="field" id="cred_${id}" name="includedCredits" type="number" step="0.01" min="0"
               value="${pounds(version.includedCreditsPence)}"></div>

      <div><label for="basis_${id}">What the outcome fee charges for</label>
        <select class="field" id="basis_${id}" name="outcomeBasis">
          <option value="assistant_reply"${version.outcomeBasis === 'assistant_reply' ? ' selected' : ''}>
            Every reply the assistant gives</option>
          <option value="confirmed"${version.outcomeBasis !== 'assistant_reply' ? ' selected' : ''}>
            A confirmed outcome: a booked meeting or qualified handover</option>
        </select></div>
      <div><label for="out_${id}">${version.outcomeBasis === 'assistant_reply'
        ? 'Fee per reply (&pound;)' : 'Fee per confirmed outcome (&pound;)'}</label>
        <input class="field" id="out_${id}" name="outcomeFee" type="number" step="0.01" min="0"
               value="${pounds(version.outcomeFee.amount)}"></div>

      <div><label for="rcap_${id}">Chargeable replies per conversation</label>
        <input class="field" id="rcap_${id}" name="billableReplies" type="number" min="0"
               placeholder="blank = uncapped"
               value="${version.billableRepliesPerConversation ?? ''}"></div>
      <div><label>Worst case for one conversation</label>
        <p class="hint" style="margin:9px 0 0">${
          version.outcomeBasis !== 'assistant_reply'
            ? 'Not applicable on a confirmed-outcome plan.'
            : version.billableRepliesPerConversation === undefined
              ? 'Uncapped: there is no answer to give a buyer who asks.'
              : escape(format(money(
                  version.outcomeFee.amount * version.billableRepliesPerConversation,
                  version.currency,
                )))
        }</p></div>
      <div><label for="cap_${id}">Default spend cap (&pound;)</label>
        <input class="field" id="cap_${id}" name="spendCap" type="number" step="0.01" min="0"
               value="${pounds(version.defaultSpendCapPence)}"></div>

      <div><label for="conv_${id}">Per conversation (millis)</label>
        <input class="field" id="conv_${id}" name="conversationMillis" type="number" min="0"
               value="${version.usageRates.conversationMillis}"></div>
      <div><label for="voice_${id}">Per voice minute (millis)</label>
        <input class="field" id="voice_${id}" name="voiceMinuteMillis" type="number" min="0"
               value="${version.usageRates.voiceMinuteMillis}"></div>

      <div><label for="t1_${id}">Tier 1 connectors</label>
        <input class="field" id="t1_${id}" name="tier1" type="number" min="0"
               value="${version.connectorEntitlement.tier1}"></div>
      <div><label for="voiceconc_${id}">Concurrent voice</label>
        <input class="field" id="voiceconc_${id}" name="maxConcurrentVoice" type="number" min="0"
               value="${version.maxConcurrentVoice}"></div>

      <div class="full"><label for="self_${id}">Availability</label>
        <select class="field" id="self_${id}" name="selfServiceAvailable">
          <option value="true"${version.selfServiceAvailable ? ' selected' : ''}>
            Customers can buy this themselves</option>
          <option value="false"${version.selfServiceAvailable ? '' : ' selected'}>
            Sales only, not shown at sign-up</option>
        </select></div>

      <div class="full"><label for="note_${id}">Why are you changing this? (required)</label>
        <input class="field" id="note_${id}" name="changeNote" required
               placeholder="e.g. 2027 list price, agreed at the January pricing review"></div>
    </div>
    <div class="actions">
      <button class="btn primary" type="submit">Create a draft version</button>
    </div>
    <p class="sub" style="margin:10px 0 0;font-size:12.5px">
      This creates version ${version.version + 1} as a draft. Nothing changes until you publish it,
      and publishing affects new sales only.</p>
  </form>
</div>`;
}

/**
 * A draft, with what it would do.
 *
 * The impact is shown between the draft and the publish button, because a price
 * edit is a number in a form and its consequence is a percentage across a
 * cohort. Putting the consequence anywhere else means it is not read.
 */
function draftCard(draft: PlanVersion, impact: PriceImpact | undefined, csrf: string): string {
  const change = (label: string, amount: number, suffix = '') => {
    if (amount === 0) return '';
    const sign = amount > 0 ? '+' : '-';
    return `<li>${escape(label)}: <span class="${amount > 0 ? 'up' : 'down'}">${sign}£${
      pounds(Math.abs(amount))}${escape(suffix)}</span></li>`;
  };

  return `<div class="card" style="border-left:3px solid #EFA13C">
  <div class="row" style="margin-bottom:8px">
    <div><b>${escape(draft.name)}</b>
      <span class="version">version ${draft.version} &middot; draft by ${escape(draft.createdBy)}</span>
      <div class="sub" style="margin:4px 0 0">${escape(draft.changeNote)}</div></div>
    <div style="flex:0">${pill('draft', 'warn')}</div>
  </div>

  ${impact ? `<div class="impact">
    <b>What publishing this would do</b>
    <ul>
      ${change('Monthly price', impact.monthlyChange.amount,
        impact.monthlyChangeBasisPoints === 0 ? '' : ` (${(impact.monthlyChangeBasisPoints / 100).toFixed(1)}%)`)}
      ${change('Annual price', impact.annualChange.amount)}
      ${change('Activation fee', impact.activationFeeChange.amount)}
      ${change('Credits each period', impact.creditsChange)}
    </ul>
    ${impact.warnings.length > 0
      ? `<ul style="margin-top:9px">${impact.warnings.map((warning) =>
          `<li>${escape(warning)}</li>`).join('')}</ul>`
      : ''}
    <p style="margin:9px 0 0;color:#8A5A16">Applies to new sales only. No existing subscription
    changes price.</p>
  </div>` : ''}

  <div class="row">
    <form method="post" action="/console/pricing/publish" style="flex:0">
      <input type="hidden" name="csrf" value="${escape(csrf)}">
      <input type="hidden" name="planCode" value="${escape(draft.planCode)}">
      <input type="hidden" name="version" value="${draft.version}">
      <button class="btn primary" type="submit">Publish version ${draft.version}</button>
    </form>
    <form method="post" action="/console/pricing/discard" style="flex:0">
      <input type="hidden" name="csrf" value="${escape(csrf)}">
      <input type="hidden" name="planCode" value="${escape(draft.planCode)}">
      <input type="hidden" name="version" value="${draft.version}">
      <button class="btn" type="submit">Discard</button>
    </form>
    <div style="text-align:right;color:#5B6B7F;font-size:12.5px">
      ${escape(format(draft.platformFee.monthly))} per month &middot;
      ${escape(format(draft.activationFee))} activation &middot;
      ${escape(format({ amount: draft.includedCreditsPence, currency: draft.currency }))} credits
    </div>
  </div>
</div>`;
}

export { NAV as pricingNav };
