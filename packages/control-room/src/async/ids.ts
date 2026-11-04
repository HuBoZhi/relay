/**
 * Identifier, slug, and path helpers.
 *
 * Ids are prefixed so a log line or a receipt can be read without the schema
 * open: `task_01H…` is never confused with `run_…`. Prefixes also let the store
 * rebuild indexes by scanning keys.
 */

import { createHash, randomUUID } from 'node:crypto';
import { basename, normalize, resolve } from 'node:path';

const PREFIX = {
  topic: 'top',
  task: 'task',
  stage: 'stg',
  run: 'run',
  message: 'msg',
  callback: 'cb',
} as const;

export type IdKind = keyof typeof PREFIX;

/** Time-ordered enough for a single-machine store, unique across restarts. */
export function createId(kind: IdKind): string {
  return `${PREFIX[kind]}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Stable key for an arbitrary JSON payload.
 *
 * Key order is normalised so two structurally identical submits hash the same
 * way; otherwise a client that serialises its body differently on retry would
 * create a duplicate task.
 */
export function stableHash(value: unknown): string {
  return sha256(JSON.stringify(canonical(value)));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item === undefined) continue;
      out[key] = canonical(item);
    }
    return out;
  }
  return value;
}

const SLUG_MAX = 48;

/**
 * ASCII mapping for a display name.
 *
 * Topic names are user text — `20261104-MediaDock-需求开发2` is a valid name —
 * but some channels only accept ASCII. Keeping both means the user never has to
 * transliterate, and the mapping stays stable for the same name.
 */
export function topicSlug(name: string): string {
  const trimmed = name.trim();
  const ascii = trimmed
    .replace(/[^\x20-\x7e]/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  // A name that is entirely non-ASCII keeps a short hash so two different
  // Chinese names cannot collapse onto the same empty slug.
  const readable = ascii.length > 0 ? ascii.slice(0, SLUG_MAX) : `topic-${sha256(trimmed).slice(0, 8)}`;
  return readable.toLowerCase();
}

/**
 * Canonical form of a working directory for comparison.
 *
 * Windows paths arrive with either separator and any casing; `C:\Work\App` and
 * `c:/work/app/` are the same directory, and treating them as two roots is how
 * a duplicate workspace gets created.
 */
export function normalizePathForComparison(
  path: string,
  platform: NodeJS.Platform = process.platform
): string {
  const absolute = resolve(normalize(path)).replace(/\\/g, '/');
  const collapsed = absolute.replace(/\/{2,}/g, '/');
  const withoutTrailing = collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
  return platform === 'win32' ? withoutTrailing.toLowerCase() : withoutTrailing;
}

export function samePath(a: string, b: string, platform?: NodeJS.Platform): boolean {
  return normalizePathForComparison(a, platform) === normalizePathForComparison(b, platform);
}

/** Last path segment, for a compact project label in the UI. */
export function projectLabel(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return basename(trimmed) || trimmed;
}
