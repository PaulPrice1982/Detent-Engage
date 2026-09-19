import { AwaError, type Clock, systemClock } from '@detent/awa-core';
import { canonicalJson, type AuditLog } from '@detent/awa-audit';
import type { AuthoredDocument } from './authoring.js';
import type { CompiledPolicy } from './authoring.js';

/**
 * Immutable playbook versioning with diff and one-action rollback (FR-040).
 *
 * Every publish creates an immutable version with an author, a timestamp and a
 * diff against the prior version. Rollback is instant and requires no redeploy,
 * consistent with NFR-018, and any prior version must be restorable within 60
 * seconds, which is why restoring is a pointer move, not a replay.
 *
 * Conversations record the playbook version alongside the prompt, policy and
 * model versions, so any past outcome is explicable.
 */
export interface PlaybookVersion {
  readonly tenantId: string;
  readonly version: number;
  readonly document: AuthoredDocument;
  readonly compiled: CompiledPolicy;
  readonly author: string;
  readonly publishedAt: string;
  readonly note?: string;
  /** Simulation scorecard that permitted the publish. Absent means blocked. */
  readonly simulationRunId?: string;
  /** Set when this version was created by restoring an earlier one. */
  readonly restoredFrom?: number;
}

export interface VersionDiffEntry {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface VersionDiff {
  readonly from: number;
  readonly to: number;
  readonly changes: readonly VersionDiffEntry[];
}

export class PlaybookVersionStore {
  private readonly versions = new Map<string, PlaybookVersion[]>();
  private readonly active = new Map<string, number>();

  constructor(
    private readonly audit: AuditLog,
    private readonly clock: Clock = systemClock,
  ) {}

  async publish(input: {
    tenantId: string;
    document: AuthoredDocument;
    compiled: CompiledPolicy;
    author: string;
    correlationId: string;
    note?: string;
    simulationRunId?: string;
    restoredFrom?: number;
  }): Promise<PlaybookVersion> {
    const list = this.versions.get(input.tenantId) ?? [];
    const version: PlaybookVersion = {
      tenantId: input.tenantId,
      version: list.length + 1,
      document: input.document,
      compiled: input.compiled,
      author: input.author,
      publishedAt: this.clock.iso(),
      note: input.note,
      simulationRunId: input.simulationRunId,
      restoredFrom: input.restoredFrom,
    };
    list.push(version);
    this.versions.set(input.tenantId, list);
    this.active.set(input.tenantId, version.version);

    const previous = list[list.length - 2];
    await this.audit.write({
      tenantId: input.tenantId,
      type: 'policy_allowed',
      correlationId: input.correlationId,
      actor: 'tenant_admin',
      payload: {
        change: 'playbook_published',
        version: version.version,
        author: input.author,
        restoredFrom: input.restoredFrom,
        simulationRunId: input.simulationRunId,
        changeCount: previous ? diff(previous, version).changes.length : undefined,
      },
    });

    return version;
  }

  list(tenantId: string): PlaybookVersion[] {
    return [...(this.versions.get(tenantId) ?? [])];
  }

  get(tenantId: string, version: number): PlaybookVersion {
    const found = (this.versions.get(tenantId) ?? []).find((entry) => entry.version === version);
    if (!found) {
      throw new AwaError({ kind: 'NOT_FOUND', message: `playbook version ${version} not found for tenant ${tenantId}` });
    }
    return found;
  }

  activeVersion(tenantId: string): PlaybookVersion | undefined {
    const version = this.active.get(tenantId);
    return version === undefined ? undefined : this.get(tenantId, version);
  }

  diffAgainstPrevious(tenantId: string, version: number): VersionDiff | undefined {
    if (version <= 1) return undefined;
    return diff(this.get(tenantId, version - 1), this.get(tenantId, version));
  }

  /**
   * One-action rollback. Publishes the earlier document as a *new* version
   * rather than rewinding the history: an audit trail with a hole in it is not
   * an audit trail, and "we rolled back to version 3" is itself an event a
   * reviewer needs to see.
   *
   * A restore does not re-run simulation, deliberately, the version being
   * restored already passed it, and requiring a fresh run would put a delay
   * between an operator deciding to roll back and the rollback happening.
   */
  async restore(tenantId: string, version: number, author: string, correlationId: string): Promise<PlaybookVersion> {
    const target = this.get(tenantId, version);
    return this.publish({
      tenantId,
      document: target.document,
      compiled: target.compiled,
      author,
      correlationId,
      note: `Restored from version ${version}`,
      simulationRunId: target.simulationRunId,
      restoredFrom: version,
    });
  }
}

/**
 * Structural diff over the authored document. Field-level rather than textual,
 * so "escalation.confidenceFloor 0.65 → 0.4" reads as the safety-relevant
 * change it is rather than as a line in a JSON blob.
 */
export function diff(from: PlaybookVersion, to: PlaybookVersion): VersionDiff {
  const changes: VersionDiffEntry[] = [];
  walk(from.document as unknown, to.document as unknown, '', changes);
  return { from: from.version, to: to.version, changes };
}

function walk(before: unknown, after: unknown, path: string, changes: VersionDiffEntry[]): void {
  if (canonicalJson(before ?? null) === canonicalJson(after ?? null)) return;

  const bothObjects =
    typeof before === 'object' && before !== null && !Array.isArray(before) &&
    typeof after === 'object' && after !== null && !Array.isArray(after);

  if (!bothObjects) {
    changes.push({ path: path || '$', before, after });
    return;
  }

  const keys = new Set([
    ...Object.keys(before as Record<string, unknown>),
    ...Object.keys(after as Record<string, unknown>),
  ]);
  for (const key of [...keys].sort()) {
    walk(
      (before as Record<string, unknown>)[key],
      (after as Record<string, unknown>)[key],
      path ? `${path}.${key}` : key,
      changes,
    );
  }
}
