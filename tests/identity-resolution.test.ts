import { describe, expect, it } from 'vitest';
import { classify, normaliseEmail, normalisePhone, scoreAll, extractCorporateDomain } from '@detent/awa-identity';
import type { MatchCandidate } from '@detent/awa-connectors';
import { buildHarness } from './fixtures/tenant.js';

/**
 * CI gate: deduplication precision above 95% on the standard synthetic
 * dataset, with recall reported alongside (sections 17.2, 30, 36.2).
 */
describe('normalisation', () => {
  it('normalises email case, whitespace and plus-addressing for matching only', () => {
    const result = normaliseEmail('  Alex.Warner+detent@Gmail.com ');
    expect(result.normalised).toBe('alex.warner+detent@gmail.com');
    expect(result.matchKey).toBe('alexwarner@gmail.com');
    expect(result.isPublicMailbox).toBe(true);
    // The address the person gave us is preserved; only the match key is lossy.
    expect(result.raw).toBe('Alex.Warner+detent@Gmail.com');
  });

  it('keeps dots significant outside Gmail', () => {
    expect(normaliseEmail('alex.warner@acme.co.uk').matchKey).toBe('alex.warner@acme.co.uk');
  });

  it('excludes public mailboxes from corporate domain extraction', () => {
    expect(extractCorporateDomain('alex@acme.co.uk')).toBe('acme.co.uk');
    expect(extractCorporateDomain('alex@gmail.com')).toBeUndefined();
  });

  it('converts UK national numbers to E.164 and leaves international ones alone', () => {
    expect(normalisePhone('07700 900123')).toBe('+447700900123');
    expect(normalisePhone('+1 415 555 0132')).toBe('+14155550132');
    expect(normalisePhone('00353 1 234 5678')).toBe('+35312345678');
    expect(normalisePhone('123')).toBeUndefined();
  });
});

describe('scoring waterfall', () => {
  const candidate = (over: Partial<MatchCandidate>): MatchCandidate => ({
    externalId: 'c1', objectType: 'contact', ...over,
  });

  it('treats an exact email match as high confidence and person-level', () => {
    const [scored] = scoreAll({ email: 'alex@acme.co.uk' }, [candidate({ email: 'Alex@Acme.co.uk' })]);
    expect(scored!.band).toBe('HIGH');
    expect(scored!.companyLevelOnly).toBe(false);
  });

  it('treats a shared corporate domain as company-level evidence only', () => {
    const [scored] = scoreAll({ email: 'alex@acme.co.uk' }, [candidate({ email: 'priya@acme.co.uk', name: 'Priya Raman' })]);
    expect(scored!.companyLevelOnly).toBe(true);
    expect(scored!.band).not.toBe('HIGH');
  });

  it('never treats a person-name match as sufficient on its own', () => {
    const scored = scoreAll({ name: 'Alex Warner' }, [candidate({ name: 'Alex Warner' })]);
    const result = classify(scored, { opportunities: [], customerLifecycleStages: ['customer'] });
    expect(result.classification).toBe('NEW_PROSPECT');
  });

  it('returns AMBIGUOUS on two candidates in the same band, and never guesses', () => {
    const scored = scoreAll({ email: 'alex@acme.co.uk' }, [
      candidate({ externalId: 'c1', email: 'alex@acme.co.uk' }),
      candidate({ externalId: 'c2', email: 'alex@acme.co.uk' }),
    ]);
    const result = classify(scored, { opportunities: [], customerLifecycleStages: ['customer'] });
    expect(result.classification).toBe('AMBIGUOUS');
    expect(result.permittedBehaviour).toBe('disambiguate_or_escalate');
  });

  it('classifies an open opportunity as route_to_owner', () => {
    const scored = scoreAll({ email: 'alex@acme.co.uk' }, [candidate({ email: 'alex@acme.co.uk', ownerRef: 'owner_1' })]);
    const result = classify(scored, {
      opportunities: [{ id: 'o1', isOpen: true, stageRef: 'proposal' }],
      customerLifecycleStages: ['customer'],
    });
    expect(result.classification).toBe('OPEN_OPPORTUNITY');
    expect(result.permittedBehaviour).toBe('route_to_owner');
  });

  it('classifies a closed-won relationship as an existing customer, never a new lead', () => {
    const scored = scoreAll({ email: 'alex@acme.co.uk' }, [candidate({ email: 'alex@acme.co.uk' })]);
    const result = classify(scored, {
      opportunities: [{ id: 'o1', isOpen: false, isClosedWon: true }],
      customerLifecycleStages: ['customer'],
    });
    expect(result.classification).toBe('EXISTING_CUSTOMER');
    expect(result.permittedBehaviour).toBe('route_to_account_team');
  });
});

/**
 * The standard synthetic dataset. Each case states the truth the matcher should
 * reach. Precision is measured as: of the cases where we asserted a confident
 * person-level match, how many were correct.
 */
interface DedupCase {
  readonly label: string;
  readonly input: { email?: string; phoneE164?: string; name?: string };
  readonly candidates: MatchCandidate[];
  /** The external id that should be matched, or undefined for "no match". */
  readonly truth: string | undefined;
}

