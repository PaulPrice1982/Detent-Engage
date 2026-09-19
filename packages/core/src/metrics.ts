/**
 * Minimal metrics registry with Prometheus text exposition (audit SEC-10).
 *
 * The operations runbook states latency and cost-of-goods targets; until
 * something emits them they are aspirations, not NFRs. This is deliberately
 * dependency-free: counters, gauges and histograms with fixed buckets, rendered
 * in the text format every scraper understands.
 */
export type Labels = Readonly<Record<string, string>>;

const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];

interface Series {
  readonly name: string;
  readonly help: string;
  readonly type: 'counter' | 'gauge' | 'histogram';
  readonly values: Map<string, number>;
  readonly buckets?: readonly number[];
  readonly sums?: Map<string, number>;
  readonly counts?: Map<string, number>;
}

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((key) => `${key}=${JSON.stringify(labels[key])}`).join(',');
}

function renderLabels(key: string, extra?: string): string {
  const parts = [key, extra].filter((part) => part && part.length > 0);
  return parts.length ? `{${parts.join(',')}}` : '';
}

export class MetricsRegistry {
  private readonly series = new Map<string, Series>();

  private ensure(name: string, help: string, type: Series['type'], buckets?: readonly number[]): Series {
    let series = this.series.get(name);
    if (!series) {
      series = {
        name, help, type,
        values: new Map(),
        buckets,
        sums: type === 'histogram' ? new Map() : undefined,
        counts: type === 'histogram' ? new Map() : undefined,
      };
      this.series.set(name, series);
    }
    return series;
  }

  counter(name: string, help: string, labels: Labels = {}, by = 1): void {
    const series = this.ensure(name, help, 'counter');
    const key = labelKey(labels);
    series.values.set(key, (series.values.get(key) ?? 0) + by);
  }

  gauge(name: string, help: string, value: number, labels: Labels = {}): void {
    const series = this.ensure(name, help, 'gauge');
    series.values.set(labelKey(labels), value);
  }

  observe(name: string, help: string, value: number, labels: Labels = {}, buckets: readonly number[] = DEFAULT_BUCKETS): void {
    const series = this.ensure(name, help, 'histogram', buckets);
    const key = labelKey(labels);
    for (const bucket of series.buckets ?? buckets) {
      const bucketKey = `${key}|${bucket}`;
      if (value <= bucket) series.values.set(bucketKey, (series.values.get(bucketKey) ?? 0) + 1);
      else if (!series.values.has(bucketKey)) series.values.set(bucketKey, series.values.get(bucketKey) ?? 0);
    }
    series.sums!.set(key, (series.sums!.get(key) ?? 0) + value);
    series.counts!.set(key, (series.counts!.get(key) ?? 0) + 1);
  }

  /** Time an async operation, recording duration and outcome. */
  async time<T>(name: string, help: string, labels: Labels, fn: () => Promise<T>, now: () => number = () => Date.now()): Promise<T> {
    const started = now();
    try {
      const result = await fn();
      this.observe(name, help, now() - started, { ...labels, outcome: 'ok' });
      return result;
    } catch (cause) {
      this.observe(name, help, now() - started, { ...labels, outcome: 'error' });
      throw cause;
    }
  }

  /** Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];
    for (const series of this.series.values()) {
      lines.push(`# HELP ${series.name} ${series.help}`);
      lines.push(`# TYPE ${series.name} ${series.type}`);
      if (series.type === 'histogram') {
        for (const [key, count] of series.counts!) {
          let cumulative = 0;
          for (const bucket of series.buckets ?? DEFAULT_BUCKETS) {
            cumulative = series.values.get(`${key}|${bucket}`) ?? cumulative;
            lines.push(`${series.name}_bucket${renderLabels(key, `le="${bucket}"`)} ${cumulative}`);
          }
          lines.push(`${series.name}_bucket${renderLabels(key, 'le="+Inf"')} ${count}`);
          lines.push(`${series.name}_sum${renderLabels(key)} ${series.sums!.get(key) ?? 0}`);
          lines.push(`${series.name}_count${renderLabels(key)} ${count}`);
        }
        continue;
      }
      for (const [key, value] of series.values) {
        lines.push(`${series.name}${renderLabels(key)} ${value}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  reset(): void { this.series.clear(); }
}

/** The process-wide registry. Injected everywhere it is used, so tests isolate. */
export const metrics = new MetricsRegistry();
