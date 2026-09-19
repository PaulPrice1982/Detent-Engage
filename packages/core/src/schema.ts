/**
 * A deliberately small JSON Schema subset validator.
 *
 * Boundary B2 (section 11) requires every model-emitted tool call to be
 * schema-validated before policy runs. That validation is a security control,
 * so it is implemented here rather than delegated to a general-purpose library:
 * the whole of it is auditable in one screen, it cannot be extended by a schema
 * that arrives at runtime, and `additionalProperties: false` is enforced rather
 * than advisory.
 */

export interface JsonSchema {
  readonly type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly enum?: readonly (string | number | boolean)[];
  readonly pattern?: string;
  readonly format?: 'email' | 'date-time' | 'uri';
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly description?: string;
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ValidationOutcome {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

// Deliberately conservative. A value this rejects is one a human should confirm.
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function validate(value: unknown, schema: JsonSchema, path = '$'): ValidationOutcome {
  const issues: ValidationIssue[] = [];
  check(value, schema, path, issues);
  return { valid: issues.length === 0, issues };
}

function check(value: unknown, schema: JsonSchema, path: string, issues: ValidationIssue[]): void {
  if (schema.type && !matchesType(value, schema.type)) {
    issues.push({ path, message: `expected ${schema.type}` });
    return;
  }

  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) {
    issues.push({ path, message: `must be one of: ${schema.enum.join(', ')}` });
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ path, message: `shorter than minLength ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({ path, message: `longer than maxLength ${schema.maxLength}` });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      issues.push({ path, message: `does not match pattern ${schema.pattern}` });
    }
    if (schema.format === 'email' && !EMAIL.test(value)) {
      issues.push({ path, message: 'not a valid email address' });
    }
    if (schema.format === 'date-time' && !DATE_TIME.test(value)) {
      issues.push({ path, message: 'not an ISO 8601 date-time' });
    }
    if (schema.format === 'uri' && !/^https?:\/\/\S+$/.test(value)) {
      issues.push({ path, message: 'not an http(s) URI' });
    }
  }

  if (typeof value === 'number') {
    if (schema.type === 'integer' && !Number.isInteger(value)) {
      issues.push({ path, message: 'expected integer' });
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, message: `below minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path, message: `above maximum ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ path, message: `fewer than minItems ${schema.minItems}` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ path, message: `more than maxItems ${schema.maxItems}` });
    }
    if (schema.items) {
      value.forEach((item, i) => check(item, schema.items!, `${path}[${i}]`, issues));
    }
  }

  if (isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined || value[key] === null) {
        issues.push({ path: `${path}.${key}`, message: 'required' });
      }
    }
    const known = new Set(Object.keys(schema.properties ?? {}));
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key];
      if (childSchema) {
        check(child, childSchema, `${path}.${key}`, issues);
      } else if (schema.additionalProperties === false) {
        // Not cosmetic: an unknown property is how a model smuggles an
        // unvalidated field past the tool layer into a CRM write.
        issues.push({
          path: `${path}.${key}`,
          message: `unknown property (allowed: ${[...known].join(', ') || 'none'})`,
        });
      }
    }
  }
}

function matchesType(value: unknown, type: NonNullable<JsonSchema['type']>): boolean {
  switch (type) {
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertValid(value: unknown, schema: JsonSchema, label: string): void {
  const outcome = validate(value, schema);
  if (!outcome.valid) {
    const detail = outcome.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
    throw new Error(`${label} failed schema validation: ${detail}`);
  }
}
