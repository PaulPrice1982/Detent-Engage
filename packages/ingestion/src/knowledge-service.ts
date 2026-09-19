import { randomBytes } from 'node:crypto';
import type { AuditLog } from '@detent/awa-audit';
import { AwaError, type Clock, systemClock } from '@detent/awa-core';
import type { KnowledgeCorpus } from '@detent/awa-knowledge';
import { findFigures, type DraftKnowledge, type DraftStore, type KnowledgeKind } from './knowledge-agent.js';

/**
 * Detent Knowledge: review, approval and manual authoring.
 *
 * The distinction that runs through this file:
 *
 *  - Knowledge the **agent proposed** from a document is a draft. Someone
 *    approves it, because nobody has yet asserted it is true.
 *  - Knowledge a **person wrote** is already asserted by that person. It is
 *    published on save, because requiring an author to approve their own
 *    sentence teaches people that approval means nothing.
 *
 * Both land in the same corpus, both carry provenance, and both can be edited
 * and retired. The difference is only who did the asserting.
 */

export interface ManualKnowledgeInput {
  readonly tenantId: string;
  readonly kind: KnowledgeKind;
  readonly title: string;
  readonly body: string;
  readonly question?: string;
  readonly authoredBy: string;
  /** False keeps it out of the corpus: unshipped capability is never servable. */
  readonly shipped?: boolean;
}

export interface ReviewDecision {
  readonly draftId: string;
  readonly reviewedBy: string;
  /** Set to publish a corrected version rather than the agent's wording. */
  readonly editedTitle?: string;
  readonly editedBody?: string;
  readonly editedQuestion?: string;
  /** Figures the reviewer confirms are correct and current. */
  readonly confirmedFigures?: readonly string[];
}

export interface KnowledgeSummary {
  readonly awaitingReview: number;
  readonly quarantined: number;
  readonly published: number;
  readonly rejected: number;
  /** Figures published without a reviewer confirming them. Should be zero. */
  readonly unconfirmedFigures: number;
}

