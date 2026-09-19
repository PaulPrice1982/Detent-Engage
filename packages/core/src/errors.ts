/**
 * Error taxonomy. Every failure the platform can produce is one of these, and
 * each carries whether it is safe to retry and what the visitor may be told.
 * "Degrade, never fail" (section 8.1) is only implementable if the caller can
 * tell a transient CRM outage from a policy refusal.
 */
export type ErrorKind =
  | 'POLICY_DENIED'
  | 'CONSENT_REQUIRED'
  | 'SCHEMA_INVALID'
  | 'TENANT_NOT_FOUND'
  | 'TENANT_NOT_LIVE'
  | 'CONNECTION_DEGRADED'
  | 'CAPABILITY_UNSUPPORTED'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_REJECTED'
  | 'QUOTA_EXCEEDED'
  | 'SPEND_CAP_REACHED'
  | 'KILL_SWITCH_ACTIVE'
  | 'AMBIGUOUS_MATCH'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL';

const RETRYABLE: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'INTERNAL',
]);

export interface AwaErrorOptions {
  readonly kind: ErrorKind;
  readonly message: string;
  /** Wording that may be shown to a website visitor. Never contains internals. */
  readonly visitorMessage?: string;
  readonly correlationId?: string;
  readonly tenantId?: string;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
  /** Seconds to wait before retrying, honoured from a provider Retry-After. */
  readonly retryAfterSeconds?: number;
}

export class AwaError extends Error {
  readonly kind: ErrorKind;
  readonly visitorMessage: string;
  readonly correlationId: string | undefined;
  readonly tenantId: string | undefined;
  readonly details: Record<string, unknown>;
  readonly retryAfterSeconds: number | undefined;

  constructor(options: AwaErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AwaError';
    this.kind = options.kind;
    this.visitorMessage = options.visitorMessage ?? defaultVisitorMessage(options.kind);
    this.correlationId = options.correlationId;
    this.tenantId = options.tenantId;
    this.details = options.details ?? {};
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }

  toJSON(): Record<string, unknown> {
    return {
      kind: this.kind,
      message: this.message,
      correlationId: this.correlationId,
      details: this.details,
      retryable: this.retryable,
    };
  }
}

function defaultVisitorMessage(kind: ErrorKind): string {
  switch (kind) {
    case 'CONSENT_REQUIRED':
      return 'I can only do that once you have agreed to it. Would you like to?';
    case 'POLICY_DENIED':
      return 'That is not something I am able to do. I can put you through to a colleague who can.';
    case 'AMBIGUOUS_MATCH':
      return 'I want to make sure I get this to the right person. Let me pass you to a colleague.';
    case 'QUOTA_EXCEEDED':
    case 'SPEND_CAP_REACHED':
    case 'KILL_SWITCH_ACTIVE':
      return 'I am not able to continue here right now. You can book a time with the team instead.';
    case 'CONNECTION_DEGRADED':
    case 'UPSTREAM_UNAVAILABLE':
    case 'RATE_LIMITED':
      return 'I have your details and the team will pick this up. Nothing is lost.';
    default:
      return 'Something went wrong at my end. Let me get a colleague to help.';
  }
}

export function isAwaError(value: unknown): value is AwaError {
  return value instanceof AwaError;
}

export function policyDenied(message: string, details?: Record<string, unknown>): AwaError {
  return new AwaError({ kind: 'POLICY_DENIED', message, details });
}
