import { AwaError, newId, systemClock, type Clock } from '@detent/awa-core';

/**
 * Support requests raised from the customer's account.
 *
 * Raised when the assistant has no answer, or when the customer wants a person
 * regardless. The conversation that led here is attached, because a request
 * that says only "it does not work" costs two more exchanges to become useful.
 */

export type RequestState = 'open' | 'answered' | 'closed';

export interface SupportRequest {
  readonly requestId: string;
  readonly tenantId: string;
  readonly accountId: string;
  /** Who raised it, so the reply goes to a person rather than an address. */
  readonly raisedBy: string;
  readonly subject: string;
  readonly detail: string;
  /** What the customer asked the assistant first, when they did. */
  readonly askedFirst?: string;
  readonly state: RequestState;
  readonly createdAt: string;
  readonly answeredAt?: string;
  readonly answer?: string;
}

export interface RaiseRequestInput {
  readonly tenantId: string;
  readonly accountId: string;
  readonly raisedBy: string;
  readonly subject: string;
  readonly detail: string;
  readonly askedFirst?: string;
}

const MAX_DETAIL = 8000;

/**
 * Where support requests are kept.
 *
 * A request carries what a customer was doing when something went wrong, which
 * is as sensitive as anything else in their account, and losing it loses a
 * promise that somebody would reply.
 */
export interface SupportRequestStore {
  put(request: SupportRequest): Promise<void>;
  get(requestId: string): Promise<SupportRequest | undefined>;
  forAccount(accountId: string): Promise<readonly SupportRequest[]>;
  open(): Promise<readonly SupportRequest[]>;
}

export class InMemorySupportRequestStore implements SupportRequestStore {
  private readonly requests = new Map<string, SupportRequest>();
  async put(request: SupportRequest): Promise<void> {
    this.requests.set(request.requestId, request);
  }
  async get(requestId: string): Promise<SupportRequest | undefined> {
    return this.requests.get(requestId);
  }
  async forAccount(accountId: string): Promise<readonly SupportRequest[]> {
    return [...this.requests.values()]
      .filter((request) => request.accountId === accountId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
  async open(): Promise<readonly SupportRequest[]> {
    return [...this.requests.values()]
      .filter((request) => request.state === 'open')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}

export class SupportRequestService {
  constructor(
    private readonly store: SupportRequestStore = new InMemorySupportRequestStore(),
    private readonly clock: Clock = systemClock,
  ) {}

  async raise(input: RaiseRequestInput): Promise<SupportRequest> {
    const subject = input.subject.trim();
    if (subject.length === 0) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'Give the request a subject.' });
    }
    const detail = input.detail.trim();
    if (detail.length === 0) {
      throw new AwaError({
        kind: 'SCHEMA_INVALID',
        message: 'Say what happened. A request with no detail cannot be answered.',
      });
    }
    if (detail.length > MAX_DETAIL) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'That detail is too long.' });
    }

    const request: SupportRequest = {
      requestId: newId('req', this.clock.nowMs()),
      tenantId: input.tenantId,
      accountId: input.accountId,
      raisedBy: input.raisedBy,
      subject,
      detail,
      askedFirst: input.askedFirst?.trim() || undefined,
      state: 'open',
      createdAt: new Date(this.clock.nowMs()).toISOString(),
    };
    await this.store.put(request);
    return request;
  }

  /**
   * One account's requests, newest first.
   *
   * Scoped by account, not filtered by it after the fact. A support request
   * carries what a customer was doing when something went wrong, which is as
   * sensitive as anything else in their account.
   */
  async forAccount(accountId: string): Promise<readonly SupportRequest[]> {
    return this.store.forAccount(accountId);
  }

  /** Every open request, for the operator back office. */
  async open(): Promise<readonly SupportRequest[]> {
    return this.store.open();
  }

  async get(requestId: string, accountId: string): Promise<SupportRequest> {
    const request = await this.store.get(requestId);
    // An unknown request and another account's request give the same answer.
    // Distinguishing them tells a caller which ids exist.
    if (!request || request.accountId !== accountId) {
      throw new AwaError({ kind: 'NOT_FOUND', message: 'No such request.' });
    }
    return request;
  }

  async answer(requestId: string, answer: string): Promise<SupportRequest> {
    const request = await this.store.get(requestId);
    if (!request) throw new AwaError({ kind: 'NOT_FOUND', message: 'No such request.' });
    const updated: SupportRequest = {
      ...request,
      state: 'answered',
      answer: answer.trim(),
      answeredAt: new Date(this.clock.nowMs()).toISOString(),
    };
    await this.store.put(updated);
    return updated;
  }
}