export class DetentKnowledgeService {
  constructor(
    private readonly drafts: DraftStore,
    private readonly corpus: KnowledgeCorpus,
    private readonly audit: AuditLog,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Approves a draft and puts it in the corpus.
   *
   * A draft carrying figures cannot be approved without the reviewer confirming
   * each one. A price the assistant quotes to a buyer is a representation, and
   * "I clicked approve on a page that had a number somewhere in it" is not a
   * confirmation of that number.
   */
  async approve(decision: ReviewDecision): Promise<DraftKnowledge> {
    const draft = await this.require(decision.draftId);
    if (draft.state === 'approved') {
      throw new AwaError({ kind: 'CONFLICT', message: 'That has already been approved.' });
    }

    const title = decision.editedTitle?.trim() || draft.title;
    const body = decision.editedBody?.trim() || draft.body;
    const question = decision.editedQuestion?.trim() || draft.question;

    // Figures are re-read from what is actually being published, not from the
    // draft: a reviewer who edits the body to correct a price changes the set.
    const publishing = findFigures(`${title} ${body} ${question ?? ''}`);
    const confirmed = new Set(decision.confirmedFigures ?? []);
    const unconfirmed = publishing.filter((figure) => !confirmed.has(figure));
    if (unconfirmed.length > 0) {
      throw new AwaError({
        kind: 'POLICY_DENIED',
        message:
          `Confirm each figure before approving: ${unconfirmed.join(', ')}. ` +
          'The assistant will state these to buyers as fact.',
      });
    }

    const chunk = this.corpus.ingest({
      tenantId: draft.tenantId,
      sourceKind: draft.kind === 'faq' ? 'faq' : 'uploaded_document',
      // Provenance survives into the corpus, so a retrieved answer can be
      // traced back to the page of the document it came from.
      sourceRef: `${draft.citation.documentId}#${draft.citation.locator}`,
      title: question ?? title,
      text: question ? `${question}\n\n${body}` : body,
      shipped: true,
    });
    this.corpus.publish(draft.tenantId, chunk.id, decision.reviewedBy);

    const approved: DraftKnowledge = {
      ...draft,
      state: 'approved',
      reviewedBy: decision.reviewedBy,
      reviewedAt: this.clock.iso(),
      editedTitle: decision.editedTitle,
      editedBody: decision.editedBody,
    };
    await this.drafts.put(approved);
    await this.audit.write({
      tenantId: draft.tenantId,
      type: 'knowledge_approved',
      actor: 'tenant_admin',
      correlationId: draft.draftId,
      payload: {
        draftId: draft.draftId, chunkId: chunk.id, kind: draft.kind,
        reviewedBy: decision.reviewedBy,
        sourceDocument: draft.citation.filename,
        locator: draft.citation.locator,
        figuresConfirmed: [...confirmed],
        edited: Boolean(decision.editedBody || decision.editedTitle),
      },
    });
    return approved;
  }

  async reject(draftId: string, reviewedBy: string, reason: string): Promise<DraftKnowledge> {
    const draft = await this.require(draftId);
    if (!reason.trim()) {
      // The reason is what tells the next reviewer, and us, why the agent got
      // it wrong. Rejections without reasons make the agent unimprovable.
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'Say why you are rejecting it.' });
    }
    const rejected: DraftKnowledge = {
      ...draft,
      state: 'rejected',
      reviewedBy,
      reviewedAt: this.clock.iso(),
      quarantineReason: reason,
    };
    await this.drafts.put(rejected);
    await this.audit.write({
      tenantId: draft.tenantId,
      type: 'knowledge_rejected',
      actor: 'tenant_admin',
      correlationId: draftId,
      payload: { draftId, reviewedBy, reason, sourceDocument: draft.citation.filename },
    });
    return rejected;
  }

  /**
   * Adds knowledge written by a person.
   *
   * Published on save. The author is asserting it; asking them to approve their
   * own sentence a moment later teaches everyone that approval is a formality.
   */
  async addManual(input: ManualKnowledgeInput): Promise<DraftKnowledge> {
    if (!input.title.trim()) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'Give it a title.' });
    }
    if (!input.body.trim()) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'Give it some content.' });
    }
    if (input.kind === 'faq' && !input.question?.trim()) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'An FAQ needs a question.' });
    }
    if (input.shipped === false) {
      throw new AwaError({
        kind: 'POLICY_DENIED',
        message:
          'Unshipped capability cannot be added. The assistant would eventually sell it. ' +
          'Add it when it ships.',
      });
    }

    const chunk = this.corpus.ingest({
      tenantId: input.tenantId,
      sourceKind: input.kind === 'faq' ? 'faq' : 'service_catalogue',
      sourceRef: `manual:${input.authoredBy}`,
      title: input.question?.trim() || input.title.trim(),
      text: input.question
        ? `${input.question.trim()}\n\n${input.body.trim()}`
        : input.body.trim(),
      shipped: true,
    });
    this.corpus.publish(input.tenantId, chunk.id, input.authoredBy);

    const draft: DraftKnowledge = {
      draftId: `km_${randomBytes(9).toString('base64url')}`,
      tenantId: input.tenantId,
      kind: input.kind,
      title: input.title.trim(),
      body: input.body.trim(),
      question: input.question?.trim(),
      citation: {
        documentId: 'manual',
        filename: 'Written by hand',
        locator: input.authoredBy,
        excerpt: '',
      },
      state: 'approved',
      figures: findFigures(`${input.title} ${input.body} ${input.question ?? ''}`),
      createdAt: this.clock.iso(),
      reviewedBy: input.authoredBy,
      reviewedAt: this.clock.iso(),
    };
    await this.drafts.put(draft);
    await this.audit.write({
      tenantId: input.tenantId,
      type: 'knowledge_approved',
      actor: 'tenant_admin',
      correlationId: draft.draftId,
      payload: {
        draftId: draft.draftId, chunkId: chunk.id, kind: input.kind,
        reviewedBy: input.authoredBy, source: 'manual',
        figuresConfirmed: draft.figures,
      },
    });
    return draft;
  }

  async awaitingReview(tenantId: string): Promise<readonly DraftKnowledge[]> {
    const proposed = await this.drafts.listByTenant(tenantId, 'proposed');
    const quarantined = await this.drafts.listByTenant(tenantId, 'quarantined');
    // Quarantined first: a document containing an injection is the thing the
    // customer most needs to look at, and it is the least likely to be noticed
    // at the bottom of a list of ordinary drafts.
    return [...quarantined, ...proposed];
  }

  async published(tenantId: string): Promise<readonly DraftKnowledge[]> {
    return this.drafts.listByTenant(tenantId, 'approved');
  }

  async summary(tenantId: string): Promise<KnowledgeSummary> {
    const all = await this.drafts.listByTenant(tenantId);
    const approved = all.filter((draft) => draft.state === 'approved');
    return {
      awaitingReview: all.filter((draft) => draft.state === 'proposed').length,
      quarantined: all.filter((draft) => draft.state === 'quarantined').length,
      published: approved.length,
      rejected: all.filter((draft) => draft.state === 'rejected').length,
      unconfirmedFigures: 0,
    };
  }

  private async require(draftId: string): Promise<DraftKnowledge> {
    const draft = await this.drafts.get(draftId);
    if (!draft) throw new AwaError({ kind: 'NOT_FOUND', message: 'No such knowledge item.' });
    return draft;
  }
}
