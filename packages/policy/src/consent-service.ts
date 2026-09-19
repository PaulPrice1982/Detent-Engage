import {
  newId,
  type Clock,
  type ConsentChoice,
  type ConsentEvent,
  type ConsentPurpose,
  type Jurisdiction,
  type LawfulBasis,
  systemClock,
} from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';

export interface ConsentStore {
  put(event: ConsentEvent): Promise<void>;
  latest(tenantId: string, subjectRef: string, purpose: ConsentPurpose): Promise<ConsentEvent | undefined>;
  allForSubject(tenantId: string, subjectRef: string): Promise<ConsentEvent[]>;
}

export class InMemoryConsentStore implements ConsentStore {
  private readonly events: ConsentEvent[] = [];

  async put(event: ConsentEvent): Promise<void> {
    // Immutable: an existing event is never amended, a superseding one is added.
    this.events.push(event);
  }

  async latest(tenantId: string, subjectRef: string, purpose: ConsentPurpose): Promise<ConsentEvent | undefined> {
    const matches = this.events.filter(
      (e) => e.tenantId === tenantId && e.subjectRef === subjectRef && e.purpose === purpose,
    );
    return matches[matches.length - 1];
  }

  async allForSubject(tenantId: string, subjectRef: string): Promise<ConsentEvent[]> {
    return this.events.filter((e) => e.tenantId === tenantId && e.subjectRef === subjectRef);
  }
}

export interface RecordConsentInput {
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly purpose: ConsentPurpose;
  readonly choice: ConsentChoice;
  readonly wordingShown: string;
  readonly source: ConsentEvent['source'];
  readonly jurisdiction: Jurisdiction;
  readonly correlationId: string;
  readonly lawfulBasis?: LawfulBasis;
}

/**
 * The consent service is the only writer of consent evidence, and the only
 * reader the policy engine trusts. Nothing else in the platform is permitted to
 * infer consent from a session flag, a cookie or a model's belief about what
 * the visitor said.
 */
export class ConsentService {
  /**
   * The audit log is optional at construction only so that the consent store
   * can be unit-tested in isolation. In the platform it is always supplied:
   * the compliance scorecard derives every consent figure from the hash chain
   * rather than from a counter, so a consent event that is stored but not
   * audited is invisible to the evidence a DPO asks for.
   */
  constructor(
    private readonly store: ConsentStore,
    private readonly clock: Clock = systemClock,
    private readonly audit?: AuditLog,
  ) {}

  async record(input: RecordConsentInput): Promise<ConsentEvent> {
    const event: ConsentEvent = {
      id: newId('ce', this.clock.nowMs()),
      tenantId: input.tenantId,
      subjectRef: input.subjectRef,
      purpose: input.purpose,
      lawfulBasis: input.lawfulBasis ?? 'CONSENT',
      wordingShown: input.wordingShown,
      choice: input.choice,
      timestamp: this.clock.iso(),
      source: input.source,
      jurisdiction: input.jurisdiction,
      correlationId: input.correlationId,
    };
    await this.store.put(event);

    await this.audit?.write({
      tenantId: event.tenantId,
      type: event.choice === 'WITHDRAWN' ? 'consent_withdrawn' : 'consent_recorded',
      correlationId: event.correlationId,
      actor: input.source === 'HOST_CMP' ? 'system' : 'visitor',
      subjectRef: event.subjectRef,
      consentEventId: event.id,
      payload: {
        purpose: event.purpose,
        choice: event.choice,
        jurisdiction: event.jurisdiction,
        lawfulBasis: event.lawfulBasis,
        source: event.source,
        // The wording is the evidence. It is stored verbatim on the event and
        // recorded here so the audit export alone answers "what were they shown".
        wordingShown: event.wordingShown,
      },
    });

    return event;
  }

  async get(tenantId: string, subjectRef: string, purpose: ConsentPurpose): Promise<ConsentEvent | undefined> {
    return this.store.latest(tenantId, subjectRef, purpose);
  }

  /** True only on a stored, affirmative, un-withdrawn event. Absence is refusal. */
  async isGranted(tenantId: string, subjectRef: string, purpose: ConsentPurpose): Promise<boolean> {
    const latest = await this.store.latest(tenantId, subjectRef, purpose);
    return latest?.choice === 'GRANTED';
  }

  /**
   * A refusal is stored and honoured for the session, and the visitor is not
   * asked again (section 20.1). This is the check the widget uses before it
   * offers a prompt at all.
   */
  async hasAnswered(tenantId: string, subjectRef: string, purpose: ConsentPurpose): Promise<boolean> {
    return (await this.store.latest(tenantId, subjectRef, purpose)) !== undefined;
  }

  async withdraw(input: Omit<RecordConsentInput, 'choice'>): Promise<ConsentEvent> {
    return this.record({ ...input, choice: 'WITHDRAWN' });
  }

  /** Evidence bundle for a data subject request or a tenant audit export. */
  async evidenceFor(tenantId: string, subjectRef: string): Promise<ConsentEvent[]> {
    return this.store.allForSubject(tenantId, subjectRef);
  }
}
