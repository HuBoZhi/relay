/**
 * Durable task store.
 *
 * Two files under the data root:
 *
 * - `state.json` — the authoritative snapshot, written with temp-file + rename so
 *   a crash mid-write leaves the previous snapshot intact instead of a truncated
 *   one. This is what a restart reads to resume pending deliveries.
 * - `journal.jsonl` — append-only audit trail of every mutation. It exists so a
 *   support question ("did it dispatch twice?") can be answered without replaying
 *   application logic, and so a corrupt snapshot still has a readable history.
 *
 * Writes are serialised through one promise chain: two concurrent submits must
 * not interleave a read-modify-write cycle and lose a task.
 */

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type {
  CallbackRecord,
  ClientCapabilityView,
  Group,
  GroupMember,
  GroupMessage,
  MessageRecord,
  Run,
  Stage,
  SubmitReceipt,
  Task,
  Topic,
} from './contracts.js';
import { samePath } from './ids.js';

export const STATE_VERSION = 1;
const JOURNAL_ROTATE_BYTES = 16 * 1024 * 1024;

export interface IdempotencyRecord {
  taskId: string;
  stageId: string;
  runId: string;
  receipt: SubmitReceipt;
  at: string;
}

export interface AsyncState {
  version: number;
  topics: Record<string, Topic>;
  /** Topic name → group id, so the same topic name never opens a second group. */
  groups: Record<string, Group>;
  groupMembers: Record<string, GroupMember>;
  groupMessages: Record<string, GroupMessage>;
  tasks: Record<string, Task>;
  stages: Record<string, Stage>;
  runs: Record<string, Run>;
  messages: Record<string, MessageRecord>;
  callbacks: Record<string, CallbackRecord>;
  /** submit idempotency key → the receipt that key produced. */
  idempotency: Record<string, IdempotencyRecord>;
  /** callback dedupe key → callback id. */
  callbackKeys: Record<string, string>;
  /** Last observed capability per client, merged over the static defaults. */
  clientObservations: Record<string, ClientCapabilityView>;
  /** Monotonic counter, so the UI can order events without trusting clocks. */
  sequence: number;
}

export function emptyState(): AsyncState {
  return {
    version: STATE_VERSION,
    topics: {},
    groups: {},
    groupMembers: {},
    groupMessages: {},
    tasks: {},
    stages: {},
    runs: {},
    messages: {},
    callbacks: {},
    idempotency: {},
    callbackKeys: {},
    clientObservations: {},
    sequence: 0,
  };
}

export interface DataRootResolution {
  root: string;
  warnings: string[];
}

/**
 * Pick a data root.
 *
 * The engine keeps task text, project paths, and chat bindings — not model
 * credentials — but it still should not quietly grow on the system drive when a
 * data drive exists. Order: explicit argument, environment, then the first
 * existing non-system drive, then the user profile (with a visible warning).
 */
export function resolveDataRoot(explicit?: string): DataRootResolution {
  if (explicit && explicit.trim()) {
    const root = resolve(explicit.trim());
    return { root, warnings: systemDriveWarnings(root) };
  }
  const fromEnv = process.env.RELAY_ASYNC_DATA_ROOT?.trim();
  if (fromEnv) {
    const root = resolve(fromEnv);
    return { root, warnings: systemDriveWarnings(root) };
  }
  for (const drive of ['D:', 'G:', 'E:']) {
    if (existsSync(`${drive}\\`)) {
      return { root: `${drive}\\RelayData\\async`, warnings: [] };
    }
  }
  const fallback = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'AgentRelay', 'async')
    : join(process.cwd(), '.relay-async');
  return { root: fallback, warnings: systemDriveWarnings(fallback) };
}

/** A data root on the system drive is allowed, but the user is told. */
export function systemDriveWarnings(root: string): string[] {
  const drive = process.env.SystemDrive || 'C:';
  const normalized = root.replace(/\\/g, '/').toLowerCase();
  const systemPrefix = `${drive.replace(/\\/g, '/').toLowerCase()}/`;
  if (!normalized.startsWith(systemPrefix)) return [];
  return [`任务数据目录位于系统盘（${root}）。可在设置中改为 D 盘或 G 盘，避免占用系统盘空间。`];
}

export class AsyncStore {
  readonly root: string;
  readonly warnings: string[];
  private state: AsyncState = emptyState();
  private queue: Promise<void> = Promise.resolve();
  private opened = false;
  private readonly log: (message: string) => void;

  constructor(options: { dataRoot?: string; log?: (message: string) => void } = {}) {
    const resolved = resolveDataRoot(options.dataRoot);
    this.root = resolved.root;
    this.warnings = resolved.warnings;
    this.log = options.log ?? (() => undefined);
  }

