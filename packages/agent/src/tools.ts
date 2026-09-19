import type { JsonSchema } from '@detent/awa-core';
import type { ToolName } from '@detent/awa-policy';

/**
 * Typed tool schemas (section 22.1).
 *
 * Every schema sets `additionalProperties: false`. That is the control that
 * stops a model smuggling an unvalidated field, an owner id, a lifecycle stage
 *, past the tool layer and into a CRM write.
 *
 * `service_interest` carries a per-tenant enum, injected at session start from
 * the tenant's service catalogue, so a value outside the catalogue fails
 * validation rather than being written as free text.
 */
export interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly parameters: JsonSchema;
}

const E164 = '^\\+[1-9]\\d{6,14}$';

export function buildToolCatalogue(serviceCatalogue: readonly string[]): ToolDefinition[] {
  const serviceInterest: JsonSchema = serviceCatalogue.length > 0
    ? { type: 'string', enum: [...serviceCatalogue] }
    : { type: 'string' };

  return [
    {
      name: 'classify_intent',
      description: 'Classify what the visitor is trying to achieve. Never disclosed to the visitor as a score.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          intent: { type: 'string', enum: ['research', 'buy', 'support', 'partner', 'careers', 'complaint', 'other'] },
          urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['intent'],
      },
    },
    {
      name: 'knowledge_lookup',
      description: 'Search the tenant approved knowledge. The only permitted source of factual claims.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { query: { type: 'string', minLength: 2, maxLength: 500 } },
        required: ['query'],
      },
    },
    {
      name: 'resolve_identity',
      description: 'Ask the platform whether this visitor is already known. Returns a classification and a permitted behaviour only. It never returns CRM record contents.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          work_email: { type: 'string', format: 'email' },
          phone_e164: { type: 'string', pattern: E164 },
        },
        required: [],
      },
    },
    {
      name: 'capture_contact',
      description: 'Record contact details the visitor has explicitly confirmed. A field not listed in confirmed_fields was not read back and will be rejected.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          work_email: { type: 'string', format: 'email' },
          full_name: { type: 'string', minLength: 2, maxLength: 120 },
          phone_e164: { type: 'string', pattern: E164 },
          organisation: { type: 'string', maxLength: 200 },
          job_title: { type: 'string', maxLength: 120 },
          timezone: { type: 'string', maxLength: 64 },
          service_interest: serviceInterest,
          confirmed_fields: { type: 'array', items: { type: 'string' }, minItems: 1 },
          marketing_consent: { type: 'boolean' },
          consent_event_id: { type: 'string' },
        },
        required: ['work_email', 'full_name', 'service_interest', 'confirmed_fields'],
      },
    },
    {
      name: 'upsert_person',
      description: 'Write the captured person to the tenant CRM through the canonical model. Owner, lifecycle stage, pipeline and stage cannot be set.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          work_email: { type: 'string', format: 'email' },
          full_name: { type: 'string', minLength: 2 },
          job_title: { type: 'string' },
          phone_e164: { type: 'string', pattern: E164 },
          organisation_name: { type: 'string' },
          organisation_domain: { type: 'string' },
          qualification_state: { type: 'string', enum: ['UNQUALIFIED', 'CAPTURED', 'QUALIFIED', 'DISQUALIFIED'] },
        },
        required: ['work_email', 'qualification_state'],
      },
    },
    {
      name: 'upsert_organisation',
      description: 'Write the organisation to the tenant CRM through the canonical model.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { name: { type: 'string' }, domain: { type: 'string' }, size_band: { type: 'string' } },
        required: ['domain'],
      },
    },
    {
      name: 'create_opportunity',
      description: 'Create an opportunity. Stage and pipeline are set by the CRM, never by the assistant.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          person_external_id: { type: 'string' },
          summary: { type: 'string', minLength: 4, maxLength: 500 },
          service_interest: serviceInterest,
        },
        required: ['person_external_id', 'summary'],
      },
    },
    {
      name: 'create_note',
      description: 'Attach a conversation note to the CRM record.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          subject: { type: 'string', minLength: 2, maxLength: 200 },
          body: { type: 'string', maxLength: 8000 },
          person_external_id: { type: 'string' },
        },
        required: ['subject', 'body'],
      },
    },
    {
      name: 'create_task',
      description: 'Raise a task for the record owner. Used for follow-ups, suspected duplicates and captured requests the assistant cannot fulfil.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          subject: { type: 'string', minLength: 2, maxLength: 200 },
          body: { type: 'string', maxLength: 4000 },
          person_external_id: { type: 'string' },
          due_at: { type: 'string', format: 'date-time' },
        },
        required: ['subject'],
      },
    },
    {
      name: 'check_availability',
      description: 'Read available meeting slots for the routed owner or team.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          owner_ref: { type: 'string' },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
        },
        required: [],
      },
    },
    {
      name: 'book_meeting',
      description: 'Book a slot the visitor has explicitly confirmed. Never confirm a slot that has not been held.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          slot_id: { type: 'string', minLength: 1 },
          owner_ref: { type: 'string' },
          work_email: { type: 'string', format: 'email' },
          confirmed_fields: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
        required: ['slot_id', 'work_email', 'confirmed_fields'],
      },
    },
    {
      name: 'notify_owner',
      description: 'Internal notification to the record owner. First-party internal communication, no consent required.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          owner_ref: { type: 'string' },
          reason: { type: 'string', enum: ['qualified_lead', 'escalation', 'booking', 'existing_customer', 'suspected_duplicate'] },
          summary: { type: 'string', maxLength: 2000 },
        },
        required: ['reason', 'summary'],
      },
    },
    {
      name: 'send_transactional_email',
      description: 'Send strictly transactional content the visitor asked for. No promotional content may be bundled in.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          work_email: { type: 'string', format: 'email' },
          template: { type: 'string', enum: ['meeting_confirmation', 'requested_information', 'callback_confirmation'] },
          confirmed_fields: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
        required: ['work_email', 'template', 'confirmed_fields'],
      },
    },
    {
      name: 'enrol_sequence',
      description: 'Enrol in a marketing sequence. Structurally impossible without a stored marketing consent event id.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          work_email: { type: 'string', format: 'email' },
          sequence_id: { type: 'string' },
          consent_event_id: { type: 'string', minLength: 1 },
          confirmed_fields: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
        required: ['work_email', 'sequence_id', 'consent_event_id', 'confirmed_fields'],
      },
    },
    {
      name: 'start_recording',
      description: 'Begin recording. Blocked without a stored recording consent event. No audio is buffered pending the decision.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { consent_event_id: { type: 'string', minLength: 1 } },
        required: ['consent_event_id'],
      },
    },
    {
      name: 'escalate_to_human',
      description: 'Hand off to a human with full context. Always available, never blocked.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          reason: { type: 'string', enum: ['explicit_request', 'low_confidence', 'high_risk_topic', 'commercial_authority', 'negative_sentiment', 'existing_customer', 'ambiguous_identity', 'injection_or_abuse'] },
          summary: { type: 'string', maxLength: 2000 },
        },
        required: ['reason'],
      },
    },
    {
      name: 'record_outcome',
      description: 'Record which of the nine outcomes this conversation reached. The platform decides whether the outcome is enabled and whether it is billable; you do not.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          outcome: {
            type: 'string',
            enum: [
              'book_meeting', 'start_trial', 'route_self_serve', 'route_partner',
              'request_quote', 'escalate_human', 'escalate_support', 'disqualify', 'abandoned',
            ],
          },
          summary: { type: 'string', maxLength: 2000 },
          work_email: { type: 'string', format: 'email' },
        },
        required: ['outcome'],
      },
    },
    {
      name: 'quote_price',
      description: 'Ask the platform what may be said about price. The platform decides; the assistant relays. Never construct a figure.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          sku: { type: 'string' },
          discount_requested: { type: 'boolean' },
          custom_scope_requested: { type: 'boolean' },
          off_list: { type: 'boolean' },
        },
        required: [],
      },
    },
  ];
}

export function toolSchema(catalogue: readonly ToolDefinition[], name: string): JsonSchema | undefined {
  return catalogue.find((tool) => tool.name === name)?.parameters;
}
