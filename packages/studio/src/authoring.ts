import type { EscalationThresholds, ObjectionPlay, QualificationModel } from '@detent/awa-core';

/**
 * The authoring model (section 39.2), across the seven surfaces in table 6.
 *
 * The compilation step is the whole point. Natural-language authoring produces
 * **deterministic configuration, not a longer prompt**. A tenant writing
 * "always confirm budget before booking" creates a policy gate, not a
 * suggestion the model may ignore. That is what preserves the section 8.3
 * boundary through a surface designed for people who do not write JSON.
 */
export type AuthoringSurface =
  | 'playbook' | 'guidance' | 'claims_and_prices'
  | 'boundaries' | 'escalation' | 'knowledge' | 'mapping';

export interface AuthoredDocument {
  readonly playbook: {
    readonly qualification: QualificationModel;
    readonly routingOutcomes: readonly string[];
  };
  /** Tone and register. Compiles to prompt fragments, versioned. */
  readonly guidance: readonly string[];
  readonly claimsAndPrices: {
    readonly approvedClaims: readonly string[];
    readonly priceSkus: readonly string[];
  };
  /** Stated in business language. Compiles to gates and refusal paths. */
  readonly boundaries: readonly string[];
  readonly escalation: EscalationThresholds;
  readonly knowledgeScope: readonly string[];
  readonly objections: readonly ObjectionPlay[];
}

/**
 * A rule extracted from natural-language authoring. `gate` is what makes this
 * deterministic: the sentence becomes a named policy gate that the tool layer
 * enforces, not a line appended to a prompt.
 */
export interface CompiledRule {
  readonly sourceText: string;
  readonly gate: CompiledGate;
  readonly confidence: number;
}

export type CompiledGate =
  | { readonly kind: 'require_field_before'; readonly field: string; readonly beforeTool: string }
  | { readonly kind: 'forbid_phrase'; readonly phrase: string }
  | { readonly kind: 'escalate_on_topic'; readonly topic: string }
  | { readonly kind: 'never_tool'; readonly tool: string }
  | { readonly kind: 'guidance_only'; readonly text: string };

export interface CompilationResult {
  readonly rules: readonly CompiledRule[];
  /** Sentences that expressed no enforceable rule. Kept as prompt guidance. */
  readonly guidanceFragments: readonly string[];
  /** Sentences that looked like rules but could not be compiled — surfaced, not swallowed. */
  readonly uncompiled: readonly { text: string; reason: string }[];
}

const TOOL_ALIASES: Readonly<Record<string, string>> = {
  booking: 'book_meeting', book: 'book_meeting', 'a meeting': 'book_meeting',
  meeting: 'book_meeting', quote: 'quote_price', price: 'quote_price',
  pricing: 'quote_price', enrol: 'enrol_sequence', enrolling: 'enrol_sequence',
  marketing: 'enrol_sequence', recording: 'start_recording',
};

const FIELD_ALIASES: Readonly<Record<string, string>> = {
  budget: 'budget', timing: 'timing', timescale: 'timing', authority: 'authority',
  'decision maker': 'authority', scale: 'scale', 'team size': 'scale',
  need: 'need', 'contact details': 'work_email', email: 'work_email',
};

const lookup = (haystack: string, table: Readonly<Record<string, string>>): string | undefined => {
  const found = Object.keys(table)
    .filter((key) => haystack.includes(key))
    // Longest alias wins: "decision maker" before "maker" would be a bug.
    .sort((a, b) => b.length - a.length)[0];
  return found ? table[found] : undefined;
};

/**
 * Compile business-language authoring into gates (FR-039).
 *
 * Deliberately conservative. A sentence that clearly expresses one of the four
 * enforceable rule shapes becomes a gate; a sentence that does not becomes
 * prompt guidance and is labelled as such, so a tenant can see which of their
 * instructions are enforced and which are merely requested. A compiler that
 * quietly downgraded an unrecognised rule to guidance would let a tenant
 * believe a boundary exists when it does not.
 */
