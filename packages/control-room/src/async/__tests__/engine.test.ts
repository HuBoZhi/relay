/**
 * Engine behaviour under the conditions the acceptance list names.
 *
 * The tests use a fake adapter so they prove the engine's contract — receipt
 * boundaries, idempotency, routing, and status layering — without a real model.
 * Anything that needs a live desktop client is a written acceptance step, not a
 * unit test pretending to be one.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { AsyncEngine, AsyncValidationError } from '../engine.js';
import type {
  DispatchAdapter,
  DeliverOutcome as DeliverOutcomeType,
  DispatchOutcome,
  DispatchRequest,
} from '../adapters.js';
import type { SubmitStageInput, SubmitTaskInput } from '../contracts.js';
import { topicSlug } from '../ids.js';

const scratch: string[] = [];

async function scratchRoot(): Promise<string> {
  // Task data on the system drive is what the requirement forbids for real
  // installs; tests use a data drive when available and clean up afterwards.
  const base = existsSync('D:\\') ? 'D:\\Temp' : tmpdir();
  const dir = await mkdtemp(join(base, 'relay-async-test-'));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

class FakeAdapter implements DispatchAdapter {
  readonly client: string;
  dispatches: DispatchRequest[] = [];
  deliverCalls = 0;
  deliverState: DeliverOutcomeType['state'] = 'in-chat';
  dispatchOutcome: DispatchOutcome = { status: 'delivered' };
  failDispatch: Error | null = null;

  constructor(client = 'zcode') {
    this.client = client;
  }

  describe() {
    return {};
  }

  async dispatch(request: DispatchRequest): Promise<DispatchOutcome> {
    this.dispatches.push(request);
    if (this.failDispatch) throw this.failDispatch;
    return {
      sessionId: 'session_native_1',
      modelId: request.model.modelId,
      account: request.model.account,
      reasoning: request.model.reasoning,
      projectId: request.project.id,
      nativeTurnId: 'turn_native_1',
      workspacePath: request.project.path,
      ...this.dispatchOutcome,
    };
  }

  async deliver(): Promise<DeliverOutcomeType> {
    this.deliverCalls += 1;
    return { state: this.deliverState, reason: this.deliverState === 'in-chat' ? undefined : '宿主未确认' };
  }
}

function stage(overrides: Partial<SubmitStageInput> = {}): SubmitStageInput {
  return {
    kind: 'develop',
    client: 'zcode',
    project: { id: 'proj_mediadock', path: 'D:\\Work\\MediaDock' },
    session: { policy: 'new', sessionId: null },
    model: { account: 'BigModel', provider: 'zhipu', modelId: 'GLM-5.3-Flash', reasoning: 'max' },
    completion: { condition: '开发完成且测试通过', requiresEvidence: true },
    ...overrides,
  };
}

function submitInput(overrides: Partial<SubmitTaskInput> = {}): SubmitTaskInput {
  return {
    topic: { name: '20261104-MediaDock-需求开发2' },
    title: '实现内容主题替换',
    body: '基于 Prompt 创建内容时，将 {主题} 替换为当前项目的主题部分。',
    authorization: { scopes: ['develop', 'review'], allowChain: true },
    origin: {
      app: 'codex',
      device: 'desktop-01',
      chatId: 'chat_original_7',
      senderId: 'agent_original',
      workflowIds: ['wf_dev_review'],
    },
    stages: [stage()],
    ...overrides,
  };
}

describe('submit', () => {
  it('returns a queued receipt without an adapter and never claims delivery', async () => {
    const engine = new AsyncEngine({ dataRoot: await scratchRoot() });
    const receipt = await engine.submit(submitInput());

    expect(receipt.phase).toBe('queued');
    expect(receipt.reason).toContain('未接入');
    expect(receipt.status.transport.state).toBe('local-saved');
    expect(receipt.status.execution.state).toBe('queued');
    expect(receipt.status.business.state).toBe('unconfirmed');
    await engine.close();
  });

  it('reports the actual session, project, and model after a delivered dispatch', async () => {
    const adapter = new FakeAdapter();
    const engine = new AsyncEngine({ adapters: [adapter], dataRoot: await scratchRoot() });
    const receipt = await engine.submit(submitInput());

    expect(receipt.phase).toBe('delivered');
    expect(receipt.sessionId).toBe('session_native_1');
    expect(receipt.projectId).toBe('proj_mediadock');
    expect(receipt.model.actual).toBe('GLM-5.3-Flash');
    expect(receipt.status.execution.state).toBe('accepted');
    expect(adapter.dispatches).toHaveLength(1);
    expect(adapter.dispatches[0]?.session.policy).toBe('new');
    await engine.close();
  });

  it('turns an adapter exception into a factual delivery failure instead of retrying', async () => {
    const adapter = new FakeAdapter();
    adapter.failDispatch = new Error('本机端口未开放');
    const engine = new AsyncEngine({ adapters: [adapter], dataRoot: await scratchRoot() });

    const receipt = await engine.submit(submitInput());
    expect(receipt.phase).toBe('queued');
    expect(receipt.reason).toContain('本机端口未开放');
    expect(receipt.status.transport.state).toBe('delivery-failed');
    expect(adapter.dispatches).toHaveLength(1);
    await engine.close();
  });

  it('answers an identical idempotency key with the same ids', async () => {
    const adapter = new FakeAdapter();
    const engine = new AsyncEngine({ adapters: [adapter], dataRoot: await scratchRoot() });
    const input = submitInput({ idempotencyKey: 'chat_original_7:submit:1' });

    const first = await engine.submit(input);
    const second = await engine.submit(input);

    expect(second.taskId).toBe(first.taskId);
    expect(second.runId).toBe(first.runId);
    expect(second.idempotent).toBe(true);
    expect(adapter.dispatches).toHaveLength(1);
    await engine.close();
  });

  it('rejects a stage that has no project or model, naming the field', async () => {
    const engine = new AsyncEngine({ dataRoot: await scratchRoot() });
    const input = submitInput({
      stages: [
        stage({
          project: { id: '', path: '' },
          model: { account: '', provider: '', modelId: '', reasoning: '' },
        }),
      ],
    });

    await expect(engine.submit(input)).rejects.toBeInstanceOf(AsyncValidationError);
    await engine.submit(input).catch((error: AsyncValidationError) => {
      const fields = error.issues.map((issue) => issue.field);
      expect(fields).toContain('stages[0].project.path');
      expect(fields).toContain('stages[0].model.modelId');
    });
    await engine.close();
  });

  it('keeps two tasks on one topic while giving each its own ids', async () => {
    const engine = new AsyncEngine({ dataRoot: await scratchRoot() });
    const first = await engine.submit(submitInput({ title: '需求一' }));
    const second = await engine.submit(submitInput({ title: '需求二' }));

    expect(first.topicId).toBe(second.topicId);
    expect(first.taskId).not.toBe(second.taskId);
    const snapshot = await engine.snapshot();
    expect(snapshot.topics).toHaveLength(1);
    expect(snapshot.topics[0]?.name).toBe('20261104-MediaDock-需求开发2');
    await engine.close();
  });
});

describe('callback', () => {
  it('starts the authorised review stage exactly once', async () => {
    const adapter = new FakeAdapter();
    const engine = new AsyncEngine({ adapters: [adapter], dataRoot: await scratchRoot() });
    const receipt = await engine.submit(
      submitInput({
        stages: [
          stage({ id: 'dev' }),
          stage({ id: 'review', kind: 'review', dependsOn: ['dev'], client: 'zcode' }),
        ],
      })
    );
    expect(adapter.dispatches).toHaveLength(1);

    const callback = await engine.recordCallback({
      taskId: receipt.taskId,
      stageId: receipt.stageId,
      runId: receipt.runId,
      outcome: 'completed',
      summary: '开发完成，测试通过',
      evidence: { commit: 'abc123', tests: ['npm test'] },
    });

    expect(callback.recorded).toBe(true);
    expect(callback.continuedStageId).not.toBeNull();
    expect(adapter.dispatches).toHaveLength(2);

    const detail = await engine.task(receipt.taskId);
    expect(detail?.stages.map((item) => item.kind)).toEqual(['develop', 'review']);
    expect(detail?.stages[0]?.status.business.state).toBe('developed');
    // A review that has only been dispatched is not a reviewed task.
    expect(detail?.task.status.business.state).toBe('unconfirmed');
    await engine.close();
  });

  it('collapses a replay of the same callback into one effective handling', async () => {
    const adapter = new FakeAdapter();
    const engine = new AsyncEngine({ adapters: [adapter], dataRoot: await scratchRoot() });
    const receipt = await engine.submit(
      submitInput({
        stages: [stage({ id: 'dev' }), stage({ id: 'review', kind: 'review', dependsOn: ['dev'] })],
      })
    );

    const payload = {
      taskId: receipt.taskId,
      stageId: receipt.stageId,
      runId: receipt.runId,
      outcome: 'completed' as const,
      summary: '开发完成',
    };
    const results = [];
    for (let index = 0; index < 3; index += 1) results.push(await engine.recordCallback(payload));

    expect(new Set(results.map((item) => item.callbackId)).size).toBe(1);
    expect(results.filter((item) => item.recorded)).toHaveLength(1);
    expect(adapter.dispatches).toHaveLength(2);
    const detail = await engine.task(receipt.taskId);
    expect(detail?.callbacks).toHaveLength(1);
    await engine.close();
  });

  it('does not start a review when development failed', async () => {
    const adapter = new FakeAdapter();
    const engine = new AsyncEngine({ adapters: [adapter], dataRoot: await scratchRoot() });
    const receipt = await engine.submit(
      submitInput({
        stages: [stage({ id: 'dev' }), stage({ id: 'review', kind: 'review', dependsOn: ['dev'] })],
      })
    );

    const callback = await engine.recordCallback({
      taskId: receipt.taskId,
      stageId: receipt.stageId,
      runId: receipt.runId,
      outcome: 'failed',
      summary: '构建失败',
    });

    expect(callback.continuedStageId).toBeNull();
    expect(adapter.dispatches).toHaveLength(1);
    const detail = await engine.task(receipt.taskId);
    expect(detail?.task.status.execution.state).toBe('failed');
    expect(detail?.task.status.business.state).toBe('unconfirmed');
    await engine.close();
  });

  it('rejects a callback whose run belongs to another stage', async () => {
    const engine = new AsyncEngine({ dataRoot: await scratchRoot() });
    const receipt = await engine.submit(submitInput());

    await expect(
      engine.recordCallback({
        taskId: receipt.taskId,
        stageId: 'stg_not_real',
        runId: receipt.runId,
        outcome: 'completed',
        summary: '伪造回传',
      })
    ).rejects.toThrow(/未找到阶段/);
    await engine.close();
  });

  it('records a late callback for a cancelled task without continuing the chain', async () => {
    const adapter = new FakeAdapter();
    const engine = new AsyncEngine({ adapters: [adapter], dataRoot: await scratchRoot() });
    const receipt = await engine.submit(
      submitInput({
        stages: [stage({ id: 'dev' }), stage({ id: 'review', kind: 'review', dependsOn: ['dev'] })],
      })
    );
    await engine.cancelTask(receipt.taskId, '用户改主意了');

    const callback = await engine.recordCallback({
      taskId: receipt.taskId,
      stageId: receipt.stageId,
      runId: receipt.runId,
      outcome: 'completed',
      summary: '取消后才完成',
    });

    expect(callback.continuedStageId).toBeNull();
    expect(callback.delivery.state).toBe('manual');
    expect(adapter.dispatches).toHaveLength(1);
    await engine.close();
  });

  it('marks delivery manual when the origin chat has no verified channel', async () => {
    const engine = new AsyncEngine({ dataRoot: await scratchRoot() });
    const receipt = await engine.submit(submitInput());

    const callback = await engine.recordCallback({
      taskId: receipt.taskId,
      stageId: receipt.stageId,
      runId: receipt.runId,
      outcome: 'completed',
      summary: '完成',
    });

    expect(callback.delivery.state).toBe('manual');
    expect(callback.delivery.reason).toContain('未接入');
    const snapshot = await engine.snapshot();
    expect(snapshot.counts.callbacksManual).toBe(1);
    await engine.close();
  });

  it('only upgrades chat injection after a real in-chat delivery', async () => {
    const adapter = new FakeAdapter('zcode');
    adapter.deliverState = 'awaiting-host';
    const engine = new AsyncEngine({ adapters: [adapter], dataRoot: await scratchRoot() });
    const receipt = await engine.submit(submitInput({ origin: { ...submitInput().origin, app: 'zcode' } }));

    const first = await engine.recordCallback({
      taskId: receipt.taskId,
      stageId: receipt.stageId,
      runId: receipt.runId,
      outcome: 'completed',
      summary: '完成',
    });
    expect(first.delivery.state).toBe('awaiting-host');
    let zcode = (await engine.snapshot()).clients.find((client) => client.client === 'zcode');
    expect(zcode?.chatInjection.state).toBe('unverified');

    adapter.deliverState = 'in-chat';
    const retried = await engine.retryCallbackDelivery(first.callbackId);
    expect(retried.delivery.state).toBe('in-chat');
    zcode = (await engine.snapshot()).clients.find((client) => client.client === 'zcode');
    expect(zcode?.chatInjection.state).toBe('supported');
    expect(zcode?.chatInjection.chatId).toBe('chat_original_7');
    await engine.close();
  });
});

describe('durability', () => {
  it('restores tasks, callbacks, and pending deliveries after a restart', async () => {
    const root = await scratchRoot();
    const adapter = new FakeAdapter();
    const first = new AsyncEngine({ adapters: [adapter], dataRoot: root });
    const receipt = await first.submit(submitInput({ origin: { ...submitInput().origin, app: 'zcode' } }));
    await first.recordCallback({
      taskId: receipt.taskId,
      stageId: receipt.stageId,
      runId: receipt.runId,
      outcome: 'completed',
      summary: '完成',
    });
    await first.close();

    const restarted = new AsyncEngine({ adapters: [adapter], dataRoot: root });
    const detail = await restarted.task(receipt.taskId);
    expect(detail?.task.title).toBe('实现内容主题替换');
    expect(detail?.callbacks[0]?.delivery.state).toBe('in-chat');
    expect(detail?.task.origin.chatId).toBe('chat_original_7');
    // Nothing is re-dispatched on restart.
    expect(adapter.dispatches).toHaveLength(1);
    await restarted.close();
  });

  it('writes an audit journal that names the task', async () => {
    const root = await scratchRoot();
    const engine = new AsyncEngine({ dataRoot: root });
    const receipt = await engine.submit(submitInput());
    await engine.close();

    const journal = await readFile(join(root, 'journal.jsonl'), 'utf8');
    expect(journal).toContain('task.submitted');
    expect(journal).toContain(receipt.taskId);
  });
});

describe('turn events', () => {
  it('maps a pending confirmation to awaiting-confirmation, not running', async () => {
    const engine = new AsyncEngine({ dataRoot: await scratchRoot() });
    const receipt = await engine.submit(submitInput());

    await engine.reportRunState({
      runId: receipt.runId,
      execution: 'awaiting-confirmation',
      detail: '等待权限确认',
    });
    const detail = await engine.task(receipt.taskId);
    expect(detail?.task.status.execution.state).toBe('awaiting-confirmation');

    await engine.reportRunState({ runId: receipt.runId, execution: 'turn-ended' });
    const ended = await engine.task(receipt.taskId);
    // A turn ending is not a business result.
    expect(ended?.task.status.execution.state).toBe('turn-ended');
    expect(ended?.task.status.business.state).toBe('unconfirmed');
    await engine.close();
  });
});

describe('topic slugs', () => {
  it('keeps a Chinese display name while producing an ASCII slug', () => {
    expect(topicSlug('20261104-MediaDock-需求开发2')).toBe('20261104-mediadock-2');
    expect(topicSlug('中文主题')).toMatch(/^topic-[0-9a-f]{8}$/);
    expect(topicSlug('中文主题')).toBe(topicSlug('中文主题'));
  });
});
