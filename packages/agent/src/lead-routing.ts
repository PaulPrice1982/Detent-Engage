import type { QualificationVerdict } from './playbook.js';

/**
 * How a lead reaches the CRM: what kind it is, where it came from, and how
 * warm it is.
 *
 * These three fields exist because a CRM cannot route on a transcript. A
 * salesperson opening a record needs to know in one glance whether this is new
 * business or an existing customer with a problem, which campaign paid for it,
 * and whether it is worth ringing today. Without them every conversation lands
 * in one undifferentiated queue and the good ones go cold in it.
 */

export type LeadType =
  /** Someone who might buy. The default, and the only one sales should work. */
  | 'new_business'
  /** An existing customer. Routes to their account owner, not to sales. */
  | 'existing_customer'
  /** A reseller or referrer. Routes to channel. */
  | 'partner'
  /** Wants help with something they already bought. Routes to support. */
  | 'support'
  /** Looking for a job. Routes nowhere near a salesperson. */
  | 'recruitment'
  /** Selling something to us. Routes to nobody, politely. */
  | 'vendor'
  /** Genuinely unclear. Better than guessing wrong. */
  | 'unknown';

export type LeadSourceChannel =
  | 'organic_search'
  | 'paid_search'
  | 'paid_social'
  | 'organic_social'
  | 'referral'
  | 'email'
  | 'direct'
  | 'unknown';

/**
 * How far along the lead is.
 *
 * The MQL/SQL line is drawn on intent, not on engagement. A visitor who reads
 * three pages and answers every question is interested; a visitor who asks
 * what it costs, gives a timeframe, or agrees to a call is buying. Marketing
 * teams that promote on engagement alone hand sales a queue of people who were
 * never going to buy, and sales stops trusting the queue, which costs more
 * than the leads are worth.
 */
export type LeadStage =
  /** Talked to the assistant. Not yet qualified on fit. */
  | 'enquiry'
  /** Fits, and engaged. Marketing may nurture; sales should not chase yet. */
  | 'MQL'
  /** Fits, and has shown intent to buy. Worth a call today. */
  | 'SQL';

export interface LeadSource {
  readonly channel: LeadSourceChannel;
  /** The referring host, where there was one. */
  readonly referrerHost?: string;
  /** Campaign attribution, as it arrived. Never invented. */
  readonly campaign?: string;
  readonly medium?: string;
  readonly term?: string;
  /** The page the conversation started on, often the best signal of all. */
  readonly landingPath?: string;
}

/** Signals that separate interest from intent. */
export interface IntentSignals {
  /** Asked what it costs, in any form. */
  readonly askedAboutPrice: boolean;
  /** Asked to see it, or asked for a call. */
  readonly askedForDemoOrCall: boolean;
  /** Gave a timeframe for deciding. */
  readonly gaveTimeframe: boolean;
  /** A meeting was actually booked. */
  readonly meetingBooked: boolean;
  /** Asked to speak to a person. */
  readonly askedForHuman: boolean;
}

export const NO_INTENT: IntentSignals = {
  askedAboutPrice: false,
  askedForDemoOrCall: false,
  gaveTimeframe: false,
  meetingBooked: false,
  askedForHuman: false,
};

export interface LeadRouting {
  readonly leadType: LeadType;
  readonly source: LeadSource;
  readonly stage: LeadStage;
  /** Why this stage, in words a salesperson can read on the record. */
  readonly reason: string;
  /** True when a person should be told now rather than at the next sweep. */
  readonly notifyNow: boolean;
}

/**
 * Where the visitor came from.
 *
 * UTM parameters win over the referrer, because a referrer is what the browser
 * happened to send and a UTM is what the marketer deliberately tagged. Nothing
 * is inferred beyond what arrived: an untagged visit from an unknown host is
 * 'referral', not a guess at which campaign it probably was.
 */
export function classifySource(input: {
  readonly referrer?: string;
  readonly utmSource?: string;
  readonly utmMedium?: string;
  readonly utmCampaign?: string;
  readonly utmTerm?: string;
  readonly landingPath?: string;
  /** The site's own hostname, so a self-referral reads as direct. */
  readonly ownHost?: string;
}): LeadSource {
  const medium = input.utmMedium?.trim().toLowerCase();
  const referrerHost = hostOf(input.referrer);
  // Normalised the same way the referrer is, or our own site reads as a
  // referral from ourselves and every internal page view is attributed to a
  // channel it did not come from.
  const own = normaliseHost(input.ownHost);

  const base = {
    referrerHost: referrerHost && referrerHost !== own ? referrerHost : undefined,
    campaign: input.utmCampaign?.trim() || undefined,
    medium: input.utmMedium?.trim() || undefined,
    term: input.utmTerm?.trim() || undefined,
    landingPath: input.landingPath,
  };

  if (medium) {
    if (medium === 'cpc' || medium === 'ppc' || medium === 'paid') {
      const source = input.utmSource?.trim().toLowerCase() ?? '';
      return { ...base, channel: SOCIAL_HOSTS.has(source) ? 'paid_social' : 'paid_search' };
    }
    if (medium === 'email' || medium === 'newsletter') return { ...base, channel: 'email' };
    if (medium === 'social') return { ...base, channel: 'organic_social' };
    if (medium === 'referral') return { ...base, channel: 'referral' };
  }

  if (!referrerHost || referrerHost === own) return { ...base, channel: 'direct' };
  if (matchesAny(referrerHost, SEARCH_HOSTS)) return { ...base, channel: 'organic_search' };
  if (matchesAny(referrerHost, SOCIAL_HOSTS)) return { ...base, channel: 'organic_social' };
  return { ...base, channel: 'referral' };
}

