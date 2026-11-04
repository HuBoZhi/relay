/**
 * The async task engine.
 *
 * Responsibilities, in the order a task moves through them:
 *
 * 1. `submit` validates and persists, then dispatches once. It returns a receipt
 *    as soon as the target accepted the prompt — it never waits for a model, and
 *    it never pretends a queued task was delivered.
 * 2. `recordCallback` is what a receiving client calls when it finishes, fails, or
 *    blocks. It updates the four status layers, deduplicates replays, and—only
 *    when the user pre-authorised the chain—starts the next stage.
 * 3. Delivery of that callback into the originating chat is attempted through the
 *    adapter. When no verified injection channel exists the record says `manual`,
 *    which the UI must show as "需要人工处理" rather than "已送达".
 *
 * Everything the engine does is event-driven. There is no timer that reads chat
 * state and no code path that asks a model whether something finished.
 */

import type {
  AsyncSnapshot,
  BusinessState,
  CallbackDeliveryState,
  CallbackEvidence,
  CallbackReceipt,
  CallbackRecord,
  ClientCapabilityView,
  ExecutionState,
  LayerStatus,
  MessageKind,
  MessageRecord,
  ModelConfig,
  RecordCallbackInput,
  Run,
  Stage,
  SubmitReceipt,
  SubmitStageInput,
  SubmitTaskInput,
  Task,
  Topic,
  TransportState,
} from './contracts.js';
import type { DispatchAdapter, DispatchOutcome, DeliverOutcome } from './adapters.js';
import { AdapterRegistry, knownClients } from './adapters.js';
import { createId, projectLabel, samePath, stableHash, topicSlug } from './ids.js';
import {
  AsyncStore,
  findProjectIdByPath,
  findTopicByName,
  type AsyncState,
  type JournalEvent,
} from './store.js';

export interface EngineEvent {
  type:
    | 'task.submitted'
    | 'stage.dispatched'
    | 'stage.queued'
    | 'callback.received'
    | 'callback.delivered'
    | 'task.cancelled'
    | 'client.updated';
  at: string;
  taskId?: string;
  stageId?: string;
  callbackId?: string;
  message: string;
}

export interface ValidationIssue {
  /** Dotted path the UI can point at, e.g. `stages[0].project.path`. */
  field: string;
  message: string;
}

export class AsyncValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(issues.map((issue) => `${issue.field}: ${issue.message}`).join('；'));
    this.name = 'AsyncValidationError';
    this.issues = issues;
  }
}

export class AsyncNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AsyncNotFoundError';
  }
}

export interface EngineOptions {
  dataRoot?: string;
  store?: AsyncStore;
  adapters?: DispatchAdapter[];
  log?: (message: string) => void;
  /** Injectable clock, so tests can produce deterministic ordering. */
  now?: () => Date;
}

const STAGE_LABELS: Record<string, string> = {
  develop: '开发',
  review: '审查',
  verify: '验证',
};

export function stageLabel(kind: string): string {
  return STAGE_LABELS[kind] ?? kind;
}

/**
 * The primary human-facing result of a stage kind.
 *
 * A `completed` callback on a develop stage means "开发完成", not "验收通过";
 * conflating the two is how a review chain starts on an unfinished build.
 */
function businessStateFor(kind: string): BusinessState {
  if (kind === 'review') return 'reviewed';
  if (kind === 'verify') return 'accepted';
  return 'developed';
}

export class AsyncEngine {
  private readonly store: AsyncStore;
  private readonly registry: AdapterRegistry;
  private readonly log: (message: string) => void;
  private readonly now: () => Date;
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  private opened = false;

  constructor(options: EngineOptions = {}) {
    this.store =
      options.store ??
      new AsyncStore({ dataRoot: options.dataRoot, log: options.log ?? ((m) => console.log(m)) });
    this.registry = new AdapterRegistry(options.adapters ?? []);
    this.log = options.log ?? ((message: string) => console.log(message));
    this.now = options.now ?? (() => new Date());
  }

  get dataRoot(): string {
    return this.store.dataRoot;
  }

  get warnings(): string[] {
    return this.store.warnings;
  }

