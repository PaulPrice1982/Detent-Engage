import type { ConsentPurpose, Jurisdiction } from './consent.js';

/**
 * Channel-agnostic conversation model (section 45.1, FR-069).
 *
 * Built now, before any channel beyond the website exists, because it is a
 * prerequisite rather than an optional tidy-up: without it, each channel forks
 * the qualification and consent logic, and the second fork is the one that
 * quietly loses a consent check.
 *
 * The continuity key is what makes a website session and a later email reply
 * the same conversation rather than two leads. That is a product advantage and
 * a duplicate-prevention mechanism at the same time (section 16.5).
 */
export type Channel = 'WEBSITE' | 'EMAIL' | 'WHATSAPP' | 'SLACK' | 'IN_APP' | 'SMS';

export type Modality = 'TEXT' | 'VOICE' | 'VIDEO';

/** Channels this build actually serves. The rest are modelled, not enabled. */
export const ENABLED_CHANNELS: readonly Channel[] = ['WEBSITE', 'EMAIL'];

export function isChannelEnabled(channel: Channel): boolean {
  return ENABLED_CHANNELS.includes(channel);
}

/**
 * The consent state travelling with a conversation, whatever channel it is on.
 *
 * Carried as an envelope rather than re-derived per channel: a visitor who
 * refused identity resolution on the website has refused it for the email reply
 * that continues the same conversation, and an adapter that re-asked would be
 * asking someone who has already answered.
 */
export interface ConsentEnvelope {
  readonly purposes: readonly ConsentPurpose[];
  readonly jurisdiction: Jurisdiction;
  readonly source: 'HOST_CMP' | 'WIDGET_PROMPT' | 'VOICE_PROMPT' | 'TENANT_IMPORT' | 'EMAIL_REPLY';
  /** Consent event ids backing each purpose, so the evidence travels too. */
  readonly eventIds: Readonly<Record<string, string>>;
}

export interface ChannelConversationRef {
  readonly id: string;
  readonly tenantId: string;
  readonly personRef?: string;
  readonly channel: Channel;
  readonly modality: Modality;
  readonly consentEnvelope: ConsentEnvelope;
  /** Links this conversation to others that are the same commercial thread. */
  readonly continuityKey: string;
}

/**
 * Derive a continuity key.
 *
 * Keyed on tenant plus the strongest stable identifier available: a confirmed
 * work email where we have one, otherwise the pseudonymous session subject. The
 * email form is what lets an inbound reply, arriving days later with no cookie,
 * resolve to the original conversation.
 *
 * Deliberately not keyed on a device identifier: that would be a PECR
 * Regulation 6 access event, and continuity is not worth a consent gate.
 */
export function continuityKeyFor(tenantId: string, identifier: { email?: string; subjectRef?: string }): string {
  if (identifier.email) {
    return `${tenantId}:email:${identifier.email.trim().toLowerCase()}`;
  }
  if (identifier.subjectRef) {
    return `${tenantId}:subject:${identifier.subjectRef}`;
  }
  throw new Error('a continuity key requires an email or a subject reference');
}

/** Two conversations are the same thread when their continuity keys match. */
export function sameThread(a: ChannelConversationRef, b: ChannelConversationRef): boolean {
  return a.tenantId === b.tenantId && a.continuityKey === b.continuityKey;
}
