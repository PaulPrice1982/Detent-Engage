import type { Credential, HttpClient } from '@detent/awa-connectors';
import { classifyResponse } from '@detent/awa-connectors';
import type { ClmConnector, ClmFacts, ContractedItem, SystemCapabilityDeclaration, SystemLookup } from '../contract.js';

/**
 * Ironclad CLM (read-only by default).
 *
 * This is the one integration in the whole programme that produces recovered
 * revenue rather than better context, and it is the one that maps onto contract
 * monetisation and excess-use recovery; the capability this business already
 * has and the category largely ignores.
 *
 * The hard boundaries in section 55.2 govern everything here. This connector
 * reads and returns; it never interprets. Clause text is returned so the
 * entitlement service *can* cite it, and the verification ladder decides
 * whether it ever does.
 */
export class IroncladClmConnector implements ClmConnector {
  readonly name = 'ironclad';
  readonly category = 'clm' as const;

  constructor(
    private readonly http: HttpClient,
    private readonly taskCreationEnabled = false,
    private readonly base = 'https://ironcladapp.com/public/api/v1',
  ) {}

  capabilities(): SystemCapabilityDeclaration {
    return {
      system: this.name,
      category: this.category,
      readOnly: true,
      optionalWrites: this.taskCreationEnabled ? ['create_clm_task'] : [],
      rateLimit: { requestsPerSecond: 5 },
      degradationNotes: [
        'Entitlement categories depend on the tenant using a consistent metadata schema on executed records.',
        'Only executed agreements are read. Templates and drafts are excluded by construction.',
        'Clause text is returned to the platform but is only ever surfaced at verification level 3.',
      ],
    };
  }

  private async get(credential: Credential, path: string): Promise<unknown> {
    const response = await this.http.send({
      method: 'GET',
      url: `${this.base}${path}`,
      headers: { authorization: `Bearer ${credential.accessToken}` },
    });
    const error = classifyResponse(this.name, response, path);
    if (error) throw error;
    return response.body;
  }

  async readContract(credential: Credential, lookup: SystemLookup): Promise<ClmFacts | undefined> {
    const domain = lookup.domain ?? lookup.email.split('@')[1];
    if (!domain) return undefined;

    // Executed records only. A template or a draft is not an agreement with
    // this party, and answering from one would be answering about a contract
    // that does not exist.
    const body = await this.get(
      credential,
      `/records?filter=${encodeURIComponent(JSON.stringify({ type: 'agreement', status: 'executed', counterpartyDomain: domain }))}`,
    );
    const record = ((body as { list?: IroncladRecord[] }).list ?? [])[0];
    if (!record) return { hasExecutedAgreement: false, inScope: [], outOfScope: [] };

    const properties = record.properties ?? {};
    const inScope: ContractedItem[] = (properties['entitlements']?.value as unknown as ContractedItem[] | undefined) ?? [];

    return {
      hasExecutedAgreement: true,
      agreementRef: record.id,
      counterpartyEmailDomain: domain,
      inScope,
      outOfScope: (properties['exclusions']?.value as unknown as string[] | undefined) ?? [],
      expiresAt: properties['expirationDate']?.value as string | undefined,
      autoRenew: properties['autoRenew']?.value === true,
      noticeByDate: properties['noticeDate']?.value as string | undefined,
      excessUseTerms: properties['excessUse']?.value as ClmFacts['excessUseTerms'],
      clauses: (properties['clauses']?.value as Readonly<Record<string, string>> | undefined),
    };
  }

  async createTask(credential: Credential, input: { subject: string; body: string; agreementRef?: string }): Promise<{ id: string }> {
    if (!this.taskCreationEnabled) {
      throw new Error('ironclad task creation is not enabled for this tenant');
    }
    const response = await this.http.send({
      method: 'POST',
      url: `${this.base}/workflows`,
      headers: { authorization: `Bearer ${credential.accessToken}` },
      body: { template: 'commercial-review', attributes: { subject: input.subject, notes: input.body, agreement: input.agreementRef } },
    });
    const error = classifyResponse(this.name, response, 'workflows');
    if (error) throw error;
    return { id: String((response.body as { id: string }).id) };
  }
}

interface IroncladRecord {
  id: string;
  properties?: Record<string, { value?: unknown }>;
}

/** DocuSign CLM (read-only). The second exemplar in the CLM category. */
export class DocuSignClmConnector implements ClmConnector {
  readonly name = 'docusign-clm';
  readonly category = 'clm' as const;

  constructor(private readonly http: HttpClient, private readonly accountId: string) {}

  capabilities(): SystemCapabilityDeclaration {
    return {
      system: this.name,
      category: this.category,
      readOnly: true,
      optionalWrites: [],
      rateLimit: { requestsPerSecond: 4 },
      degradationNotes: [
        'DocuSign CLM exposes attributes rather than a fixed entitlement schema; mapping is per tenant.',
        'Notice dates are frequently absent and are reported as unknown rather than inferred from the expiry.',
      ],
    };
  }

  async readContract(credential: Credential, lookup: SystemLookup): Promise<ClmFacts | undefined> {
    const domain = lookup.domain ?? lookup.email.split('@')[1];
    if (!domain) return undefined;

    const response = await this.http.send({
      method: 'GET',
      url: `https://apiuatna11.springcm.com/v2/${this.accountId}/documents?query=${encodeURIComponent(domain)}&status=Executed`,
      headers: { authorization: `Bearer ${credential.accessToken}` },
    });
    const error = classifyResponse(this.name, response, 'documents');
    if (error) throw error;

    const items = ((response.body as { Items?: SpringCmDocument[] }).Items ?? []);
    const executed = items[0];
    if (!executed) return { hasExecutedAgreement: false, inScope: [], outOfScope: [] };

    const attributes = executed.AttributeGroups?.['Contract'] ?? {};
    return {
      hasExecutedAgreement: true,
      agreementRef: executed.Href,
      counterpartyEmailDomain: domain,
      inScope: (attributes['Entitlements'] as unknown as ContractedItem[] | undefined) ?? [],
      outOfScope: (attributes['Exclusions'] as unknown as string[] | undefined) ?? [],
      expiresAt: attributes['ExpirationDate'] as string | undefined,
      autoRenew: attributes['AutoRenew'] === true,
      // Absent rather than inferred: a notice date guessed from an expiry is a
      // legal deadline the tenant might act on, and getting it wrong is severe.
      noticeByDate: attributes['NoticeDate'] as string | undefined,
    };
  }
}

interface SpringCmDocument {
  Href: string;
  AttributeGroups?: Record<string, Record<string, unknown>>;
}