  async open(): Promise<void> {
    if (this.opened) return;
    await this.store.open();
    this.opened = true;
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken listener (a closed SSE pipe) must not fail the task.
      }
    }
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  /* ------------------------------------------------------------- submitting */

  async submit(input: SubmitTaskInput): Promise<SubmitReceipt> {
    await this.open();
    validateSubmit(input);

    const idempotencyKey = input.idempotencyKey?.trim()
      ? `idem:${input.idempotencyKey.trim()}`
      : `body:${stableHash({
          topic: input.topic.name.trim(),
          title: input.title.trim(),
          body: input.body,
          origin: input.origin,
          stages: input.stages,
        })}`;

    const created = await this.store.mutate((state) => {
      const existing = state.idempotency[idempotencyKey];
      if (existing) {
        return {
          result: { receipt: existing.receipt, created: false, stageId: existing.stageId },
          events: [],
        };
      }

      const at = this.stamp();
      const topic = resolveTopic(state, input.topic, at);
      const taskId = createId('task');
      const correlationId = createId('task');
      const projectPath = input.stages[0]?.project.path ?? '';
      // Reuse a project id already bound to the same physical directory, so the
      // client does not see two roots for one folder.
      const knownProjectId = projectPath ? findProjectIdByPath(state, projectPath) : null;

      const stageIdByExternal = new Map<string, string>();
      const stages: Stage[] = [];
      for (const [index, spec] of input.stages.entries()) {
        const stageId = createId('stage');
        if (spec.id) stageIdByExternal.set(spec.id, stageId);
        stageIdByExternal.set(`#${index}`, stageId);
        const model = normalizeModel(spec.model);
        const session = spec.session ?? { policy: 'new' as const, sessionId: null };
        const stage: Stage = {
          id: stageId,
          taskId,
          index,
          kind: spec.kind,
          label: spec.label?.trim() || stageLabel(spec.kind),
          dependsOn: [],
          client: spec.client,
          project: {
            id: knownProjectId ?? spec.project.id,
            path: spec.project.path,
          },
          session:
            session.policy === 'continue'
              ? { policy: 'continue', sessionId: session.sessionId ?? null }
              : { policy: 'new', sessionId: null },
          model,
          completion: {
            condition: spec.completion.condition,
            requiresEvidence: spec.completion.requiresEvidence,
          },
          callback: spec.callback ?? { ...input.origin },
          queueIfUnavailable: spec.queueIfUnavailable !== false,
          runIds: [],
          status: freshStatus(at, 'async.submit'),
          createdAt: at,
          updatedAt: at,
        };
        stages.push(stage);
        state.stages[stageId] = stage;
      }
      // Dependencies are expressed against caller-supplied ids; resolve them
      // after every stage has an internal id.
      for (const [index, spec] of input.stages.entries()) {
        const stage = stages[index];
        if (!stage) continue;
        const deps: string[] = [];
        for (const dep of spec.dependsOn ?? []) {
          const resolved = stageIdByExternal.get(dep) ?? (state.stages[dep] ? dep : null);
          if (resolved) deps.push(resolved);
        }
        stage.dependsOn = deps.filter((dep) => dep !== stage.id);
        if (index === 0 && stage.dependsOn.length > 0) {
          // The first stage of a task is what the user asked for; a dependency on
          // an earlier stage can only mean the chain was built incorrectly.
          throw new AsyncValidationError([
            { field: 'stages[0].dependsOn', message: '第一个阶段不能依赖其他阶段' },
          ]);
        }
      }
      for (const stage of stages) {
        if (stage.dependsOn.length > 0) {
          stage.status.execution = {
            state: 'awaiting-dependency',
            at,
            source: 'async.submit',
          };
        }
      }

      const first = stages[0];
      if (!first) throw new AsyncValidationError([{ field: 'stages', message: '至少需要一个阶段' }]);
      const run = createRun(first, at, 1);
      first.runIds.push(run.id);
      state.runs[run.id] = run;

      const submitMessage = addMessage(state, {
        topicId: topic.id,
        taskId,
        stageId: first.id,
        runId: run.id,
        correlationId,
        causationId: null,
        idempotencyKey,
        sender: {
          app: input.origin.app,
          device: input.origin.device,
          chatId: input.origin.chatId,
          agentId: input.origin.senderId,
        },
        route: 'to-topic',
        kind: 'task.submitted',
        summary: `已受理任务：${input.title.trim()}`,
        at,
      });
      run.messageId = submitMessage.id;

      const task: Task = {
        id: taskId,
        topicId: topic.id,
        title: input.title.trim(),
        body: input.body,
        authorization: {
          scopes: [...input.authorization.scopes],
          allowChain: input.authorization.allowChain === true,
        },
        origin: { ...input.origin },
        correlationId,
        stageIds: stages.map((stage) => stage.id),
        runIds: [run.id],
        callbackIds: [],
        messageIds: [submitMessage.id],
        status: taskStatusFrom(stages, [run], [], at),
        cancelled: null,
        createdAt: at,
        updatedAt: at,
      };
      state.tasks[taskId] = task;

      const receipt: SubmitReceipt = {
        taskId,
        topicId: topic.id,
        topicName: topic.name,
        topicSlug: topic.slug,
        stageId: first.id,
        runId: run.id,
        messageId: submitMessage.id,
        phase: 'queued',
        client: first.client,
        sessionId: null,
        projectId: first.project.id,
        model: { requested: first.model, actual: null },
        reason: '已保存，等待派发',
        status: cloneStatus(run.status),
        acceptedAt: at,
        idempotent: false,
      };
      state.idempotency[idempotencyKey] = {
        taskId,
        stageId: first.id,
        runId: run.id,
        receipt,
        at,
      };

      const events: JournalEvent[] = [
        { kind: 'task.submitted', message: receipt.reason ?? '', taskId, stageId: first.id, runId: run.id },
      ];
      return { result: { receipt, created: true, stageId: first.id }, events };
    });

    if (!created.created) {
      return { ...created.receipt, idempotent: true };
    }

    const receipt = await this.dispatchStage(created.receipt.taskId, created.stageId, created.receipt);
    return receipt;
  }

  /* --------------------------------------------------------------- dispatch */

  /**
   * Send one stage prompt and fold the adapter's answer back into the store.
   *
   * A thrown adapter is a factual `delivery-failed` with a reason — never a
   * silent retry. Retrying a prompt that may have been accepted is how a task
   * gets executed twice.
   */
  private async dispatchStage(
    taskId: string,
    stageId: string,
    receipt: SubmitReceipt
  ): Promise<SubmitReceipt> {
    const snapshot = this.store.snapshot;
    const stage = snapshot.stages[stageId];
    const task = snapshot.tasks[taskId];
    if (!stage || !task) return receipt;
    const run = stage.runIds
      .map((id) => snapshot.runs[id])
      .filter((item): item is Run => Boolean(item))
      .at(-1);
    if (!run) return receipt;

    const adapter = this.registry.resolve(stage.client);
    if (!adapter) {
      const reason = `未接入「${stage.client}」的派发通道，任务已排队`;
      await this.markQueued(taskId, stageId, run.id, reason);
      return {
        ...receipt,
        phase: 'queued',
        reason,
        status: cloneStatus(this.store.snapshot.runs[run.id]?.status ?? run.status),
      };
    }

    await this.markDelivering(taskId, stageId, run.id);

    let outcome: DispatchOutcome;
    try {
      outcome = await adapter.dispatch({
        taskId,
        stageId,
        runId: run.id,
        topicName: this.store.snapshot.topics[task.topicId]?.name ?? '',
        title: task.title,
        body: task.body,
        client: stage.client,
        project: stage.project,
        session: stage.session,
        model: stage.model,
        callback: stage.callback,
        completion: stage.completion,
        idempotencyKey: `${run.id}:attempt-${run.attempt}`,
      });
    } catch (error) {
      outcome = { status: 'failed', reason: (error as Error).message };
    }

    const at = this.stamp();
    const updated = await this.store.mutate((state) => {
      const currentRun = state.runs[run.id];
      const currentStage = state.stages[stageId];
      const currentTask = state.tasks[taskId];
      if (!currentRun || !currentStage || !currentTask) return { result: receipt, events: [] };

      if (outcome.status === 'delivered') {
        currentRun.status.transport = { state: 'target-received', at, source: 'adapter.dispatch' };
        currentRun.status.execution = { state: 'accepted', at, source: 'adapter.dispatch' };
        currentRun.acceptedAt = at;
        currentRun.lastEventAt = at;
        currentRun.queuedReason = null;
        currentRun.lastError = null;
        currentRun.actual = {
          account: outcome.account ?? null,
          modelId: outcome.modelId ?? currentStage.model.modelId,
          reasoning: outcome.reasoning ?? currentStage.model.reasoning,
          projectId: outcome.projectId ?? currentStage.project.id,
          workspacePath: outcome.workspacePath ?? currentStage.project.path,
          sessionId: outcome.sessionId ?? currentStage.session.sessionId,
          nativeTurnId: outcome.nativeTurnId ?? null,
        };
        // The adapter reported a session; remember it so a later stage that asks
        // to continue has something real to continue.
        if (outcome.sessionId)
          currentStage.session = { policy: currentStage.session.policy, sessionId: outcome.sessionId };
        currentStage.status = cloneStatus(currentRun.status);
        currentStage.status.business = currentStage.status.business;
        currentStage.updatedAt = at;
        addMessage(state, {
          topicId: currentTask.topicId,
          taskId,
          stageId,
          runId: run.id,
          correlationId: currentTask.correlationId,
          causationId: currentTask.messageIds[0] ?? null,
          idempotencyKey: null,
          sender: { app: 'relay', device: 'local', chatId: 'async-engine', agentId: 'engine' },
          route: 'to-client',
          kind: 'stage.accepted',
          summary: `已送达「${currentStage.label}」：${currentStage.client}`,
          at,
        });
        currentTask.runIds = unique([...currentTask.runIds, run.id]);
        currentTask.status = taskStatusFrom(
          currentTask.stageIds.map((id) => state.stages[id]).filter((s): s is Stage => Boolean(s)),
          currentTask.runIds.map((id) => state.runs[id]).filter((r): r is Run => Boolean(r)),
          currentTask.callbackIds
            .map((id) => state.callbacks[id])
            .filter((c): c is CallbackRecord => Boolean(c)),
          at
        );
        currentTask.updatedAt = at;
        recordClientSuccess(state, (c) => this.registry.capability(c), currentStage.client, at);
      } else if (outcome.status === 'queued') {
        const reason = outcome.reason || '目标客户端暂不可用，任务已排队';
        currentRun.status.transport = { state: 'local-saved', at, source: 'adapter.dispatch' };
        currentRun.status.execution = { state: 'queued', at, source: 'adapter.dispatch' };
        currentRun.queuedReason = reason;
        currentRun.lastEventAt = at;
        currentStage.status = cloneStatus(currentRun.status);
        currentStage.updatedAt = at;
        addMessage(state, {
          topicId: currentTask.topicId,
          taskId,
          stageId,
          runId: run.id,
          correlationId: currentTask.correlationId,
          causationId: currentTask.messageIds[0] ?? null,
          idempotencyKey: null,
          sender: { app: 'relay', device: 'local', chatId: 'async-engine', agentId: 'engine' },
          route: 'to-client',
          kind: 'stage.queued',
          summary: reason,
          at,
        });
        currentTask.updatedAt = at;
      } else {
        const reason = outcome.reason || '派发失败，原因未知';
        currentRun.status.transport = { state: 'delivery-failed', at, source: 'adapter.dispatch' };
        currentRun.status.execution = { state: 'failed', at, source: 'adapter.dispatch' };
        currentRun.lastError = reason;
        currentRun.lastEventAt = at;
        currentStage.status = cloneStatus(currentRun.status);
        currentStage.updatedAt = at;
        recordClientError(state, (c) => this.registry.capability(c), currentStage.client, reason);
        addMessage(state, {
          topicId: currentTask.topicId,
          taskId,
          stageId,
          runId: run.id,
          correlationId: currentTask.correlationId,
          causationId: currentTask.messageIds[0] ?? null,
          idempotencyKey: null,
          sender: { app: 'relay', device: 'local', chatId: 'async-engine', agentId: 'engine' },
          route: 'to-client',
          kind: 'stage.queued',
          summary: `派发失败：${reason}`,
          at,
        });
        currentTask.updatedAt = at;
      }

      const phase: SubmitReceipt['phase'] = outcome.status === 'delivered' ? 'delivered' : 'queued';
      const nextReceipt: SubmitReceipt = {
        ...receipt,
        phase,
        sessionId: currentRun.actual.sessionId,
        projectId: currentRun.actual.projectId ?? receipt.projectId,
        model: {
          requested: currentStage.model,
          actual: currentRun.actual.modelId ?? null,
        },
        reason: outcome.status === 'delivered' ? null : (outcome.reason ?? currentRun.queuedReason),
        status: cloneStatus(currentRun.status),
      };
      const key = Object.keys(state.idempotency).find((entry) => state.idempotency[entry]?.runId === run.id);
      if (key) {
        const record = state.idempotency[key];
        if (record) state.idempotency[key] = { ...record, receipt: nextReceipt };
      }
      const events: JournalEvent[] = [
        {
          kind: phase === 'delivered' ? 'stage.dispatched' : 'stage.queued',
          message: nextReceipt.reason ?? `已送达 ${currentStage.client}`,
          taskId,
          stageId,
          runId: run.id,
        },
      ];
      return { result: nextReceipt, events };
    });

    this.emit({
      type: updated.phase === 'delivered' ? 'stage.dispatched' : 'stage.queued',
      at,
      taskId,
      stageId,
      message: updated.reason ?? `已送达「${stage.label}」`,
    });
    return updated;
  }

  private async markDelivering(taskId: string, stageId: string, runId: string): Promise<void> {
    const at = this.stamp();
    await this.store.mutate((state) => {
      const run = state.runs[runId];
      if (!run) return { result: null };
      run.status.transport = { state: 'delivering', at, source: 'async.engine' };
      run.lastEventAt = at;
      const stage = state.stages[stageId];
      if (stage) stage.status = cloneStatus(run.status);
      return { result: null, events: [] };
    });
  }

  private async markQueued(taskId: string, stageId: string, runId: string, reason: string): Promise<void> {
    const at = this.stamp();
    await this.store.mutate((state) => {
      const run = state.runs[runId];
      const stage = state.stages[stageId];
      const task = state.tasks[taskId];
      if (!run || !stage || !task) return { result: null };
      run.status.transport = { state: 'local-saved', at, source: 'async.engine' };
      run.status.execution = { state: 'queued', at, source: 'async.engine' };
      run.queuedReason = reason;
      run.lastEventAt = at;
      stage.status = cloneStatus(run.status);
      stage.updatedAt = at;
      addMessage(state, {
        topicId: task.topicId,
        taskId,
        stageId,
        runId,
        correlationId: task.correlationId,
        causationId: task.messageIds[0] ?? null,
        idempotencyKey: null,
        sender: { app: 'relay', device: 'local', chatId: 'async-engine', agentId: 'engine' },
        route: 'to-client',
        kind: 'stage.queued',
        summary: reason,
        at,
      });
      task.updatedAt = at;
      return { result: null, events: [{ kind: 'stage.queued', message: reason, taskId, stageId, runId }] };
    });
    this.emit({ type: 'stage.queued', at, taskId, stageId, message: reason });
  }

  /* -------------------------------------------------------------- callbacks */

  async recordCallback(input: RecordCallbackInput): Promise<CallbackReceipt> {
    await this.open();
    const dedupeKey = input.idempotencyKey?.trim()
      ? `idem:${input.idempotencyKey.trim()}`
      : `body:${stableHash({
          taskId: input.taskId,
          stageId: input.stageId,
          runId: input.runId,
          outcome: input.outcome,
          summary: input.summary,
          evidence: input.evidence ?? null,
        })}`;

    const recorded = await this.store.mutate((state) => {
      const task = state.tasks[input.taskId];
      if (!task) throw new AsyncNotFoundError(`未找到任务：${input.taskId}`);
      const stage = state.stages[input.stageId];
      if (!stage) throw new AsyncNotFoundError(`未找到阶段：${input.stageId}`);
      const run = state.runs[input.runId];
      if (!run) throw new AsyncNotFoundError(`未找到执行实例：${input.runId}`);
      if (stage.taskId !== task.id) {
        throw new AsyncValidationError([{ field: 'stageId', message: '阶段不属于该任务' }]);
      }
      if (run.taskId !== task.id || run.stageId !== stage.id) {
        throw new AsyncValidationError([{ field: 'runId', message: '执行实例与任务或阶段不匹配' }]);
      }

      const seen = state.callbackKeys[dedupeKey];
      if (seen) {
        const existing = state.callbacks[seen];
        if (existing) {
          return {
            result: {
              // A replay is acknowledged, not re-recorded: the caller learns the
              // original id so it can stop retrying, but nothing happens twice.
              receipt: { ...toCallbackReceipt(existing), recorded: false },
              continueStageId: null as string | null,
              duplicate: true,
            },
            events: [],
          };
        }
      }

      const at = this.stamp();
      const priorForRun = Object.values(state.callbacks).find(
        (callback) => callback.runId === run.id && !callback.duplicate
      );
      // A second, different callback for the same run contradicts the first. It is
      // stored for the record but cannot start a chain: one run has one outcome.
      const duplicate = Boolean(priorForRun);

      const message = addMessage(state, {
        topicId: task.topicId,
        taskId: task.id,
        stageId: stage.id,
        runId: run.id,
        correlationId: task.correlationId,
        causationId: run.messageId,
        idempotencyKey: dedupeKey,
        sender: { ...stage.callback, agentId: stage.client },
        route: 'to-chat',
        kind: 'callback.received',
        summary: summaryLine(stage, input),
        at,
      });

      const callbackId = createId('callback');
      const callback: CallbackRecord = {
        id: callbackId,
        taskId: task.id,
        stageId: stage.id,
        runId: run.id,
        messageId: message.id,
        outcome: input.outcome,
        summary: input.summary,
        evidence: normalizeEvidence(input.evidence, run),
        limits: input.limits ? [...input.limits] : [],
        dedupeKey,
        duplicate,
        receivedAt: at,
        delivery: {
          state: 'pending',
          attempts: 0,
          lastAttemptAt: null,
          deliveredAt: null,
          reason: null,
          triggeredStageId: null,
        },
      };
      state.callbacks[callbackId] = callback;
      state.callbackKeys[dedupeKey] = callbackId;

      applyCallbackToRun(run, stage, input.outcome, at);
      if (!duplicate) {
        run.status.business = {
          state:
            input.outcome === 'completed' ? businessStateFor(stage.kind) : ('unconfirmed' as BusinessState),
          at,
          source: `callback:${callbackId}`,
        };
      }
      stage.status = cloneStatus(run.status);
      stage.updatedAt = at;
      task.callbackIds.push(callbackId);
      task.updatedAt = at;

      // Cancelled tasks keep the record but must not start anything.
      const continuation = duplicate || task.cancelled ? null : this.nextStageFor(state, task, stage, input);
      if (continuation) {
        callback.delivery.triggeredStageId = continuation.stageId;
      } else if (task.cancelled) {
        callback.delivery.state = 'manual';
        callback.delivery.reason = '任务已取消，回传仅记录状态，不启动后续阶段';
      }

      task.status = taskStatusFrom(
        task.stageIds.map((id) => state.stages[id]).filter((s): s is Stage => Boolean(s)),
        task.runIds.map((id) => state.runs[id]).filter((r): r is Run => Boolean(r)),
        task.callbackIds.map((id) => state.callbacks[id]).filter((c): c is CallbackRecord => Boolean(c)),
        at
      );

      const events: JournalEvent[] = [
        {
          kind: 'callback.received',
          message: `${stage.label} ${input.outcome}`,
          taskId: task.id,
          stageId: stage.id,
          runId: run.id,
          callbackId,
        },
      ];
      return {
        result: {
          receipt: toCallbackReceipt(callback),
          continueStageId: continuation ? continuation.stageId : null,
          duplicate,
        },
        events,
      };
    });

    this.emit({
      type: 'callback.received',
      at: this.stamp(),
      taskId: input.taskId,
      stageId: input.stageId,
      callbackId: recorded.receipt.callbackId,
      message: recorded.duplicate ? '重复回传已忽略' : '收到回传',
    });

    if (recorded.duplicate) {
      return recorded.receipt;
    }

    const delivered = await this.deliverCallback(recorded.receipt.callbackId);
    if (recorded.continueStageId) {
      await this.continueStage(recorded.continueStageId);
    }
    return delivered;
  }

  /** Decide whether this callback may start the next authorised stage. */
  private nextStageFor(
    state: AsyncState,
    task: Task,
    stage: Stage,
    input: RecordCallbackInput
  ): { stageId: string } | null {
    if (input.outcome !== 'completed') return null;
    if (!task.authorization.allowChain) return null;
    for (const id of task.stageIds) {
      const candidate = state.stages[id];
      if (!candidate || candidate.index <= stage.index) continue;
      if (candidate.status.execution.state !== 'awaiting-dependency') continue;
      const ready = candidate.dependsOn.every((depId) => {
        const dep = state.stages[depId];
        if (!dep) return false;
        return Object.values(state.callbacks).some(
          (callback) => callback.stageId === dep.id && callback.outcome === 'completed' && !callback.duplicate
        );
      });
      if (ready) return { stageId: candidate.id };
    }
    return null;
  }

  private async continueStage(stageId: string): Promise<void> {
    const snapshot = this.store.snapshot;
    const stage = snapshot.stages[stageId];
    if (!stage) return;
    const task = snapshot.tasks[stage.taskId];
    if (!task || task.cancelled) return;

    const at = this.stamp();
    const run = await this.store.mutate((state) => {
      const current = state.stages[stageId];
      const currentTask = state.tasks[current?.taskId ?? ''];
      if (!current || !currentTask) return { result: null };
      const next = createRun(current, at, current.runIds.length + 1);
      current.runIds.push(next.id);
      state.runs[next.id] = next;
      currentTask.runIds = unique([...currentTask.runIds, next.id]);
      currentTask.updatedAt = at;
      addMessage(state, {
        topicId: currentTask.topicId,
        taskId: currentTask.id,
        stageId,
        runId: next.id,
        correlationId: currentTask.correlationId,
        causationId: currentTask.callbackIds.at(-1) ?? null,
        idempotencyKey: null,
        sender: { app: 'relay', device: 'local', chatId: 'async-engine', agentId: 'engine' },
        route: 'to-client',
        kind: 'stage.continued',
        summary: `上一阶段完成，继续已授权阶段「${current.label}」`,
        at,
      });
      return {
        result: next.id,
        events: [{ kind: 'stage.continued', message: current.label, taskId: currentTask.id, stageId }],
      };
    });
    if (!run) return;
    this.emit({ type: 'stage.dispatched', at, taskId: task.id, stageId, message: `继续阶段 ${stage.label}` });
    const emptyReceipt = buildReceiptForStage(this.store, stage.taskId, stageId);
    if (emptyReceipt) await this.dispatchStage(stage.taskId, stageId, emptyReceipt);
  }

  /* --------------------------------------------------------------- delivery */

  private async deliverCallback(callbackId: string, force = false): Promise<CallbackReceipt> {
    const snapshot = this.store.snapshot;
    const callback = snapshot.callbacks[callbackId];
    if (!callback) throw new AsyncNotFoundError(`未找到回传：${callbackId}`);
    const stage = snapshot.stages[callback.stageId];
    const task = snapshot.tasks[callback.taskId];
    if (!stage || !task) throw new AsyncNotFoundError('回传对应的任务或阶段不存在');
    // `manual` is a conclusion, not a retry trigger: only an explicit user retry
    // (or a rebind) may try again, so a cancelled task is not re-delivered.
    if (callback.delivery.state === 'manual' && !force) return toCallbackReceipt(callback);

    const chat = stage.callback;
    const adapter = this.registry.resolve(chat.app);
    let outcome: DeliverOutcome;
    if (!adapter) {
      outcome = {
        state: 'manual',
        reason: `未接入「${chat.app}」的回传通道；原聊天接收能力未验证，需要人工处理`,
      };
    } else {
      try {
        outcome = await adapter.deliver({
          callbackId,
          taskId: task.id,
          stageId: stage.id,
          runId: callback.runId,
          chat,
          outcome: callback.outcome,
          summary: callback.summary,
          stageLabel: stage.label,
          topicName: snapshot.topics[task.topicId]?.name ?? '',
        });
      } catch (error) {
        outcome = { state: 'failed', reason: (error as Error).message };
      }
    }

    const at = this.stamp();
    const updated = await this.store.mutate((state) => {
      const current = state.callbacks[callbackId];
      const currentTask = state.tasks[callback.taskId];
      if (!current || !currentTask) return { result: null };
      current.delivery.state = mapDeliverState(outcome.state);
      current.delivery.attempts += 1;
      current.delivery.lastAttemptAt = at;
      current.delivery.reason = outcome.reason ?? null;
      if (outcome.state === 'in-chat' || outcome.state === 'queued-in-chat') {
        current.delivery.deliveredAt = at;
      }
      const currentRun = state.runs[current.runId];
      if (currentRun) {
        currentRun.status.callback = {
          state: current.delivery.state,
          at,
          source: `callback:${callbackId}`,
        };
        const currentStage = state.stages[current.stageId];
        if (currentStage) currentStage.status = cloneStatus(currentRun.status);
      }
      addMessage(state, {
        topicId: currentTask.topicId,
        taskId: currentTask.id,
        stageId: current.stageId,
        runId: current.runId,
        correlationId: currentTask.correlationId,
        causationId: current.messageId,
        idempotencyKey: null,
        sender: { app: 'relay', device: 'local', chatId: 'async-engine', agentId: 'engine' },
        route: 'to-chat',
        kind: current.delivery.state === 'manual' ? 'callback.manual' : 'callback.delivered',
        summary:
          current.delivery.state === 'manual'
            ? (current.delivery.reason ?? '需要人工处理')
            : `回传已投递：${chat.app}`,
        at,
      });
      currentTask.status = taskStatusFrom(
        currentTask.stageIds.map((id) => state.stages[id]).filter((s): s is Stage => Boolean(s)),
        currentTask.runIds.map((id) => state.runs[id]).filter((r): r is Run => Boolean(r)),
        currentTask.callbackIds
          .map((id) => state.callbacks[id])
          .filter((c): c is CallbackRecord => Boolean(c)),
        at
      );
      currentTask.updatedAt = at;
      if (current.delivery.state === 'in-chat') {
        // Only a real in-chat delivery counts as evidence for the P0 gate.
        state.clientObservations[chat.app] ??= this.registry.capability(chat.app);
        noteChatInjection(state, chat.app, chat.chatId, at);
      }
      return {
        result: toCallbackReceipt(current),
        events: [
          {
            kind: current.delivery.state === 'manual' ? 'callback.manual' : 'callback.delivered',
            message: current.delivery.reason ?? '',
            taskId: currentTask.id,
            stageId: current.stageId,
            callbackId,
          },
        ],
      };
    });

    if (!updated) return toCallbackReceipt(callback);
    this.emit({
      type: 'callback.delivered',
      at,
      taskId: callback.taskId,
      stageId: callback.stageId,
      callbackId,
      message: updated.delivery.reason ?? '回传已投递',
    });
    return updated;
  }

  async retryCallbackDelivery(callbackId: string): Promise<CallbackReceipt> {
    await this.open();
    const callback = this.store.snapshot.callbacks[callbackId];
    if (!callback) throw new AsyncNotFoundError(`未找到回传：${callbackId}`);
    return this.deliverCallback(callbackId, true);
  }

  /** Point a stage's callback at a different chat, then re-queue its callbacks. */
  async rebindCallback(
    taskId: string,
    stageId: string,
    chat: { app: string; device: string; chatId: string }
  ): Promise<Task> {
    await this.open();
    if (!chat.chatId.trim()) {
      throw new AsyncValidationError([{ field: 'chatId', message: '回传聊天不能为空' }]);
    }
    const at = this.stamp();
    return this.store.mutate((state) => {
      const task = state.tasks[taskId];
      const stage = state.stages[stageId];
      if (!task || !stage) throw new AsyncNotFoundError('未找到任务或阶段');
      stage.callback = { app: chat.app, device: chat.device, chatId: chat.chatId };
      stage.updatedAt = at;
      for (const id of task.callbackIds) {
        const callback = state.callbacks[id];
        if (!callback || callback.stageId !== stageId) continue;
        if (callback.delivery.state === 'manual' || callback.delivery.state === 'pending') {
          callback.delivery.state = 'pending';
          callback.delivery.reason = '回传聊天已重新绑定，等待重新投递';
        }
      }
      task.updatedAt = at;
      return { result: task, events: [{ kind: 'callback.rebound', message: chat.chatId, taskId, stageId }] };
    });
  }

  /* ------------------------------------------------------------------ admin */

  async cancelTask(taskId: string, reason: string): Promise<Task> {
    await this.open();
    const at = this.stamp();
    const task = await this.store.mutate((state) => {
      const current = state.tasks[taskId];
      if (!current) throw new AsyncNotFoundError(`未找到任务：${taskId}`);
      current.cancelled = { at, reason: reason.trim() || '用户取消' };
      current.status.business = { state: 'cancelled', at, source: 'user.cancel' };
      for (const id of current.stageIds) {
        const stage = state.stages[id];
        if (!stage) continue;
        if (['queued', 'accepted', 'running', 'awaiting-dependency'].includes(stage.status.execution.state)) {
          stage.status.execution = { state: 'interrupted', at, source: 'user.cancel' };
          stage.updatedAt = at;
        }
      }
      current.updatedAt = at;
      addMessage(state, {
        topicId: current.topicId,
        taskId,
        stageId: null,
        runId: null,
        correlationId: current.correlationId,
        causationId: null,
        idempotencyKey: null,
        sender: { app: 'relay', device: 'local', chatId: 'async-engine', agentId: 'engine' },
        route: 'to-topic',
        kind: 'task.cancelled',
        summary: `任务已取消：${current.cancelled.reason}`,
        at,
      });
      return {
        result: current,
        events: [{ kind: 'task.cancelled', message: current.cancelled.reason, taskId }],
      };
    });
    this.emit({ type: 'task.cancelled', at, taskId, message: '任务已取消' });
    return task;
  }

  /**
   * Fold a native turn signal into the execution layer.
   *
   * This is how a client adapter reports `running`, `awaiting-confirmation`,
   * `interrupted`, or `turn-ended` without claiming a business result. A turn
   * that ended without a callback stays "本轮已结束，业务结果未确认" and starts
   * nothing — the distinction the previous scripts collapsed.
   */
  async reportRunState(input: {
    runId: string;
    execution: ExecutionState;
    detail?: string;
  }): Promise<Run | null> {
    await this.open();
    const at = this.stamp();
    const updated = await this.store.mutate((state) => {
      const run = state.runs[input.runId];
      if (!run) return { result: null };
      run.status.execution = { state: input.execution, at, source: 'adapter.turn-event' };
      run.lastEventAt = at;
      if (input.execution === 'running' || input.execution === 'accepted') {
        run.status.transport = { state: 'target-received', at, source: 'adapter.turn-event' };
      }
      const stage = state.stages[run.stageId];
      if (stage) {
        stage.status = cloneStatus(run.status);
        stage.updatedAt = at;
      }
      const task = state.tasks[run.taskId];
      if (task) {
        task.status = taskStatusFrom(
          task.stageIds.map((id) => state.stages[id]).filter((s): s is Stage => Boolean(s)),
          task.runIds.map((id) => state.runs[id]).filter((r): r is Run => Boolean(r)),
          task.callbackIds.map((id) => state.callbacks[id]).filter((c): c is CallbackRecord => Boolean(c)),
          at
        );
        task.updatedAt = at;
        addMessage(state, {
          topicId: task.topicId,
          taskId: task.id,
          stageId: run.stageId,
          runId: run.id,
          correlationId: task.correlationId,
          causationId: run.messageId,
          idempotencyKey: null,
          sender: { app: 'relay', device: 'local', chatId: 'async-engine', agentId: 'engine' },
          route: 'to-topic',
          kind: 'task.note',
          summary: input.detail?.trim() || `执行状态：${input.execution}`,
          at,
        });
      }
      return {
        result: run,
        events: [
          {
            kind: 'run.state',
            message: input.detail ?? input.execution,
            taskId: run.taskId,
            stageId: run.stageId,
            runId: run.id,
          },
        ],
      };
    });
    return updated;
  }

  async probeClient(client: string): Promise<ClientCapabilityView> {
    await this.open();
    const adapter = this.registry.resolve(client);
    if (!adapter?.probe) {
      return this.registry.capability(client);
    }
    const at = this.stamp();
    const result = await adapter.probe();
    return this.store.mutate((state) => {
      const current = state.clientObservations[client] ?? this.registry.capability(client);
      const next: ClientCapabilityView = {
        ...current,
        interfaceReady: result.interfaceReady,
        version: result.version ?? current.version,
        lastError: result.ok ? null : (result.error ?? '探测失败'),
        notes: unique([...current.notes, ...result.notes]).slice(0, 12),
      };
      state.clientObservations[client] = next;
      return {
        result: next,
        events: [{ kind: 'client.probed', message: result.ok ? '探测通过' : '探测失败' }],
      };
    });
  }

  /** Everything the UI needs, newest first. */
  async snapshot(): Promise<AsyncSnapshot> {
    await this.open();
    const state = this.store.snapshot;
    const tasks = Object.values(state.tasks).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const runs = Object.values(state.runs);
    const callbacks = Object.values(state.callbacks);
    const clients = this.registry.capabilities(knownClients()).map((client) => {
      const observed = state.clientObservations[client.client];
      return observed
        ? { ...client, ...observed, notes: unique([...client.notes, ...observed.notes]) }
        : client;
    });
    // An adapter-only client (a bridge for a client unknown to the static list)
    // still deserves a row rather than silently disappearing from the matrix.
    for (const observed of Object.values(state.clientObservations)) {
      if (!clients.some((client) => client.client === observed.client)) clients.push(observed);
    }
    return {
      generatedAt: this.stamp(),
      dataRoot: this.store.dataRoot,
      warnings: [...this.store.warnings],
      topics: Object.values(state.topics).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      tasks,
      stages: Object.values(state.stages).sort((a, b) => a.index - b.index),
      runs,
      callbacks,
      messages: Object.values(state.messages).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      clients,
      counts: {
        tasks: tasks.length,
        inFlight: runs.filter((run) =>
          ['queued', 'accepted', 'running', 'awaiting-dependency'].includes(run.status.execution.state)
        ).length,
        awaitingConfirmation: runs.filter((run) => run.status.execution.state === 'awaiting-confirmation')
          .length,
        callbacksPendingDelivery: callbacks.filter((callback) =>
          ['pending', 'awaiting-host'].includes(callback.delivery.state)
        ).length,
        callbacksManual: callbacks.filter((callback) => callback.delivery.state === 'manual').length,
        failed: runs.filter((run) => run.status.execution.state === 'failed').length,
      },
    };
  }

  async task(taskId: string): Promise<{
    task: Task;
    topic: Topic | null;
    stages: Stage[];
    runs: Run[];
    callbacks: CallbackRecord[];
    messages: MessageRecord[];
  } | null> {
    await this.open();
    const state = this.store.snapshot;
    const task = state.tasks[taskId];
    if (!task) return null;
    return {
      task,
      topic: state.topics[task.topicId] ?? null,
      stages: task.stageIds.map((id) => state.stages[id]).filter((s): s is Stage => Boolean(s)),
      runs: task.runIds.map((id) => state.runs[id]).filter((r): r is Run => Boolean(r)),
      callbacks: task.callbackIds
        .map((id) => state.callbacks[id])
        .filter(
          (c, index, all): c is CallbackRecord =>
            Boolean(c) && all.findIndex((x) => x?.id === c?.id) === index
        ),
      messages: task.messageIds.map((id) => state.messages[id]).filter((m): m is MessageRecord => Boolean(m)),
    };
  }
}