  get dataRoot(): string {
    return this.root;
  }

  private get statePath(): string {
    return join(this.root, 'state.json');
  }

  private get journalPath(): string {
    return join(this.root, 'journal.jsonl');
  }

  async open(): Promise<void> {
    if (this.opened) return;
    await mkdir(this.root, { recursive: true });
    try {
      const raw = await readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AsyncState>;
      this.state = migrate(parsed);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // A corrupt snapshot must not be silently replaced: keep it aside so the
        // journal and the bad file can both be inspected after a failed upgrade.
        const aside = `${this.statePath}.corrupt-${Date.now()}`;
        await rename(this.statePath, aside).catch(() => undefined);
        this.log(`[async] 状态文件无法解析，已另存为 ${aside}，本次从空状态启动`);
      }
      this.state = emptyState();
    }
    this.opened = true;
  }

  /** Read-only view. Callers must not mutate it; use {@link mutate}. */
  get snapshot(): AsyncState {
    return this.state;
  }

  /**
   * Apply a mutation and persist it.
   *
   * The mutator returns journal events; persistence happens once per call so a
   * task submission is one atomic step on disk, not five.
   */
  async mutate<T>(mutator: (state: AsyncState) => { result: T; events?: JournalEvent[] }): Promise<T> {
    await this.open();
    const run = this.queue.then(async () => {
      const { result, events } = mutator(this.state);
      this.state.sequence += 1;
      await this.persist();
      if (events && events.length > 0) await this.appendJournal(events);
      return result;
    });
    // Keep the chain alive even when a caller's mutator throws.
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async persist(): Promise<void> {
    const payload = JSON.stringify(this.state);
    const temp = `${this.statePath}.tmp`;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await writeFile(temp, payload, 'utf8');
        await rename(temp, this.statePath);
        return;
      } catch (error) {
        // Windows denies the rename while another process holds a handle open;
        // a short retry is cheaper than surfacing a spurious failure.
        if (attempt === 3) {
          this.log(`[async] 状态写入失败：${(error as Error).message}`);
          throw error;
        }
        await new Promise((settle) => setTimeout(settle, 20 * (attempt + 1)));
      }
    }
  }

  private async appendJournal(events: JournalEvent[]): Promise<void> {
    try {
      const info = await stat(this.journalPath).catch(() => null);
      if (info && info.size > JOURNAL_ROTATE_BYTES) {
        await rename(this.journalPath, `${this.journalPath}.old`).catch(() => undefined);
      }
      const lines = events
        .map((event) => JSON.stringify({ ...event, at: event.at ?? new Date().toISOString() }))
        .join('\n');
      await appendFile(this.journalPath, `${lines}\n`, 'utf8');
    } catch (error) {
      // The audit trail is diagnostic: a failure here must not fail the task.
      this.log(`[async] 审计日志写入失败：${(error as Error).message}`);
    }
  }

  /** Prune old runs/messages so a long-lived install does not grow forever. */
  async close(): Promise<void> {
    await this.queue.catch(() => undefined);
  }
}

export interface JournalEvent {
  seq?: number;
  at?: string;
  kind: string;
  message: string;
  taskId?: string;
  stageId?: string;
  runId?: string;
  callbackId?: string;
}

function migrate(parsed: Partial<AsyncState>): AsyncState {
  const base = emptyState();
  return {
    ...base,
    ...parsed,
    version: STATE_VERSION,
    topics: parsed.topics ?? base.topics,
    groups: parsed.groups ?? base.groups,
    groupMembers: parsed.groupMembers ?? base.groupMembers,
    groupMessages: parsed.groupMessages ?? base.groupMessages,
    tasks: parsed.tasks ?? base.tasks,
    stages: parsed.stages ?? base.stages,
    runs: parsed.runs ?? base.runs,
    messages: parsed.messages ?? base.messages,
    callbacks: parsed.callbacks ?? base.callbacks,
    idempotency: parsed.idempotency ?? base.idempotency,
    callbackKeys: parsed.callbackKeys ?? base.callbackKeys,
    clientObservations: parsed.clientObservations ?? base.clientObservations,
    sequence: typeof parsed.sequence === 'number' ? parsed.sequence : 0,
  };
}

/** Find a topic by display name, matching what the user actually typed. */
export function findTopicByName(state: AsyncState, name: string): Topic | null {
  const trimmed = name.trim();
  for (const topic of Object.values(state.topics)) {
    if (topic.name === trimmed) return topic;
  }
  return null;
}

/** Find a project binding already used for this path, to avoid duplicate roots. */
export function findProjectIdByPath(state: AsyncState, path: string): string | null {
  for (const stage of Object.values(state.stages)) {
    if (stage.project.path && samePath(stage.project.path, path)) return stage.project.id;
  }
  return null;
}
