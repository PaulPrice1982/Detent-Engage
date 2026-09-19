/**
 * Structured logging (audit finding SEC-10).
 *
 * The 500 path used to swallow every unexpected error into `{error:'INTERNAL'}`
 * with nothing written anywhere, which leaves an operator blind during exactly
 * the incident the audit trail was built for. Every log line here is a single
 * JSON object on one line, carries a correlation id, and is redacted with the
 * same `redactObject` the audit log uses, so a credential cannot reach a log
 * by a route the audit writer already closes.
 */
import { redactObject } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  readonly correlationId?: string;
  readonly tenantId?: string;
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A child logger whose fields are merged into every line it writes. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly service?: string;
  /** Injectable so tests capture lines instead of writing to stdout. */
  readonly sink?: (line: string) => void;
  readonly clock?: () => string;
}

export class JsonLogger implements Logger {
  private readonly level: LogLevel;
  private readonly sink: (line: string) => void;
  private readonly now: () => string;
  private readonly base: LogFields;

  constructor(options: LoggerOptions = {}, base: LogFields = {}) {
    this.level = options.level ?? 'info';
    this.sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
    this.now = options.clock ?? (() => new Date().toISOString());
    this.base = options.service ? { service: options.service, ...base } : base;
  }

  child(fields: LogFields): Logger {
    const child = new JsonLogger(
      { level: this.level, sink: this.sink, clock: this.now },
      { ...this.base, ...fields },
    );
    return child;
  }

  debug(message: string, fields?: LogFields): void { this.write('debug', message, fields); }
  info(message: string, fields?: LogFields): void { this.write('info', message, fields); }
  warn(message: string, fields?: LogFields): void { this.write('warn', message, fields); }
  error(message: string, fields?: LogFields): void { this.write('error', message, fields); }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const merged = { ...this.base, ...(fields ?? {}) };
    // Redacted on the way out, not at the call site: a log line is the easiest
    // place in a system to leak a credential by accident.
    const safe = redactObject(merged) as Record<string, unknown>;
    let line: string;
    try {
      line = JSON.stringify({ at: this.now(), level, message, ...safe });
    } catch {
      line = JSON.stringify({ at: this.now(), level, message, fields: '[unserialisable]' });
    }
    this.sink(line);
  }
}

/** A logger that discards everything. The default in tests and libraries. */
export const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
};

/** Describe an unknown thrown value without leaking a stack to a response. */
export function describeError(cause: unknown): { message: string; stack?: string; name?: string } {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message, stack: cause.stack };
  }
  return { message: String(cause) };
}