/* --------------------------------------------------------------- internals */

function validateSubmit(input: SubmitTaskInput): void {
  const issues: ValidationIssue[] = [];
  if (!input.topic?.name?.trim()) issues.push({ field: 'topic.name', message: '主题名称不能为空' });
  if (!input.title?.trim()) issues.push({ field: 'title', message: '任务标题不能为空' });
  if (!input.body?.trim()) issues.push({ field: 'body', message: '需求正文不能为空' });
  if (!input.origin?.chatId?.trim()) {
    issues.push({ field: 'origin.chatId', message: '必须绑定原聊天，否则回传无处可去' });
  }
  if (!input.origin?.app?.trim()) issues.push({ field: 'origin.app', message: '必须标明发送方应用' });
  if (!Array.isArray(input.stages) || input.stages.length === 0) {
    issues.push({ field: 'stages', message: '至少需要一个阶段' });
    throw new AsyncValidationError(issues);
  }
  input.stages.forEach((stage, index) => validateStage(stage, index, issues));
  if (issues.length > 0) throw new AsyncValidationError(issues);
}

function validateStage(stage: SubmitStageInput, index: number, issues: ValidationIssue[]): void {
  const at = `stages[${index}]`;
  if (!stage.kind?.trim()) issues.push({ field: `${at}.kind`, message: '阶段类型不能为空' });
  if (!stage.client?.trim()) issues.push({ field: `${at}.client`, message: '必须选择目标客户端' });
  if (!stage.project?.path?.trim()) {
    issues.push({ field: `${at}.project.path`, message: '必须选择目标项目目录' });
  }
  if (!stage.project?.id?.trim()) issues.push({ field: `${at}.project.id`, message: '缺少项目 ID' });
  if (!stage.model?.modelId?.trim()) issues.push({ field: `${at}.model.modelId`, message: '必须选择模型' });
  if (!stage.model?.account?.trim())
    issues.push({ field: `${at}.model.account`, message: '必须选择账户或提供商' });
  if (!stage.model?.reasoning?.trim()) {
    issues.push({ field: `${at}.model.reasoning`, message: '必须选择思考强度' });
  }
  if (!stage.completion?.condition?.trim()) {
    issues.push({ field: `${at}.completion.condition`, message: '必须填写完成条件' });
  }
  if (stage.session?.policy === 'continue' && !stage.session.sessionId?.trim()) {
    issues.push({ field: `${at}.session.sessionId`, message: '接续会话必须指定会话 ID' });
  }
}

