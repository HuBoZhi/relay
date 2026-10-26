import { describe, expect, it } from 'vitest';

import { displayNameOf, relativeLabel, shiftDay, toIso, zonedStamp, zonedToday } from '../format.js';
import { ThroughputTracker } from '../throughput.js';

const BEIJING = 'Asia/Shanghai';

describe('zonedStamp', () => {
  it('renders a UTC instant in Beijing time', () => {
    expect(zonedStamp('2026-10-26T06:32:08Z', BEIJING)).toEqual({ day: '2026-10-26', time: '14:32:08' });
  });

  it('crosses the calendar day at midnight Beijing time', () => {
    expect(zonedStamp('2026-10-26T16:30:00Z', BEIJING)).toEqual({ day: '2026-10-27', time: '00:30:00' });
  });

  it('returns null for a missing or invalid timestamp', () => {
    expect(zonedStamp(undefined, BEIJING)).toBeNull();
    expect(zonedStamp('not-a-date', BEIJING)).toBeNull();
  });
});

describe('toIso', () => {
  it('accepts strings, Dates, and epoch values', () => {
    expect(toIso('2026-10-26T06:32:08Z')).toBe('2026-10-26T06:32:08.000Z');
    expect(toIso(new Date('2026-10-26T06:32:08Z'))).toBe('2026-10-26T06:32:08.000Z');
    expect(toIso(Date.UTC(2026, 9, 26, 6, 32, 8))).toBe('2026-10-26T06:32:08.000Z');
  });

  it('returns null instead of inventing a time', () => {
    expect(toIso('')).toBeNull();
    expect(toIso(null)).toBeNull();
    expect(toIso({})).toBeNull();
  });
});

describe('shiftDay', () => {
  it('walks calendar days', () => {
    expect(shiftDay('2026-10-26', -1)).toBe('2026-10-25');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('zonedToday', () => {
  it('uses the room timezone, not the host one', () => {
    expect(zonedToday(BEIJING, new Date('2026-10-26T16:30:00Z'))).toBe('2026-10-27');
  });
});

describe('relativeLabel', () => {
  const now = Date.parse('2026-10-26T06:32:00Z');

  it('describes recent activity in Chinese', () => {
    expect(relativeLabel('2026-10-26T06:31:40Z', BEIJING, now)).toBe('刚刚');
    expect(relativeLabel('2026-10-26T06:27:00Z', BEIJING, now)).toBe('5 分钟前');
    expect(relativeLabel('2026-10-26T04:32:00Z', BEIJING, now)).toBe('2 小时前');
  });

  it('falls back to an absolute stamp beyond a day', () => {
    expect(relativeLabel('2026-10-24T02:00:00Z', BEIJING, now)).toBe('2026.10.24 10:00');
  });
});

describe('displayNameOf', () => {
  it('prefers a localized metadata label and keeps the identifier otherwise', () => {
    expect(displayNameOf('coder-alpha', { displayName: '开发甲' })).toBe('开发甲');
    expect(displayNameOf('coder-alpha', { nameZh: '开发乙' })).toBe('开发乙');
    expect(displayNameOf('coder-alpha', {})).toBe('coder-alpha');
    expect(displayNameOf('coder-alpha', null)).toBe('coder-alpha');
  });
});

describe('ThroughputTracker', () => {
  it('buckets observed messages per minute and zero-fills the window', () => {
    let clock = Date.parse('2026-10-26T06:32:00Z');
    const tracker = new ThroughputTracker({ bucketMinutes: 1, windowMinutes: 5, now: () => clock });
    tracker.record('2026-10-26T06:31:10Z');
    tracker.record('2026-10-26T06:31:50Z');
    tracker.record('2026-10-26T06:32:00Z');
    const snapshot = tracker.snapshot();
    expect(snapshot.points).toHaveLength(5);
    expect(snapshot.total).toBe(3);
    expect(snapshot.points.at(-1)?.count).toBe(1);
    expect(snapshot.points.at(-2)?.count).toBe(2);

    clock += 10 * 60_000;
    expect(tracker.snapshot().total).toBe(0);
  });
});
