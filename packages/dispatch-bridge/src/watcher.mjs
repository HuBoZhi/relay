/**
 * The turn watcher.
 *
 * This is the only place in the product that asks "has the turn finished yet", and
 * it is transport code: no model is involved, no prompt is affected, and nothing in
 * the conversation waits on it. When the turn ends, the result is posted to the
 * engine as a normal callback, which is what puts it back into the group and into
 * the chat that asked.
 *
 * It never re-sends a prompt. A turn whose state cannot be established is reported
 * as `unconfirmed` and left for a human, because a second prompt is a second job.
 */

import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Map a client poll result onto a callback outcome.
 *
 * `cancelled` becomes `blocked`, never `completed`: an interrupted turn is not a
 * finished one, and the requirement is explicit that a stop marker must not be read
 * as success.
 */
export function mapPollResult(result) {
  const status = result?.status;
  const response = typeof result?.response === 'string' ? result.response.trim() : '';
  if (status === 'completed') {
    return {
      done: true,
      outcome: 'completed',
      summary: response ? response.slice(0, 1200) : '本轮已结束，客户端未返回文本',
    };
  }
  if (status === 'cancelled') {
    return {
      done: true,
      outcome: 'blocked',
      summary: response ? `本轮已中断：${response.slice(0, 600)}` : '客户端报告本轮已中断，未完成',
    };
  }
  if (status === 'error') {
    const pending = result?.error?.pendingRequestIds;
    if (
      result?.error?.code === 'desktop_confirmation_required' ||
      (Array.isArray(pending) && pending.length > 0)
    ) {
      return {
        done: true,
        outcome: 'blocked',
        summary: `客户端正在等待确认（${(pending || []).join(', ') || '权限请求'}），本轮未完成`,
      };
    }
    const reason = result?.error?.message || result?.error?.code || result?.nativeReason || '客户端报告错误';
    return {
      done: true,
      outcome: 'failed',
      summary: response ? `${reason}：${response.slice(0, 600)}` : String(reason).slice(0, 600),
    };
  }
  return { done: false, outcome: null, summary: null };
}

export class TurnWatcher {
  #watchers = new Map();
  #stopped = false;

  constructor({
    store,
    engineUrl,
    engineToken = null,
    pollMs = 2000,
    timeoutMs = 60 * 60 * 1000,
    desktopFor,
    fetchImpl = globalThis.fetch,
    log = () => {},
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.store = store;
    this.engineUrl = engineUrl;
    this.engineToken = engineToken;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.desktopFor = desktopFor;
    this.fetch = fetchImpl;
    this.log = log;
    this.now = now;
    this.sleep = sleep;
  }

  get active() {
    return this.#watchers.size;
  }

  /** Continue watching every accepted run after a bridge restart. */
  async resume() {
    for (const record of this.store.pending()) {
      if (record.state === 'accepted') {
        this.log(`[bridge] 恢复等待：${record.id}（${record.client}）`);
        void this.watch(record);
      }
    }
  }

  stop() {
    this.#stopped = true;
  }

  watch(record) {
    if (this.#watchers.has(record.id)) return this.#watchers.get(record.id);
    const task = this.#loop(record).finally(() => this.#watchers.delete(record.id));
    this.#watchers.set(record.id, task);
    return task;
  }

  async #loop(record) {
    const desktop = this.desktopFor(record.client);
    if (!desktop) {
      this.log(`[bridge] 无法继续等待 ${record.id}：驱动不可用`);
      return null;
    }
    const deadline = Date.parse(record.startedAt) + this.timeoutMs;
    while (!this.#stopped) {
      await this.sleep(this.pollMs);
      if (this.#stopped) return null;
      let result;
      try {
        result = await desktop.poll(record.sessionId, record.requestId);
      } catch (error) {
        record.lastError = error.message;
        record.checks = (record.checks ?? 0) + 1;
        // A transient poll failure is not a task failure; keep waiting until the
        // deadline, and keep the reason on the record.
        if (this.now() > deadline) {
          await this.#giveUp(record, `等待超时，最后错误：${error.message}`);
          return null;
        }
        continue;
      }
      record.checks = (record.checks ?? 0) + 1;
      if (result?.sessionId && result.sessionId !== record.sessionId) {
        record.sessionId = result.sessionId;
        await this.store.saveSession(record.client, record.workspace, { sessionId: result.sessionId, workspace: record.workspace });
      }
      const mapped = mapPollResult(result);
      if (mapped.done) {
        await this.#report(record, mapped);
        return mapped;
      }
      if (this.now() > deadline) {
        await this.#giveUp(record, '等待超时，客户端未报告本轮结束');
        return null;
      }
    }
    return null;
  }

  async #giveUp(record, note) {
    record.state = 'unconfirmed';
    record.note = note;
    record.finishedAt = new Date(this.now()).toISOString();
    await this.store.putPending(record);
    await this.#journal({ ...record, kind: 'unconfirmed' });
    this.log(`[bridge] ${record.id}：${note}`);
  }

  async #report(record, mapped) {
    const body = {
      taskId: record.taskId,
      stageId: record.stageId,
      runId: record.runId,
      outcome: mapped.outcome,
      summary: mapped.summary,
      evidence: { sessionId: record.sessionId, nativeTurnId: record.requestId },
      // Replaying this report (bridge restart, retry) must not create a second
      // callback or a second result message.
      idempotencyKey: `bridge:${record.id}`,
    };
    let ok = false;
    let status = 0;
    try {
      const response = await this.fetch(`${this.engineUrl}/api/async/callbacks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.engineToken ? { 'X-Relay-Async-Token': this.engineToken } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      status = response.status;
      ok = response.ok;
      if (!ok) this.log(`[bridge] 回报被拒绝（${status}）：${await response.text().catch(() => '')}`);
    } catch (error) {
      this.log(`[bridge] 回报失败：${error.message}`);
    }

    record.state = ok ? 'reported' : 'report-failed';
    record.outcome = mapped.outcome;
    record.finishedAt = new Date(this.now()).toISOString();
    await this.#journal({ ...record, kind: ok ? 'reported' : 'report-failed', status });
    if (ok) await this.store.dropPending(record.id);
    this.log(`[bridge] ${record.id}：${mapped.outcome}${ok ? '，已回报引擎' : '，回报失败'}`);
  }

  async #journal(entry) {
    try {
      const dir = join(this.store.dir, 'reports');
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, 'journal.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      this.log(`[bridge] 审计日志写入失败：${error.message}`);
    }
  }
}
