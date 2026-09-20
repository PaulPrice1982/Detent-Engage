/**
 * What must be true before this process is allowed to serve.
 *
 * The distinction this file exists for: a development machine may run the
 * whole platform on in-memory stores, and a deployment may not. The in-memory
 * stores lose the audit chain, the consent evidence and the spend counters at
 * every restart, so a deployment that quietly falls back to them is a product
 * that tells a customer their consent was recorded and then forgets.
 *
 * Nothing here exits the process. A deployment that exits is restarted by its
 * platform, called a crash loop, and the reason ends up in a log somebody has
 * to go and find; the three deployments this was written after all presented
 * as "built successfully but failed to start". The caller serves these reasons
 * instead, which puts them in a browser where the operator already is.
 */

/**
 * Model ids this release is known to work against.
 *
 * An allow-list rather than a default, because a hard-coded model id is a
 * guess that becomes wrong silently: the provider returns 404 for a name that
 * has been retired, and the assistant is simply unavailable with no indication
 * that a string in a source file is the reason.
 */
export const SUPPORTED_MODELS: readonly string[] = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5-1',
  'claude-haiku-4-5-20251001',
];

export interface BootEnvironment {
  readonly deployed: boolean;
  readonly databaseUrl?: string;
  readonly rootKey?: string;
  readonly checkpointKey?: string;
  readonly modelKey?: string;
  readonly model?: string;
  /**
   * The speech vendor key, for the spoken assistant.
   *
   * Held here beside the model key and treated the same way: read from the
   * environment, never printed, never written to an audit payload. It is
   * optional because voice is optional; a deployment that does not set it
   * serves the text assistant, which is the full product and not a degraded
   * one.
   */
  readonly voiceKey?: string;
  /** Which vendor voice speaks. Defaults to the English assistant voice. */
  readonly voiceId?: string;
  /** Whether this deployment offers a spoken assistant at all. */
  readonly spokenVoice: boolean;
  readonly origins: readonly string[];
  readonly allowLocalKey: boolean;
  readonly printKeys: boolean;
}

export function bootEnvironmentFrom(
  env: Record<string, string | undefined> = process.env,
): BootEnvironment {
  const flag = (name: string): boolean => env[name]?.trim() === '1' || env[name]?.trim() === 'true';
  // Either marker, so a container that sets only its platform's own variable is
  // still treated as a deployment rather than as somebody's laptop.
  const deployed = flag('DETENT_DEPLOYED') || flag('REPLIT_DEPLOYMENT')
    || env['NODE_ENV']?.trim() === 'production';
  return {
    deployed,
    databaseUrl: env['DATABASE_URL']?.trim() || undefined,
    rootKey: env['AWA_ROOT_KEY']?.trim() || undefined,
    checkpointKey: env['AWA_CHECKPOINT_KEY']?.trim() || undefined,
    modelKey: env['ANTHROPIC_API_KEY']?.trim() || undefined,
    model: env['AWA_MODEL']?.trim() || undefined,
    voiceKey: env['DETENT_VOICE_API_KEY']?.trim() || undefined,
    voiceId: env['DETENT_VOICE_ID']?.trim() || undefined,
    spokenVoice: flag('AWA_FEATURE_SPOKEN_VOICE'),
    origins: (env['AWA_ORIGINS'] ?? '').split(',').map((one) => one.trim()).filter(Boolean),
    allowLocalKey: flag('AWA_ALLOW_LOCAL_KEY'),
    // Keys are stored as digests, so boot is the only moment they exist in
    // readable form. Printing them is a development convenience and never
    // something a deployment should do into its platform's log aggregator.
    //
    // Gated on `deployed`, not on NODE_ENV alone: a hosting platform that marks
    // a deployment with its own variable and leaves NODE_ENV unset would
    // otherwise print three live keys into its logs on every boot.
    printKeys: flag('AWA_DEV_PRINT_KEYS') && !deployed,
  };
}