export function compileAuthoring(sentences: readonly string[]): CompilationResult {
  const rules: CompiledRule[] = [];
  const guidanceFragments: string[] = [];
  const uncompiled: { text: string; reason: string }[] = [];

  for (const raw of sentences) {
    const text = raw.trim();
    if (text.length === 0) continue;
    const lower = text.toLowerCase();

    // "always confirm budget before booking"
    const beforeMatch = /\b(?:always |must )?(?:confirm|capture|check|establish|get)\s+(?:the\s+)?([a-z ]{3,24}?)\s+before\s+([a-z ]{3,24})/i.exec(lower);
    if (beforeMatch) {
      const field = lookup(beforeMatch[1]!, FIELD_ALIASES);
      const tool = lookup(beforeMatch[2]!, TOOL_ALIASES);
      if (field && tool) {
        rules.push({ sourceText: text, gate: { kind: 'require_field_before', field, beforeTool: tool }, confidence: 0.92 });
        continue;
      }
      uncompiled.push({
        text,
        reason: `recognised a "before" rule but could not resolve ${field ? 'the action' : 'the field'} to something enforceable`,
      });
      continue;
    }

    // "never mention our competitors by name"
    const neverPhrase = /\bnever\s+(?:say|mention|use|claim|promise|offer)\s+(.{3,80})/i.exec(text);
    if (neverPhrase) {
      const phrase = neverPhrase[1]!.replace(/[.!]$/, '').trim();
      const tool = lookup(phrase.toLowerCase(), TOOL_ALIASES);
      rules.push({
        sourceText: text,
        gate: tool ? { kind: 'never_tool', tool } : { kind: 'forbid_phrase', phrase },
        confidence: tool ? 0.9 : 0.8,
      });
      continue;
    }

    // "escalate anything about redundancy"
    const escalate = /\b(?:escalate|hand ?off|pass|refer)\b.*?\b(?:about|on|regarding|involving)\s+(.{3,60})/i.exec(text);
    if (escalate) {
      rules.push({
        sourceText: text,
        gate: { kind: 'escalate_on_topic', topic: escalate[1]!.replace(/[.!]$/, '').trim() },
        confidence: 0.85,
      });
      continue;
    }

    // Anything imperative that did not match is flagged rather than silently
    // demoted, because a tenant who wrote a rule expects a rule.
    if (/\b(always|never|must|do not|don't|only)\b/i.test(lower)) {
      uncompiled.push({ text, reason: 'reads as a rule but does not match a supported gate shape' });
      continue;
    }

    guidanceFragments.push(text);
  }

  return { rules, guidanceFragments, uncompiled };
}

/** Compiled gates that the policy engine consults, keyed for fast lookup. */
export interface CompiledPolicy {
  readonly requiredFieldsBeforeTool: Readonly<Record<string, readonly string[]>>;
  readonly forbiddenPhrases: readonly string[];
  readonly escalationTopics: readonly string[];
  readonly forbiddenTools: readonly string[];
  readonly guidance: readonly string[];
}

export function toCompiledPolicy(result: CompilationResult): CompiledPolicy {
  const requiredFieldsBeforeTool: Record<string, string[]> = {};
  const forbiddenPhrases: string[] = [];
  const escalationTopics: string[] = [];
  const forbiddenTools: string[] = [];

  for (const rule of result.rules) {
    switch (rule.gate.kind) {
      case 'require_field_before':
        (requiredFieldsBeforeTool[rule.gate.beforeTool] ??= []).push(rule.gate.field);
        break;
      case 'forbid_phrase': forbiddenPhrases.push(rule.gate.phrase); break;
      case 'escalate_on_topic': escalationTopics.push(rule.gate.topic); break;
      case 'never_tool': forbiddenTools.push(rule.gate.tool); break;
      case 'guidance_only': break;
    }
  }

  return {
    requiredFieldsBeforeTool,
    forbiddenPhrases,
    escalationTopics,
    forbiddenTools,
    guidance: result.guidanceFragments,
  };
}