function resolveTopic(state: AsyncState, input: { name: string; channel?: string }, at: string): Topic {
  const name = input.name.trim();
  const existing = findTopicByName(state, name);
  if (existing) return existing;
  const topic: Topic = {
    id: createId('topic'),
    name,
    slug: topicSlug(name),
    channel: input.channel?.trim() || null,
    createdAt: at,
  };
  state.topics[topic.id] = topic;
  return topic;
}

function normalizeModel(model: ModelConfig): ModelConfig {
  return {
    account: model.account.trim(),
    provider: model.provider?.trim() || model.account.trim(),
    modelId: model.modelId.trim(),
    reasoning: model.reasoning.trim(),
  };
}

function createRun(stage: Stage, at: string, attempt: number): Run {
  const run: Run = {
    id: createId('run'),
    taskId: stage.taskId,
    stageId: stage.id,
    attempt,
    client: stage.client,
    requestedModel: { ...stage.model },
    actual: {
      account: null,
      modelId: null,
      reasoning: null,
      projectId: stage.project.id,
      workspacePath: stage.project.path,
      sessionId: stage.session.sessionId,
      nativeTurnId: null,
    },
    status: freshStatus(at, 'async.engine'),
    queuedReason: null,
    deliveryAttempts: 0,
    lastError: null,
    messageId: '',
    createdAt: at,
    acceptedAt: null,
    lastEventAt: at,
  };
  return run;
}

