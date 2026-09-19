import { containsPii, type TenantConfig } from '@detent/awa-core';

/**
 * Output validation (pipeline step 9, boundary B2).
 *
 * Everything the model produces is untrusted until validated. Three classes of
 * failure are caught here rather than left to the visitor to notice: an
 * outbound resource reference that is not on the tenant allowlist (the markdown
 * image beacon exfiltration path, table 17), a claim to be human, and a figure
 * the tenant has not approved.
 */
export type OutputViolation =
  | 'claims_to_be_human'
  | 'unapproved_outbound_reference'
  | 'unapproved_figure'
  | 'manufactured_urgency'
  | 'sensitive_attribute_inference'
  | 'regulated_advice'
  | 'crm_disclosure';

export interface OutputVerdict {
  readonly allowed: boolean;
  readonly violations: readonly OutputViolation[];
  /** Text with unapproved references neutralised. Empty when blocked outright. */
  readonly text: string;
  readonly notes: readonly string[];
}

const HUMAN_CLAIMS: readonly RegExp[] = [
  /\bi(?:'| a)m (?:a )?(?:real )?(?:human|person|not a bot|not an ai)\b/i,
  /\byes,? i(?:'| a)m (?:a )?(?:real )?(?:human|person)\b/i,
  /\bi am not an? (?:ai|bot|robot|machine)\b/i,
  /\bspeaking to a (?:real )?(?:human|person) (?:here|now)\b/i,
];

const URGENCY_CLAIMS: readonly RegExp[] = [
  /\bonly \d+ (?:spots?|slots?|places?|seats?) (?:left|remaining)\b/i,
  /\b(?:offer|price|discount) (?:ends|expires) (?:today|tonight|in \d+)/i,
  /\bact (?:now|fast|today) (?:or|before)\b/i,
  /\blast chance\b/i,
  /\bprices? (?:are )?going up\b/i,
];

const SENSITIVE_ATTRIBUTES: readonly RegExp[] = [
  /\b(?:your|their) (?:religion|ethnicity|race|sexual orientation|political views?|health condition|disability|trade union)\b/i,
  /\bbecause you(?:'re| are) (?:a )?(?:christian|muslim|jewish|hindu|sikh|gay|lesbian|disabled|pregnant)\b/i,
];

const REGULATED_ADVICE: readonly RegExp[] = [
  /\byou should (?:sue|litigate|claim against|dispute)\b/i,
  /\b(?:my|our) legal advice is\b/i,
  /\bfor tax purposes,? you should\b/i,
  /\byou are legally (?:entitled|obliged|required) to\b/i,
];

/** Phrasings that would disclose the existence or content of a CRM record. */
const CRM_DISCLOSURE: readonly RegExp[] = [
  /\byour (?:open )?(?:deal|opportunity) (?:is|sits) (?:at|in)\b/i,
  /\bi can see (?:you have|your) (?:an? )?(?:open )?(?:deal|opportunity|account|record|contract)\b/i,
  /\byou(?:'re| are) (?:currently )?(?:at|in) the \w+ stage\b/i,
  /\byour account (?:manager|owner) is [A-Z][a-z]+/,
  /\bin our (?:crm|system) (?:you|your record)\b/i,
];

export interface OutputValidationInput {
  readonly text: string;
  readonly config: TenantConfig;
  readonly approvedFigures: ReadonlySet<number>;
  /** Figures present in the retrieved material, which are approved by definition. */
  readonly retrievedText?: string;
}

export function validateOutput(input: OutputValidationInput): OutputVerdict {
  const violations: OutputViolation[] = [];
  const notes: string[] = [];
  let text = input.text;

  if (HUMAN_CLAIMS.some((pattern) => pattern.test(text))) violations.push('claims_to_be_human');
  if (URGENCY_CLAIMS.some((pattern) => pattern.test(text))) violations.push('manufactured_urgency');
  if (SENSITIVE_ATTRIBUTES.some((pattern) => pattern.test(text))) violations.push('sensitive_attribute_inference');
  if (REGULATED_ADVICE.some((pattern) => pattern.test(text))) violations.push('regulated_advice');
  if (CRM_DISCLOSURE.some((pattern) => pattern.test(text))) violations.push('crm_disclosure');

  // Outbound references. A markdown image pointing at an attacker host is an
  // exfiltration channel: the request itself carries the data in the URL.
  const references = [
    ...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g),
    ...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g),
    ...text.matchAll(/<img[^>]+src=["']([^"']+)["']/gi),
    ...text.matchAll(/(https?:\/\/[^\s<>")]+)/g),
  ].map((match) => match[1]).filter((value): value is string => Boolean(value));

  const allowlist = new Set(input.config.outboundAllowlist.map((host) => host.toLowerCase()));
  for (const reference of references) {
    const host = hostOf(reference);
    if (!host || !isAllowed(host, allowlist)) {
      violations.push('unapproved_outbound_reference');
      notes.push(`reference to ${host ?? 'unparseable target'} is not on the tenant allowlist`);
      text = text.split(reference).join('[link removed]');
    }
  }

  // Figures. A price the tenant has not published is the highest-cost
  // hallucination in a sales context.
  const corpus = (input.retrievedText ?? '').toLowerCase();
  for (const match of text.matchAll(/[£$€]\s?(\d[\d,]*(?:\.\d+)?)/g)) {
    const raw = match[1];
    if (!raw) continue;
    const numeric = Number(raw.replace(/,/g, ''));
    if (input.approvedFigures.has(numeric)) continue;
    if (corpus.includes(raw.toLowerCase())) continue;
    violations.push('unapproved_figure');
    notes.push(`figure ${match[0]} is not on the approved price list or in the retrieved material`);
  }

  const blocking = violations.some((violation) => violation !== 'unapproved_outbound_reference');
  return {
    allowed: !blocking,
    violations: [...new Set(violations)],
    text: blocking ? '' : text,
    notes,
  };
}

/** Safe replacement when output is blocked. Honest, and always offers a human. */
export const BLOCKED_OUTPUT_REPLACEMENT =
  'Let me get that confirmed properly rather than risk telling you something wrong. I can put you through to someone on the team — shall I do that?';

function hostOf(reference: string): string | undefined {
  try {
    if (reference.startsWith('/') || reference.startsWith('#')) return 'self';
    return new URL(reference).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isAllowed(host: string, allowlist: ReadonlySet<string>): boolean {
  if (host === 'self') return true;
  if (allowlist.has(host)) return true;
  // A single leading dot in the allowlist means "and its subdomains".
  for (const allowed of allowlist) {
    if (allowed.startsWith('.') && (host === allowed.slice(1) || host.endsWith(allowed))) return true;
  }
  return false;
}

/** Guard applied before anything is written to a log or a transcript store. */
export function assertNoPiiInLog(value: string): void {
  if (containsPii(value)) {
    throw new Error('attempted to log text containing personal data; redact before logging');
  }
}
