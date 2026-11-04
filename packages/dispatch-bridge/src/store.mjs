/**
 * Bridge state: which session belongs to which client/workspace, and which runs are
 * still waiting for a turn to end.
 *
 * Both live on disk because a bridge restart must not lose a run in flight. A run
 * recorded as `submitting` when the process died is reported as `unconfirmed` on the
 * next start — the prompt may or may not have been accepted, and re-sending it is
 * exactly the mistake this record exists to prevent.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const EMPTY = { version: 1, sessions: {}, pending: {} };

export class BridgeStore {
  #dir;
  #sessions;
  #pending;
  #queue = Promise.resolve();
  #log;

  constructor({ dir, log = () => {} }) {
    this.#dir = dir;
    this.#log = log;
    this.#sessions = {};
    this.#pending = {};
  }

  get dir() {
    return this.#dir;
  }

  async open() {
    await mkdir(this.#dir, { recursive: true });
    this.#sessions = await this.#read('sessions.json');
    this.#pending = await this.#read('pending.json');
    // Anything still marked as submitting was cut off mid-call: its real state is
    // unknown, so it is surfaced as such instead of being retried.
    for (const record of Object.values(this.#pending)) {
      if (record.state === 'submitting') {
        record.state = 'unconfirmed';
        record.note = '桥接在该轮提交期间退出，无法确认是否已被客户端接受';
      }
    }
    await this.#flush('pending.json', this.#pending);
  }

  async #read(name) {
    try {
      const raw = await readFile(join(this.#dir, name), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      if (error.code !== 'ENOENT') this.#log(`[bridge] ${name} 读取失败：${error.message}`);
      return {};
    }
  }

  async #flush(name, value) {
    const target = join(this.#dir, name);
    const temp = `${target}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temp, target);
  }

  #serialize(task) {
    const next = this.#queue.then(task, task);
    this.#queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  /** Session key is client + workspace, so two projects never share a session. */
  static sessionKey(client, workspace) {
    const canonical = String(workspace ?? '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
    return `${client}::${canonical}`;
  }

  session(client, workspace) {
    return this.#sessions[BridgeStore.sessionKey(client, workspace)] ?? null;
  }

  async saveSession(client, workspace, value) {
    return this.#serialize(async () => {
      this.#sessions[BridgeStore.sessionKey(client, workspace)] = {
        ...value,
        savedAt: new Date().toISOString(),
      };
      await this.#flush('sessions.json', this.#sessions);
      return this.#sessions[BridgeStore.sessionKey(client, workspace)];
    });
  }

  pending() {
    return Object.values(this.#pending);
  }

  pendingById(id) {
    return this.#pending[id] ?? null;
  }

  async putPending(record) {
    return this.#serialize(async () => {
      this.#pending[record.id] = record;
      await this.#flush('pending.json', this.#pending);
      return record;
    });
  }

  async dropPending(id) {
    return this.#serialize(async () => {
      delete this.#pending[id];
      await this.#flush('pending.json', this.#pending);
    });
  }
}

export { EMPTY as EMPTY_BRIDGE_STATE };