function freshStatus(at: string, source: string): LayerStatus {
  return {
    transport: { state: 'local-saved', at, source },
    execution: { state: 'queued', at, source },
    business: { state: 'unconfirmed', at, source },
    callback: { state: 'pending', at, source },
  };
}

function cloneStatus(status: LayerStatus): LayerStatus {
  return {
    transport: { ...status.transport },
    execution: { ...status.execution },
    business: { ...status.business },
    callback: { ...status.callback },
  };
}

interface MessageInput {
  topicId: string;
  taskId: string | null;
  stageId: string | null;
  runId: string | null;
  correlationId: string;
  causationId: string | null;
  idempotencyKey: string | null;
  sender: MessageRecord['sender'];
  route: MessageRecord['route'];
  kind: MessageKind;
  summary: string;
  at: string;
}

function addMessage(state: AsyncState, input: MessageInput): MessageRecord {
  const message: MessageRecord = {
    id: createId('message'),
    topicId: input.topicId,
    taskId: input.taskId,
    stageId: input.stageId,
    runId: input.runId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    idempotencyKey: input.idempotencyKey,
    sender: input.sender,
    route: input.route,
    kind: input.kind,
    summary: input.summary,
    createdAt: input.at,
  };
  state.messages[message.id] = message;
  // One place appends to the task timeline, so no caller can forget it.
  const task = input.taskId ? state.tasks[input.taskId] : null;
  if (task && !task.messageIds.includes(message.id)) task.messageIds.push(message.id);
  return message;
}

