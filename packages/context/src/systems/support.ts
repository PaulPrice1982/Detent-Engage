import type { Credential, HttpClient } from '@detent/awa-connectors';
import { classifyResponse } from '@detent/awa-connectors';
import type { Sentiment, SupportConnector, SupportFacts, SystemCapabilityDeclaration, SystemLookup } from '../contract.js';

/**
 * Zendesk (read-only by default).
 *
 * Answers the question that decides whether the conversation should be a sales
 * conversation at all: **is now a terrible moment to sell to this person?**
 *
 * The single easiest capability to demonstrate in a sales meeting, and the one
 * no competitor can show at any price, because none of them reads a support
 * system.
 */
export class ZendeskSupportConnector implements SupportConnector {
  readonly name = 'zendesk';
  readonly category = 'support' as const;

  constructor(
    private readonly http: HttpClient,
    private readonly subdomain: string,
    /** Ticket creation is one of the three permitted writes, off unless enabled. */
    private readonly ticketCreationEnabled = false,
  ) {}

  capabilities(): SystemCapabilityDeclaration {
    return {
      system: this.name,
      category: this.category,
      readOnly: true,
      optionalWrites: this.ticketCreationEnabled ? ['create_support_ticket'] : [],
      rateLimit: { requestsPerSecond: 10 },
      degradationNotes: [
        'Sentiment is derived from ticket satisfaction ratings and escalation counts, not from message text analysis.',
        'Requires a read-only API token scoped to tickets and users.',
      ],
    };
  }

  private async get(credential: Credential, path: string): Promise<unknown> {
    const response = await this.http.send({
      method: 'GET',
      url: `https://${this.subdomain}.zendesk.com/api/v2${path}`,
      headers: { authorization: `Bearer ${credential.accessToken}` },
    });
    const error = classifyResponse(this.name, response, path);
    if (error) throw error;
    return response.body;
  }

  async readSupport(credential: Credential, lookup: SystemLookup): Promise<SupportFacts | undefined> {
    const query = `type:ticket status<solved requester:${lookup.email}`;
    const body = await this.get(credential, `/search.json?query=${encodeURIComponent(query)}`);
    const tickets = ((body as { results?: ZendeskTicket[] }).results ?? []);

    if (tickets.length === 0) {
      return { openTicketCount: 0, sentiment: 'UNKNOWN', recentEscalations: 0 };
    }

    const severities = tickets
      .map((ticket) => PRIORITY_TO_SEVERITY[ticket.priority ?? ''] ?? 4)
      .sort((a, b) => a - b);

    const escalations = tickets.filter((ticket) => ticket.status === 'hold' || (ticket.tags ?? []).includes('escalated')).length;
    const ratings = tickets.map((ticket) => ticket.satisfaction_rating?.score).filter(Boolean);

    const sentiment: Sentiment =
      ratings.includes('bad') ? 'NEGATIVE'
      : escalations > 0 ? 'NEGATIVE'
      : ratings.includes('good') ? 'POSITIVE'
      : 'NEUTRAL';

    return {
      openTicketCount: tickets.length,
      highestSeverity: severities[0] as 1 | 2 | 3 | 4,
      sentiment,
      recentEscalations: escalations,
      lastContactAt: tickets.map((ticket) => ticket.updated_at).filter(Boolean).sort().reverse()[0],
    };
  }

  async createTicket(credential: Credential, input: { subject: string; body: string; email: string }): Promise<{ id: string }> {
    if (!this.ticketCreationEnabled) {
      throw new Error('zendesk ticket creation is not enabled for this tenant');
    }
    const response = await this.http.send({
      method: 'POST',
      url: `https://${this.subdomain}.zendesk.com/api/v2/tickets.json`,
      headers: { authorization: `Bearer ${credential.accessToken}` },
      body: {
        ticket: {
          subject: input.subject,
          comment: { body: input.body },
          requester: { email: input.email },
        },
      },
    });
    const error = classifyResponse(this.name, response, 'tickets');
    if (error) throw error;
    return { id: String((response.body as { ticket: { id: number } }).ticket.id) };
  }
}

const PRIORITY_TO_SEVERITY: Readonly<Record<string, 1 | 2 | 3 | 4>> = {
  urgent: 1, high: 2, normal: 3, low: 4,
};

interface ZendeskTicket {
  id: number; status?: string; priority?: string; updated_at?: string;
  tags?: string[]; satisfaction_rating?: { score?: string };
}

/** Freshdesk (read-only). The second exemplar in the support category. */
export class FreshdeskSupportConnector implements SupportConnector {
  readonly name = 'freshdesk';
  readonly category = 'support' as const;

  constructor(private readonly http: HttpClient, private readonly domain: string) {}

  capabilities(): SystemCapabilityDeclaration {
    return {
      system: this.name,
      category: this.category,
      readOnly: true,
      optionalWrites: [],
      rateLimit: { requestsPerSecond: 8 },
      degradationNotes: [
        'Freshdesk exposes no satisfaction score on the ticket list, so sentiment is derived from priority and status only.',
      ],
    };
  }

  async readSupport(credential: Credential, lookup: SystemLookup): Promise<SupportFacts | undefined> {
    const response = await this.http.send({
      method: 'GET',
      url: `https://${this.domain}.freshdesk.com/api/v2/tickets?email=${encodeURIComponent(lookup.email)}`,
      headers: { authorization: `Basic ${Buffer.from(`${credential.accessToken}:X`).toString('base64')}` },
    });
    const error = classifyResponse(this.name, response, 'tickets');
    if (error) throw error;

    const tickets = (Array.isArray(response.body) ? response.body : []) as FreshdeskTicket[];
    // Freshdesk status 4 is Resolved and 5 is Closed.
    const open = tickets.filter((ticket) => ticket.status !== 4 && ticket.status !== 5);
    if (open.length === 0) return { openTicketCount: 0, sentiment: 'UNKNOWN', recentEscalations: 0 };

    const severities = open.map((ticket) => FRESHDESK_PRIORITY[ticket.priority ?? 2] ?? 4).sort((a, b) => a - b);
    return {
      openTicketCount: open.length,
      highestSeverity: severities[0] as 1 | 2 | 3 | 4,
      // Honest: without a satisfaction signal, an urgent open ticket is the only
      // evidence available, and it is evidence of urgency rather than of mood.
      sentiment: severities[0] === 1 ? 'NEGATIVE' : 'NEUTRAL',
      recentEscalations: open.filter((ticket) => ticket.priority === 4).length,
    };
  }
}

const FRESHDESK_PRIORITY: Readonly<Record<number, 1 | 2 | 3 | 4>> = { 4: 1, 3: 2, 2: 3, 1: 4 };
interface FreshdeskTicket { id: number; status?: number; priority?: number }