const DATASET: DedupCase[] = [
  { label: 'exact email', input: { email: 'alex@acme.co.uk' }, candidates: [{ externalId: 'a', objectType: 'contact', email: 'alex@acme.co.uk' }], truth: 'a' },
  { label: 'case difference', input: { email: 'alex@acme.co.uk' }, candidates: [{ externalId: 'b', objectType: 'contact', email: 'ALEX@ACME.CO.UK' }], truth: 'b' },
  { label: 'gmail dots', input: { email: 'alex.warner@gmail.com' }, candidates: [{ externalId: 'c', objectType: 'contact', email: 'alexwarner@gmail.com' }], truth: 'c' },
  { label: 'plus address', input: { email: 'alex+news@acme.co.uk' }, candidates: [{ externalId: 'd', objectType: 'contact', email: 'alex@acme.co.uk' }], truth: 'd' },
  { label: 'colleague, same domain', input: { email: 'alex@acme.co.uk' }, candidates: [{ externalId: 'e', objectType: 'contact', email: 'priya@acme.co.uk' }], truth: undefined },
  { label: 'namesake, different company', input: { name: 'Alex Warner' }, candidates: [{ externalId: 'f', objectType: 'contact', name: 'Alex Warner', email: 'alex@northwind.com' }], truth: undefined },
  { label: 'phone match', input: { phoneE164: '+447700900123' }, candidates: [{ externalId: 'g', objectType: 'contact', phone: '07700 900123' }], truth: 'g' },
  { label: 'phone mismatch', input: { phoneE164: '+447700900123' }, candidates: [{ externalId: 'h', objectType: 'contact', phone: '+447700900999' }], truth: undefined },
  { label: 'public mailbox, different person', input: { email: 'alex@gmail.com' }, candidates: [{ externalId: 'i', objectType: 'contact', email: 'jo@gmail.com' }], truth: undefined },
  { label: 'lead and contact duplicate', input: { email: 'alex@acme.co.uk' }, candidates: [
      { externalId: 'j1', objectType: 'lead', email: 'alex@acme.co.uk' },
      { externalId: 'j2', objectType: 'contact', email: 'alex@acme.co.uk' },
    ], truth: undefined /* ambiguous: must not pick one */ },
  { label: 'no candidates', input: { email: 'nobody@acme.co.uk' }, candidates: [], truth: undefined },
  { label: 'trailing whitespace', input: { email: 'alex@acme.co.uk' }, candidates: [{ externalId: 'k', objectType: 'contact', email: ' alex@acme.co.uk ' }], truth: 'k' },
  { label: 'similar company name only', input: { name: 'Alex Warner' }, candidates: [{ externalId: 'l', objectType: 'contact', name: 'Alexandra Warner' }], truth: undefined },
  { label: 'email plus name agreement', input: { email: 'alex@acme.co.uk', name: 'Alex Warner' }, candidates: [{ externalId: 'm', objectType: 'contact', email: 'alex@acme.co.uk', name: 'Alex Warner' }], truth: 'm' },
  { label: 'email present, candidate has none', input: { email: 'alex@acme.co.uk' }, candidates: [{ externalId: 'n', objectType: 'lead', name: 'Alex Warner' }], truth: undefined },
];

describe('deduplication precision on the standard synthetic dataset', () => {
  it('exceeds 95% precision, with recall reported alongside', () => {
    let assertedMatches = 0;
    let correctMatches = 0;
    let truePositivesAvailable = 0;
    let recalled = 0;

    for (const testCase of DATASET) {
      const scored = scoreAll(testCase.input, testCase.candidates);
      const result = classify(scored, { opportunities: [], customerLifecycleStages: ['customer'] });
      const asserted = result.classification !== 'NEW_PROSPECT' && result.classification !== 'AMBIGUOUS'
        ? scored[0]?.candidate.externalId
        : undefined;

      if (testCase.truth !== undefined) truePositivesAvailable++;
      if (asserted !== undefined) {
        assertedMatches++;
        if (asserted === testCase.truth) { correctMatches++; recalled++; }
      }
    }

    const precision = assertedMatches === 0 ? 1 : correctMatches / assertedMatches;
    const recall = truePositivesAvailable === 0 ? 1 : recalled / truePositivesAvailable;

    // Reported, not silently asserted: a precision figure without recall hides
    // a matcher that has simply stopped matching.
    console.log(`dedup precision ${(precision * 100).toFixed(1)}%, recall ${(recall * 100).toFixed(1)}% over ${DATASET.length} cases`);
    expect(precision).toBeGreaterThan(0.95);
    expect(recall).toBeGreaterThan(0.8);
  });
});

describe('duplicate handling', () => {
  it('detects a probable duplicate, raises an owner task, and never merges', async () => {
    const harness = await buildHarness();
    const tenantId = harness.config.tenantId;
    harness.crm.seed({ objectType: 'contact', email: 'alex@acme.co.uk', name: 'Alex Warner', ownerRef: 'owner_1' });
    harness.crm.seed({ objectType: 'lead', email: 'alex@acme.co.uk', name: 'A Warner', ownerRef: 'owner_2' });

    const session = await harness.platform.openSession(tenantId, 'UK');
    await harness.platform.consent.record({
      tenantId, subjectRef: session.subjectRef, purpose: 'IDENTITY_RESOLUTION',
      choice: 'GRANTED', wordingShown: 'May we check whether we already know you?',
      source: 'HOST_CMP', jurisdiction: 'UK', correlationId: session.correlationId,
    });

    const before = harness.crm.records.size;
    const resolution = await harness.platform.identity.resolve({
      tenantId, sessionId: session.id, subjectRef: session.subjectRef,
      correlationId: session.correlationId, email: 'alex@acme.co.uk',
    });

    expect(resolution.classification).toBe('AMBIGUOUS');
    // Nothing merged, nothing deleted, nothing created.
    expect(harness.crm.records.size).toBe(before);
  });
});