function applyCallbackToRun(
  run: Run,
  stage: Stage,
  outcome: RecordCallbackInput['outcome'],
  at: string
): void {
  const execution: ExecutionState =
    outcome === 'completed' ? 'turn-ended' : outcome === 'failed' ? 'failed' : 'blocked';
  run.status.execution = { state: execution, at, source: 'callback' };
  // The pipe worked whichever way the work went: a build failure is a business
  // fact, not a delivery failure. Keeping them apart is what stops the UI from
  // reporting "投递失败" for a failing test suite.
  run.status.transport = { state: 'target-received', at, source: 'callback' };
  run.lastEventAt = at;
  if (outcome === 'blocked') {
    run.queuedReason = '接收方报告阻塞，需人工处理';
  }
  void stage;
}

function normalizeEvidence(evidence: CallbackEvidence | undefined, run: Run): CallbackEvidence {
  return {
    commit: evidence?.commit ?? null,
    artifacts: evidence?.artifacts ? [...evidence.artifacts] : [],
    tests: evidence?.tests ? [...evidence.tests] : [],
    sessionId: evidence?.sessionId ?? run.actual.sessionId,
    nativeTurnId: evidence?.nativeTurnId ?? run.actual.nativeTurnId,
  };
}

function summaryLine(stage: Stage, input: RecordCallbackInput): string {
  const verdict = input.outcome === 'completed' ? '完成' : input.outcome === 'failed' ? '失败' : '阻塞';
  return `${stage.label}${verdict}：${input.summary.slice(0, 120)}`;
}