/**
 * Everything wrong with the configuration, in the operator's words.
 *
 * All of them, not the first: an operator who fixes one missing variable,
 * redeploys, and is told about the next one has to redeploy as many times as
 * there are problems, and each round is minutes of a site being down.
 */
export function configurationProblems(boot: BootEnvironment): string[] {
  const problems: string[] = [];
  if (!boot.deployed) return problems;

  if (!boot.databaseUrl) {
    problems.push(
      'DATABASE_URL is not set. Without it every store is in memory, so the audit '
      + 'chain, consent evidence and spend counters would be lost at the next restart.',
    );
  }
  if (!boot.rootKey && !boot.allowLocalKey) {
    problems.push(
      'AWA_ROOT_KEY is not set. It encrypts the CRM credentials at rest; a generated '
      + 'one would change at every restart and make the stored credentials unreadable. '
      + 'Print one with: node tools/make-secret.mjs root',
    );
  }
  if (!boot.checkpointKey) {
    problems.push(
      'AWA_CHECKPOINT_KEY is not set. It signs the audit checkpoints, which are the '
      + 'evidence that the audit chain has not been rewritten.',
    );
  }
  if (!boot.modelKey) {
    problems.push(
      'ANTHROPIC_API_KEY is not set. Without it the assistant cannot answer, and a '
      + 'deployment must not fall back to the scripted development provider.',
    );
  }
  if (boot.spokenVoice && !boot.voiceKey) {
    problems.push(
      'AWA_FEATURE_SPOKEN_VOICE is on but DETENT_VOICE_API_KEY is not set, so the panel '
      + 'would offer a microphone that produces no sound. Set the key, or turn the '
      + 'feature off: the text assistant is the whole product and not a degraded one.',
    );
  }
  if (boot.origins.length === 0) {
    problems.push(
      'AWA_ORIGINS is not set. Widget keys are bound to an origin, so with no origins '
      + 'registered every widget request is refused.',
    );
  }
  if (boot.model !== undefined && !SUPPORTED_MODELS.includes(boot.model)) {
    problems.push(
      `AWA_MODEL is set to "${boot.model}", which this release has not been verified `
      + `against. Supported: ${SUPPORTED_MODELS.join(', ')}.`,
    );
  }
  if (boot.model === undefined) {
    problems.push(
      'AWA_MODEL is not set. The model id is pinned by configuration rather than '
      + `defaulted in code, so that an invoice and an audit entry name a model somebody `
      + `chose. Supported: ${SUPPORTED_MODELS.join(', ')}.`,
    );
  }
  return problems;
}

/**
 * Whether the database named in DATABASE_URL actually answers.
 *
 * Set and unreachable is the commonest deployment fault there is, and it is
 * indistinguishable from correct configuration until something tries to read.
 * Probed once at boot so it is reported as a configuration problem with the
 * others, rather than surfacing later as a missing relation from whichever
 * store happened to query first.
 */
export async function databaseProblem(
  databaseUrl: string | undefined,
  probe: (url: string) => Promise<boolean>,
): Promise<string | undefined> {
  if (!databaseUrl) return undefined;
  let reachable: boolean;
  try {
    reachable = await probe(databaseUrl);
  } catch {
    reachable = false;
  }
  if (reachable) return undefined;
  // The host and port, never the URL: a connection string carries a password,
  // and a password on a status page is a password in a screenshot.
  let where = 'the configured host';
  try {
    const parsed = new URL(databaseUrl);
    where = `${parsed.hostname}:${parsed.port || '5432'}`;
  } catch {
    return 'DATABASE_URL is not a URL this can parse, so no database can be reached.';
  }
  return (
    `The database at ${where} did not answer. DATABASE_URL is set, so this is a `
    + 'reachable-database problem rather than a missing setting: check the host, the '
    + 'port, and whether this service is allowed through to it.'
  );
}