const SEARCH_HOSTS = new Set([
  'google', 'bing', 'duckduckgo', 'yahoo', 'ecosia', 'brave', 'baidu', 'yandex',
]);
const SOCIAL_HOSTS = new Set([
  'linkedin', 'facebook', 'instagram', 'x', 'twitter', 'youtube', 'tiktok', 'reddit',
]);

function hostOf(referrer: string | undefined): string | undefined {
  if (!referrer) return undefined;
  try {
    return normaliseHost(new URL(referrer).hostname);
  } catch {
    return undefined;
  }
}

function normaliseHost(host: string | undefined): string | undefined {
  const value = host?.trim().toLowerCase().replace(/^www\./, '');
  return value || undefined;
}

/**
 * Does any label of the hostname name a known search engine or network?
 *
 * Taking the second-to-last label instead would read 'google.co.uk' as 'co',
 * and a country domain is exactly where a UK business's search traffic comes
 * from. Matching any label also catches 'uk.linkedin.com', where the brand is
 * neither first nor second to last. It is a classification, not a security
 * check, so a label match is the right amount of precision, and doing it
 * properly would mean shipping a public-suffix list to decide a chart label.
 */
function matchesAny(host: string, names: ReadonlySet<string>): boolean {
  return host.split('.').some((label) => names.has(label));
}

/**
 * Decides the stage.
 *
 * Order matters. Intent is checked before fit, because a visitor who asks for
 * a call has told us more than any score can, and holding them as an MQL
 * because a box is unticked is how a buyer is kept waiting behind a nurture
 * sequence.
 */
export function routeLead(input: {
  readonly leadType: LeadType;
  readonly source: LeadSource;
  readonly qualification: QualificationVerdict;
  readonly intent: IntentSignals;
}): LeadRouting {
  const { intent, qualification } = input;

  // Anything that is not new business is routed by type, not by score. A
  // customer with a problem is not a lead, and scoring them as one puts them
  // in a sales queue while their problem goes unanswered.
  if (input.leadType !== 'new_business' && input.leadType !== 'unknown') {
    return {
      leadType: input.leadType,
      source: input.source,
      stage: 'enquiry',
      reason: `Routed as ${input.leadType.replace(/_/g, ' ')} rather than scored as a lead.`,
      notifyNow: input.leadType === 'support' || input.leadType === 'existing_customer',
    };
  }

  const intentReasons: string[] = [];
  if (intent.meetingBooked) intentReasons.push('booked a meeting');
  if (intent.askedForDemoOrCall) intentReasons.push('asked to see it or to speak to someone');
  if (intent.askedAboutPrice) intentReasons.push('asked what it costs');
  if (intent.gaveTimeframe) intentReasons.push('gave a timeframe');
  if (intent.askedForHuman) intentReasons.push('asked for a person');

  if (intentReasons.length > 0) {
    return {
      leadType: input.leadType,
      source: input.source,
      stage: 'SQL',
      reason: `Buying intent: ${intentReasons.join('; ')}.`,
      // A booked meeting is already in a diary; the rest want telling now.
      notifyNow: !intent.meetingBooked,
    };
  }

  if (qualification.state === 'QUALIFIED') {
    return {
      leadType: input.leadType,
      source: input.source,
      stage: 'MQL',
      reason:
        `Fits on ${qualification.score} of ${qualification.maxScore} points, but has not `
        + 'asked about price, a call or a timeframe. Nurture rather than chase.',
      notifyNow: false,
    };
  }

  return {
    leadType: input.leadType,
    source: input.source,
    stage: 'enquiry',
    reason: qualification.missingRequired.length > 0
      ? `Not yet qualified: ${qualification.missingRequired.join(', ')} unknown.`
      : 'Talked to the assistant but has not qualified on fit.',
    notifyNow: false,
  };
}

/**
 * Guesses the lead type from what the visitor said.
 *
 * Deliberately conservative: an unrecognised conversation is 'unknown', which
 * is worked as new business, rather than being confidently filed as
 * recruitment and never seen by sales again. The cost of the two mistakes is
 * not symmetrical.
 */
export function classifyLeadType(text: string): LeadType {
  const said = text.toLowerCase();
  const has = (...phrases: string[]) => phrases.some((phrase) => said.includes(phrase));

  if (has('job', 'vacancy', 'hiring', 'apply for a role', 'my cv', 'my resume', 'careers')) {
    return 'recruitment';
  }
  if (has('reseller', 'partnership', 'refer clients', 'white label', 'channel partner')) {
    return 'partner';
  }
  if (has('our agency', 'we offer seo', 'we can help you rank', 'sponsored post',
    'guest post', 'backlink', 'we provide developers')) {
    return 'vendor';
  }
  // Checked before 'existing customer', because someone who cannot log in to
  // their account says both, and what they need is support rather than an
  // account manager returning their call on Thursday.
  if (has('not working', 'broken', 'bug', 'error message', 'cannot log in',
    'can not log in', "can't log in", 'reset my password', 'outage')) {
    return 'support';
  }
  if (has('existing customer', 'our account', 'my account', 'already a customer',
    'we already use', 'our subscription', 'our invoice', 'renewal')) {
    return 'existing_customer';
  }
  return 'unknown';
}