function mapDeliverState(state: DeliverOutcome['state']): CallbackDeliveryState {
  switch (state) {
    case 'in-chat':
      return 'in-chat';
    case 'queued-in-chat':
      return 'queued-in-chat';
    case 'awaiting-host':
      return 'awaiting-host';
    case 'failed':
      // A failed injection is still a human problem, not a silent success.
      return 'manual';
    default:
      return 'manual';
  }
}

function toCallbackReceipt(callback: CallbackRecord): CallbackReceipt {
  const status: LayerStatus = {
    transport: { state: 'target-received', at: callback.receivedAt, source: `callback:${callback.id}` },
    execution: { state: 'turn-ended', at: callback.receivedAt, source: `callback:${callback.id}` },
    business: { state: 'unconfirmed', at: callback.receivedAt, source: `callback:${callback.id}` },
    callback: {
      state: callback.delivery.state,
      at: callback.delivery.lastAttemptAt ?? callback.receivedAt,
      source: `callback:${callback.id}`,
    },
  };
  return {
    callbackId: callback.id,
    taskId: callback.taskId,
    stageId: callback.stageId,
    runId: callback.runId,
    recorded: !callback.duplicate,
    delivery: { ...callback.delivery },
    continuedStageId: callback.delivery.triggeredStageId,
    status,
  };
}

