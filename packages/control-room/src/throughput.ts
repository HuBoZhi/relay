/**
 * Observed message throughput.
 *
 * The room charts only what this server actually saw arrive. That keeps the
 * number checkable — and keeps it from implying a historical metric the
 * deployment never exposed.
 */

import { toIso } from './format.js';
import type { ThroughputView } from './types.js';

export interface ThroughputOptions {
  bucketMinutes?: number;
  windowMinutes?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class ThroughputTracker {
  readonly bucketMinutes: number;
  readonly windowMinutes: number;
  private readonly counts = new Map<number, number>();
  private readonly now: () => number;

  constructor(options: ThroughputOptions = {}) {
    this.bucketMinutes = Math.max(1, Math.floor(options.bucketMinutes ?? 1));
    this.windowMinutes = Math.max(this.bucketMinutes, Math.floor(options.windowMinutes ?? 12));
    this.now = options.now ?? Date.now;
  }

  private bucketKey(at: number): number {
    const width = this.bucketMinutes * 60_000;
    return Math.floor(at / width) * width;
  }

  /** Count one observed message. */
  record(at?: unknown): void {
    const iso = toIso(at);
    const when = iso ? new Date(iso).getTime() : this.now();
    const key = this.bucketKey(when);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.prune();
  }

  private prune(): void {
    const oldest = this.bucketKey(this.now()) - this.windowMinutes * 60_000;
    for (const key of this.counts.keys()) {
      if (key < oldest) this.counts.delete(key);
    }
  }

  /** Buckets oldest → newest, zero-filled inside the window. */
  snapshot(): ThroughputView {
    const width = this.bucketMinutes * 60_000;
    const newest = this.bucketKey(this.now());
    const buckets = Math.floor(this.windowMinutes / this.bucketMinutes);
    const points = [] as ThroughputView['points'];
    let total = 0;
    for (let index = buckets - 1; index >= 0; index -= 1) {
      const key = newest - index * width;
      const count = this.counts.get(key) ?? 0;
      total += count;
      points.push({ at: new Date(key).toISOString(), count });
    }
    return {
      bucketMinutes: this.bucketMinutes,
      windowMinutes: this.windowMinutes,
      points,
      total,
      source: 'stream',
    };
  }
}
