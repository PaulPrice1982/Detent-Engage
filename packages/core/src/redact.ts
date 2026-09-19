/**
 * PII redaction applied before anything is logged (pipeline step 9, section 13.1).
 *
 * The rule this implements is narrow and absolute: operational logs are
 * classified "Internal, PII redacted" in section 21.4, so a transcript fragment
 * that reaches a log line must have had personal data removed first. Redaction
 * is lossy on purpose — it preserves the shape of a value for debugging without
 * preserving the value.
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// E.164 and common national forms. Deliberately greedy: over-redaction in a log
// is a cosmetic problem, under-redaction is a reportable one.
const PHONE_RE = /(?<![\w.])(\+?\d[\d\s().-]{7,}\d)(?![\w.])/g;
const CARD_RE = /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g;
// Deliberately broader than the valid NINO prefix set. A string shaped like a
// National Insurance number is redacted whether or not it could be issued:
// over-redaction in a log is cosmetic, under-redaction is reportable.
const UK_NI_RE = /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi;
const UK_POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

export interface RedactionSummary {
  readonly text: string;
  readonly counts: Readonly<Record<string, number>>;
}

export function redactText(input: string): RedactionSummary {
  const counts: Record<string, number> = {};
  const tally = (kind: string) => { counts[kind] = (counts[kind] ?? 0) + 1; };

  let text = input;
  // Card numbers first: a 16-digit run would otherwise be eaten by PHONE_RE.
  text = text.replace(CARD_RE, (m) => (m.replace(/\D/g, '').length >= 13 ? (tally('card'), '[redacted:card]') : m));
  text = text.replace(EMAIL_RE, () => (tally('email'), '[redacted:email]'));
  text = text.replace(UK_NI_RE, () => (tally('national_insurance'), '[redacted:nino]'));
  text = text.replace(IPV4_RE, () => (tally('ip'), '[redacted:ip]'));
  text = text.replace(PHONE_RE, () => (tally('phone'), '[redacted:phone]'));
  text = text.replace(UK_POSTCODE_RE, () => (tally('postcode'), '[redacted:postcode]'));
  return { text, counts };
}

/** Keys whose values are never logged, whatever they contain. */
const SENSITIVE_KEYS = new Set([
  'access_token', 'accesstoken', 'refresh_token', 'refreshtoken', 'authorization',
  'password', 'secret', 'client_secret', 'clientsecret', 'api_key', 'apikey',
  'private_key', 'privatekey', 'credential', 'cookie', 'set-cookie', 'bearer',
  'work_email', 'email', 'phone', 'phone_e164', 'full_name',
]);

/**
 * Deep-redact a structure for logging. Credentials are dropped outright
 * (section 24.2: credentials never enter logs); free text is pattern-redacted.
 */
export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[redacted:depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value).text;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase())
        ? '[redacted]'
        : redactObject(child, depth + 1);
    }
    return out;
  }
  return '[redacted:unknown]';
}

/** True when a string still contains something that looks like personal data. */
export function containsPii(text: string): boolean {
  return [EMAIL_RE, PHONE_RE, CARD_RE, UK_NI_RE].some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}