function taskStatusFrom(stages: Stage[], runs: Run[], callbacks: CallbackRecord[], at: string): LayerStatus {
  const latestRun = runs
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  const latestCallback = callbacks
    .slice()
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
    .at(-1);
  const transport: TransportState = latestCallback
    ? 'target-received'
    : (latestRun?.status.transport.state ?? 'local-saved');
  const execution: ExecutionState = deriveTaskExecution(stages, latestRun);
  const business: BusinessState = deriveTaskBusiness(stages);
  const callback: CallbackDeliveryState = latestCallback?.delivery.state ?? 'pending';
  return {
    transport: { state: transport, at, source: 'async.aggregate' },
    execution: { state: execution, at, source: 'async.aggregate' },
    business: { state: business, at, source: 'async.aggregate' },
    callback: { state: callback, at, source: 'async.aggregate' },
  };
}

function deriveTaskExecution(stages: Stage[], latestRun: Run | undefined): ExecutionState {
  const states = stages.map((stage) => stage.status.execution.state);
  if (states.includes('awaiting-confirmation')) return 'awaiting-confirmation';
  if (states.includes('blocked')) return 'blocked';
  if (states.includes('interrupted')) return 'interrupted';
  if (states.includes('failed') && !states.includes('running') && !states.includes('accepted')) {
    return 'failed';
  }
  if (states.includes('running')) return 'running';
  if (states.includes('accepted')) return 'accepted';
  // "Every stage ended its turn" is a transport fact. The business layer says
  // whether the work counts as done; they are never the same field.
  if (states.every((state) => state === 'turn-ended')) return 'turn-ended';
  if (states.every((state) => state === 'queued' || state === 'awaiting-dependency')) return 'queued';
  return latestRun?.status.execution.state ?? 'unknown';
}

function deriveTaskBusiness(stages: Stage[]): BusinessState {
  const states = stages.map((stage) => stage.status.business.state);
  if (states.includes('cancelled')) return 'cancelled';
  if (states.includes('rejected')) return 'rejected';
  if (states.length > 0 && states.every((state) => state === 'unconfirmed')) return 'unconfirmed';
  if (states.includes('unconfirmed')) return 'unconfirmed';
  if (states.includes('accepted')) return 'accepted';
  if (states.includes('reviewed')) return 'reviewed';
  if (states.includes('developed')) return 'developed';
  return 'unconfirmed';
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function recordClientSuccess(
  state: AsyncState,
  seed: (client: string) => ClientCapabilityView,
  client: string,
  at: string
): void {
  const current = state.clientObservations[client] ?? seed(client);
  state.clientObservations[client] = { ...current, lastSuccessAt: at, lastError: null };
}

function recordClientError(
  state: AsyncState,
  seed: (client: string) => ClientCapabilityView,
  client: string,
  error: string
): void {
  const current = state.clientObservations[client] ?? seed(client);
  state.clientObservations[client] = { ...current, lastError: error };
}

/**
 * Evidence for the P0 gate.
 *
 * Only an `in-chat` delivery — the host accepted the callback into the original
 * chat — may upgrade this cell. A Windows toast or a message sitting in the
 * visual queue must never do it.
 */
function noteChatInjection(
  state: { clientObservations: Record<string, ClientCapabilityView> },
  client: string,
  chatId: string,
  at: string
): void {
  const current = state.clientObservations[client];
  if (!current) return;
  state.clientObservations[client] = {
    ...current,
    chatInjection: { state: 'supported', reason: '已观察到回传进入原聊天', evidencedAt: at, chatId },
  };
}

function buildReceiptForStage(store: AsyncStore, taskId: string, stageId: string): SubmitReceipt | null {
  const state = store.snapshot;
  const task = state.tasks[taskId];
  const stage = state.stages[stageId];
  if (!task || !stage) return null;
  const run = stage.runIds
    .map((id) => state.runs[id])
    .filter((item): item is Run => Boolean(item))
    .at(-1);
  if (!run) return null;
  return {
    taskId,
    topicId: task.topicId,
    topicName: state.topics[task.topicId]?.name ?? '',
    topicSlug: state.topics[task.topicId]?.slug ?? '',
    stageId,
    runId: run.id,
    messageId: run.messageId,
    phase: 'queued',
    client: stage.client,
    sessionId: run.actual.sessionId,
    projectId: run.actual.projectId,
    model: { requested: stage.model, actual: run.actual.modelId },
    reason: '准备继续阶段',
    status: cloneStatus(run.status),
    acceptedAt: run.createdAt,
    idempotent: false,
  };
}

export { projectLabel, samePath };
