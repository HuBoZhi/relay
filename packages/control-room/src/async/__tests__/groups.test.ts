/**
 * The group chat layer.
 *
 * What these pin: creating a group reuses the topic, an `@` with a model and a
 * project becomes dispatched work, the receiving agent's session is what proves
 * it joined, and a result lands back in the same conversation without touching
 * any other request in the group.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { AsyncEngine, AsyncValidationError } from '../engine.js';
import type { DeliverOutcome, DispatchAdapter, DispatchOutcome, DispatchRequest } from '../adapters.js';
import type { GroupMention } from '../contracts.js';

const scratch: string[] = [];

async function scratchRoot(): Promise<string> {
  const base = existsSync('D:\\') ? 'D:\\Temp' : tmpdir();
  const dir = await mkdtemp(join(base, 'relay-group-test-'));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

class FakeZcode implements DispatchAdapter {
  readonly client: string;
  dispatches: DispatchRequest[] = [];
  sessionId = 'session_zcode_1';

  constructor(client = 'zcode') {
    this.client = client;
  }

  describe() {
    return {};
  }

  async dispatch(request: DispatchRequest): Promise<DispatchOutcome> {
    this.dispatches.push(request);
    return {
      status: 'delivered',
      sessionId: this.sessionId,
      projectId: request.project.id,
      modelId: request.model.modelId,
      account: request.model.account,
      reasoning: request.model.reasoning,
      nativeTurnId: 'turn_1',
    };
  }

  async deliver(): Promise<DeliverOutcome> {
    return { state: 'in-chat' };
  }
}

const codex = {
  agentId: 'codex',
  displayName: 'Codex',
  app: 'codex',
  device: 'desktop-01',
  chatId: 'chat_original_7',
};
const zcode = {
  agentId: 'zcode',
  displayName: 'ZCode',
  app: 'zcode',
  device: 'desktop-01',
  chatId: 'chat_zcode_1',
};

function workMention(overrides: Partial<GroupMention> = {}): GroupMention {
  return {
    target: 'zcode',
    client: 'zcode',
    project: { id: 'proj_mediadock', path: 'D:\\Work\\MediaDock' },
    model: { account: 'BigModel', provider: 'zhipu', modelId: 'GLM-5.3-Flash', reasoning: 'max' },
    ...overrides,
  };
}

describe('group chat', () => {
  it('preserves a ZCode permission choice in mentions, dispatches and stored sessions', async () => {
    const adapter = new FakeZcode();
    const engine = new AsyncEngine({ dataRoot: await scratchRoot(), adapters: [adapter] });
    try {
      const { group } = await engine.createGroup({ name: '权限测试', creator: codex });
      const posted = await engine.postGroupMessage(group.id, { sender: codex, body: '分析项目',
        mentions: [workMention({ session: { policy: 'new', sessionId: null, permissionMode: 'plan' } })] });
      expect(posted.message.mentions[0]?.session?.permissionMode).toBe('plan');
      expect(adapter.dispatches[0]?.session.permissionMode).toBe('plan');
      expect((await engine.snapshot()).stages[0]?.session.permissionMode).toBe('plan');
      await expect(engine.postGroupMessage(group.id, { sender: codex, body: 'invalid',
        mentions: [workMention({ session: { policy: 'new', sessionId: null, permissionMode: 'invalid' as never } })] })).rejects.toBeInstanceOf(AsyncValidationError);
    } finally { await engine.close(); }
  });
  it('deletes a group durably without deleting its tasks or resurrecting it on callback', async () => {
    const dataRoot = await scratchRoot();
    const engine = new AsyncEngine({ dataRoot, adapters: [new FakeZcode()] });
    const { group } = await engine.createGroup({ name: '可删除的群', creator: codex });
    const posted = await engine.postGroupMessage(group.id, { sender: codex, body: '继续执行', mentions: [workMention()] });
    const receipt = posted.receipt!;
    await engine.deleteGroup(group.id);
    await engine.deleteGroup(group.id); // Repeated requests are harmless.
    expect(await engine.group(group.id)).toBeNull();
    expect(await engine.listGroups()).toEqual([]);
    await expect(engine.postGroupMessage(group.id, { sender: codex, body: '迟到的消息' })).rejects.toThrow('未找到群');
    await engine.recordCallback({ taskId: receipt.taskId, stageId: receipt.stageId!, runId: receipt.runId!, outcome: 'completed', summary: '执行完成' });
    expect(await engine.task(receipt.taskId)).toBeTruthy();
    expect(await engine.listGroups()).toEqual([]);
    await engine.close();
    const reopened = new AsyncEngine({ dataRoot });
    expect(await reopened.listGroups()).toEqual([]);
    const replacement = await reopened.createGroup({ name: group.name, creator: codex });
    expect(replacement.group.id).not.toBe(group.id);
    expect(replacement.tasks).toEqual([]);
    await reopened.close();
  });
  it('opens one group per topic name, with the creator as owner', async () => {
    const engine = new AsyncEngine({ dataRoot: await scratchRoot() });
    const first = await engine.createGroup({ name: '20261104-MediaDock-需求开发2', creator: codex });
    const again = await engine.createGroup({ name: '20261104-MediaDock-需求开发2', creator: codex });

    expect(again.group.id).toBe(first.group.id);
    expect(first.members).toHaveLength(1);
    expect(first.members[0]?.role).toBe('owner');
    expect(first.group.name).toBe('20261104-MediaDock-需求开发2');
    expect(first.messages[0]?.kind).toBe('system');
    await engine.close();
  });

  it('turns an @ with a model and a project into dispatched work', async () => {
    const adapter = new FakeZcode();
    const engine = new AsyncEngine({ adapters: [adapter], dataRoot: await scratchRoot() });
    const { group } = await engine.createGroup({ name: '群A', creator: codex });

    const posted = await engine.postGroupMessage(group.id, {
      sender: codex,
      body: '把登录页空状态补上',
      mentions: [workMention()],
    });

    expect(posted.message.kind).toBe('request');
    expect(posted.message.state).toBe('delivered');
    expect(posted.receipt?.taskId).toBeTruthy();
    expect(adapter.dispatches).toHaveLength(1);
    expect(adapter.dispatches[0]?.project.path).toBe('D:\\Work\\MediaDock');
    expect(adapter.dispatches[0]?.model.reasoning).toBe('max');

    const view = await engine.group(group.id);
    expect(view?.tasks).toHaveLength(1);
    expect(view?.tasks[0]?.groupId).toBe(group.id);
    // The session the target reported is what proves it joined.
    const joined = view?.members.find((member) => member.agentId === 'zcode');
    expect(joined?.sessionId).toBe('session_zcode_1');
    expect(
      view?.messages.some((message) => message.kind === 'join' && message.body.includes('session_zcode_1'))
    ).toBe(true);
    await engine.close();
  });

  it('refuses a request that does not say which project to work in', async () => {
    const engine = new AsyncEngine({ dataRoot: await scratchRoot() });
    const { group } = await engine.createGroup({ name: '群B', creator: codex });

    await expect(
      engine.postGroupMessage(group.id, {
        sender: codex,
        body: '顺手改一下',
        mentions: [{ target: 'zcode', client: 'zcode', model: workMention().model }],
      })
    ).rejects.toBeInstanceOf(AsyncValidationError);

    await engine
      .postGroupMessage(group.id, {
        sender: codex,
        body: '顺手改一下',
        mentions: [{ target: 'zcode', client: 'zcode', model: workMention().model }],
      })
      .catch((error: AsyncValidationError) => {
        expect(error.issues[0]?.field).toBe('mentions[0].project');
      });
    await engine.close();
  });

  it('keeps a plain message a message', async () => {
    const adapter = new FakeZcode();
    const engine = new AsyncEngine({ adapters: [adapter], dataRoot: await scratchRoot() });
    const { group } = await engine.createGroup({ name: '群C', creator: codex });

    const posted = await engine.postGroupMessage(group.id, {
      sender: codex,
      body: '@zcode 这台机器装 Node 22 了吗？',
      mentions: [{ target: 'zcode' }],
    });

    expect(posted.message.kind).toBe('text');
    expect(posted.receipt).toBeNull();
    expect(adapter.dispatches).toHaveLength(0);
    await engine.close();
  });

  it('routes a result back into the group and to the chat that asked', async () => {
    const adapter = new FakeZcode();
    // The result travels to the *origin* chat, which is a different client from
    // the one that did the work; both need a channel for delivery to be real.
    const originAdapter = new FakeZcode('codex');
    const engine = new AsyncEngine({ adapters: [adapter, originAdapter], dataRoot: await scratchRoot() });
    const { group } = await engine.createGroup({ name: '群D', creator: codex });
    const request = await engine.postGroupMessage(group.id, {
      sender: codex,
      body: '补空状态',
      mentions: [workMention()],
    });
    const taskId = request.receipt?.taskId as string;

    const done = await engine.reportGroupResult(group.id, {
      sender: zcode,
      taskId,
      outcome: 'completed',
      summary: '已补空状态，npm test 通过',
      evidence: { commit: 'abc123', tests: ['npm test'] },
    });

    expect(done.message.kind).toBe('result');
    expect(done.message.outcome).toBe('completed');
    expect(done.message.body).toContain('npm test');
    // Delivery into the origin chat succeeded, so the result is not "manual".
    expect(done.message.state).toBe('delivered');
    expect(done.callback.recorded).toBe(true);
    expect(done.message.mentions[0]?.target).toBe('codex');
    expect(done.group.messages.filter((message) => message.kind === 'result')).toHaveLength(1);
    await engine.close();
  });

  it('shows a result in the group even when a bridge posts the bare callback', async () => {
    // This is how the dispatch bridge reports: it knows task/stage/run, not the
    // conversation. The result must still appear where the work was asked for.
    const adapter = new FakeZcode();
    const engine = new AsyncEngine({
      adapters: [adapter, new FakeZcode('codex')],
      dataRoot: await scratchRoot(),
    });
    const { group } = await engine.createGroup({ name: '群R', creator: codex });
    const request = await engine.postGroupMessage(group.id, {
      sender: codex,
      body: '补空状态',
      mentions: [workMention()],
    });

    const receipt = await engine.recordCallback({
      taskId: request.receipt?.taskId as string,
      stageId: request.receipt?.stageId as string,
      runId: request.receipt?.runId as string,
      outcome: 'completed',
      summary: '桥接回报：已完成',
    });
    expect(receipt.groupMessageId).toBeTruthy();
    // The conversation received the answer, so this is a delivery — not a
    // "needs a human" callback, even though no client chat was injected into.
    expect(receipt.delivery.state).toBe('in-chat');
    expect(receipt.delivery.reason ?? null).toBeNull();

    const view = await engine.group(group.id);
    const results = view?.messages.filter((message) => message.kind === 'result') ?? [];
    expect(results).toHaveLength(1);
    expect(results[0]?.body).toBe('桥接回报：已完成');
    expect(results[0]?.sender.agentId).toBe('zcode');
    expect(results[0]?.state).toBe('delivered');
    await engine.close();
  });

  it('broadcasts one message to several agents at once', async () => {
    const zcode = new FakeZcode();
    const workbuddy = new FakeZcode('workbuddy');
    const engine = new AsyncEngine({
      adapters: [zcode, workbuddy, new FakeZcode('codex')],
      dataRoot: await scratchRoot(),
    });
    const { group } = await engine.createGroup({ name: '群B', creator: codex });

    const posted = await engine.postGroupMessage(group.id, {
      sender: codex,
      body: '两位一起看下这个空状态',
      mentions: [workMention(), workMention({ target: 'workbuddy', client: 'workbuddy' })],
    });

    // One message, two dispatches: a stage per mention, both started now.
    expect(posted.message.mentions).toHaveLength(2);
    expect(zcode.dispatches).toHaveLength(1);
    expect(workbuddy.dispatches).toHaveLength(1);
    const detail = await engine.task(posted.receipt?.taskId as string);
    expect(detail?.stages).toHaveLength(2);
    expect(detail?.runs).toHaveLength(2);
    await engine.close();
  });

  it('reports a failed request as failed and starts nothing', async () => {
    const adapter = new FakeZcode();
    const engine = new AsyncEngine({
      adapters: [adapter, new FakeZcode('codex')],
      dataRoot: await scratchRoot(),
    });
    const { group } = await engine.createGroup({ name: '群E', creator: codex });
    const request = await engine.postGroupMessage(group.id, {
      sender: codex,
      body: '补空状态',
      mentions: [workMention()],
    });

    const done = await engine.reportGroupResult(group.id, {
      sender: zcode,
      taskId: request.receipt?.taskId as string,
      outcome: 'failed',
      summary: '构建失败',
    });

    expect(done.message.outcome).toBe('failed');
    const detail = await engine.task(request.receipt?.taskId as string);
    expect(detail?.task.status.execution.state).toBe('failed');
    expect(detail?.task.status.business.state).toBe('unconfirmed');
    await engine.close();
  });

  it('keeps two requests in one group apart', async () => {
    const adapter = new FakeZcode();
    const engine = new AsyncEngine({
      adapters: [adapter, new FakeZcode('codex')],
      dataRoot: await scratchRoot(),
    });
    const { group } = await engine.createGroup({ name: '群F', creator: codex });

    const one = await engine.postGroupMessage(group.id, {
      sender: codex,
      body: '请求一',
      mentions: [workMention()],
    });
    const two = await engine.postGroupMessage(group.id, {
      sender: codex,
      body: '请求二',
      mentions: [workMention()],
    });

    await engine.reportGroupResult(group.id, {
      sender: zcode,
      taskId: one.receipt?.taskId as string,
      outcome: 'completed',
      summary: '一已完成',
    });

    const first = await engine.task(one.receipt?.taskId as string);
    const second = await engine.task(two.receipt?.taskId as string);
    expect(first?.task.status.business.state).toBe('developed');
    expect(second?.task.status.business.state).toBe('unconfirmed');
    await engine.close();
  });

  it('registers a member that speaks before it was invited', async () => {
    const engine = new AsyncEngine({ dataRoot: await scratchRoot() });
    const { group } = await engine.createGroup({ name: '群G', creator: codex });

    await engine.postGroupMessage(group.id, {
      sender: {
        agentId: 'workbuddy',
        displayName: 'WorkBuddy',
        app: 'workbuddy',
        device: 'desktop-02',
        chatId: '',
      },
      body: '我到了',
    });

    const view = await engine.group(group.id);
    expect(view?.members.map((member) => member.agentId).sort()).toEqual(['codex', 'workbuddy']);
    expect(
      view?.messages.some((message) => message.kind === 'join' && message.body.includes('WorkBuddy'))
    ).toBe(true);
    await engine.close();
  });

  it('restores groups, members, and messages after a restart', async () => {
    const root = await scratchRoot();
    const adapter = new FakeZcode();
    const first = new AsyncEngine({ adapters: [adapter], dataRoot: root });
    const { group } = await first.createGroup({ name: '群H', creator: codex });
    await first.postGroupMessage(group.id, { sender: codex, body: '补空状态', mentions: [workMention()] });
    await first.close();

    const restarted = new AsyncEngine({ adapters: [adapter], dataRoot: root });
    const view = await restarted.group(group.id);
    expect(view?.group.name).toBe('群H');
    expect(view?.members.some((member) => member.sessionId === 'session_zcode_1')).toBe(true);
    expect(view?.messages.filter((message) => message.kind === 'request')).toHaveLength(1);
    expect(adapter.dispatches).toHaveLength(1);
    await restarted.close();
  });
});
