/** Injectable clock. Nothing in the governance layer reads the wall clock directly. */
export interface Clock {
  now(): Date;
  nowMs(): number;
  iso(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
  iso: () => new Date().toISOString(),
};

export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date { return new Date(this.current.getTime()); }
  nowMs(): number { return this.current.getTime(); }
  iso(): string { return this.current.toISOString(); }
  advance(ms: number): void { this.current = new Date(this.current.getTime() + ms); }
  set(date: Date): void { this.current = new Date(date.getTime()); }
}
