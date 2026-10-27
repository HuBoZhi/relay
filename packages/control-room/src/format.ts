/**
 * Time and label helpers shared by both data sources.
 *
 * Every timestamp the room reports is rendered in one timezone so a message's
 * `day` grouping and its `HH:MM:SS` cannot disagree. The room defaults to
 * Beijing time (UTC+8) as the interface requirements demand; self-hosted
 * deployments can override it through `RELAY_CONTROL_ROOM_TZ`.
 */

export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

export function resolveTimezone(explicit?: string): string {
  const value = explicit?.trim() || process.env.RELAY_CONTROL_ROOM_TZ?.trim();
  if (!value) return DEFAULT_TIMEZONE;
  try {
    // Throws on an unknown zone; failing now beats emitting `Invalid Date`.
    new Intl.DateTimeFormat('zh-CN', { timeZone: value });
    return value;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const next = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  formatters.set(timeZone, next);
  return next;
}

/** Normalize a `Date`, ISO string, or epoch number to an ISO-8601 string. */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export interface ZonedStamp {
  /** `2026-10-26` */
  day: string;
  /** `14:32:06`, 24-hour */
  time: string;
}

/** Split an instant into its room-timezone calendar day and wall clock. */
export function zonedStamp(value: unknown, timeZone: string): ZonedStamp | null {
  const iso = toIso(value);
  if (!iso) return null;
  const parts = formatterFor(timeZone).formatToParts(new Date(iso));
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const day = `${pick('year')}-${pick('month')}-${pick('day')}`;
  const hour = pick('hour').padStart(2, '0');
  const time = `${hour}:${pick('minute')}:${pick('second')}`;
  if (day.length !== 10 || time.length !== 8) return null;
  return { day, time };
}

/** `2026-10-26` for "today" in the room timezone, used for day filters. */
export function zonedToday(timeZone: string, now: Date = new Date()): string {
  return zonedStamp(now, timeZone)?.day ?? '';
}

/** Add whole days to a room-timezone calendar day (`2026-10-26` → `2026-10-25`). */
export function shiftDay(day: string, deltaDays: number): string {
  const base = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return day;
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return base.toISOString().slice(0, 10);
}

/**
 * Chinese relative time for "recent activity".
 *
 * Falls back to an absolute room-timezone stamp beyond a day so a stale agent
 * cannot keep claiming it was active "23 小时前".
 */
export function relativeLabel(value: unknown, timeZone: string, now: number = Date.now()): string {
  const iso = toIso(value);
  if (!iso) return '暂无数据';
  const deltaMs = now - new Date(iso).getTime();
  if (deltaMs < 0) return '刚刚';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const stamp = zonedStamp(iso, timeZone);
  return stamp ? `${stamp.day.replaceAll('-', '.')} ${stamp.time.slice(0, 5)}` : '暂无数据';
}

/**
 * Localized display name for a workspace object.
 *
 * Real deployments differ in where a Chinese label lives, so accept the common
 * metadata keys. When none exists the identifier is shown unchanged — the room
 * never machine-translates user content or renames someone's agent.
 */
export function displayNameOf(name: string, metadata?: Record<string, unknown> | null): string {
  if (metadata) {
    for (const key of ['displayName', 'display_name', 'nameZh', 'name_zh', 'label'] as const) {
      const candidate = metadata[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  }
  return name;
}

/** Shorten long free text for single-line captions. */
export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Turn a transport/SDK diagnostic into a Chinese caption.
 *
 * The room must never print `fetch failed` or `connect ECONNREFUSED …` at an
 * operator: the interface is Chinese end to end (requirements §3, R09), and an
 * English stack fragment tells the reader nothing a plain phrase would not. The
 * known failures are named, whatever Latin text is left is dropped, and the raw
 * string stays available to the caller for logs only.
 */
const DIAGNOSTIC_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/ECONNREFUSED|connection refused/i, '服务拒绝连接'],
  [/ENOTFOUND|EAI_AGAIN|getaddrinfo|dns/i, '无法解析服务地址'],
  [/ETIMEDOUT|timed?\s*out|timeout/i, '连接超时'],
  [/ECONNRESET|EPIPE|socket hang up|network error/i, '连接被中断'],
  [/ENETUNREACH|ENETDOWN|network is unreachable/i, '网络不可达'],
  [/fetch failed|load failed|failed to fetch/i, '网络请求失败'],
  [/CERT_|self.signed|certificate|SSL|TLS/i, '安全连接建立失败'],
  [/unauthori[sz]ed|invalid (?:token|api key)|401/, '凭据无效或已过期'],
  [/forbidden|403/, '凭据权限不足'],
  [/too many requests|rate limit|429/i, '请求过于频繁'],
  [/aborted|abort(?:ed)? the request/i, '请求已取消'],
];

// Bare status codes are the vaguest signal available, so they are only used when
// nothing more specific matched — `401` must read as a credential problem, not as
// "the server said no".
const STATUS_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b5\d\d\b/, '服务端返回错误'],
  [/\b4\d\d\b/, '请求被服务端拒绝'],
];

export function localizeDiagnostic(text: unknown, fallback = '读取失败'): string {
  const raw = typeof text === 'string' ? text : text instanceof Error ? text.message : '';
  const hits: string[] = [];
  for (const [pattern, label] of DIAGNOSTIC_RULES) {
    if (pattern.test(raw) && !hits.includes(label)) hits.push(label);
  }
  if (hits.length === 0) {
    for (const [pattern, label] of STATUS_RULES) {
      if (pattern.test(raw)) {
        hits.push(label);
        break;
      }
    }
  }
  // Keep any Chinese the caller already wrote ("读取频道失败：…"), drop Latin.
  const chinese = raw
    .replace(/[A-Za-z][A-Za-z0-9_.:-]*/g, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[，、]{2,}/g, '，')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:：,，.。;；\-–—_/\\|]+|[\s:：,，;；\-–—_/\\|]+$/g, '');
  const parts = [...hits];
  if (/[\u4e00-\u9fa5]/.test(chinese)) parts.push(chinese);
  const caption = parts.join('；');
  return truncate(caption || fallback, 60);
}
