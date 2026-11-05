/**
 * Client adapters and the capability matrix.
 *
 * The engine never talks to a desktop client directly. It asks an adapter, and
 * the adapter answers with an outcome — not with a promise the engine has to
 * wait on. That is the whole point: a submit returns once the target accepted the
 * prompt, never once the model finished.
 *
 * The matrix in this file is deliberately pessimistic. Values come from the
 * written acceptance records for WorkBuddy 5.9.2, ZCode 3.16.3 and Factory 1.2.0
 * (submit + turn-end + Relay receipt verified; chat injection never verified),
 * and everything unproven stays `unverified`. An untested capability must not
 * borrow the label "已连接": the previous generation of scripts did exactly that
 * and reported success for a chain that only ever landed in a manual inbox.
 */

import type {
  CallbackRoute,
  CapabilityState,
  ChatInjectionCapability,
  ClientCapabilityView,
  ModelConfig,
  ModelOption,
  ProjectBinding,
  ProjectOption,
  SessionPolicy,
} from './contracts.js';

export interface DispatchRequest {
  taskId: string;
  stageId: string;
  runId: string;
  topicName: string;
  title: string;
  body: string;
  client: string;
  project: ProjectBinding;
  session: SessionPolicy;
  model: ModelConfig;
  /** Where the result must be reported; the adapter passes it to the prompt. */
  callback: CallbackRoute;
  completion: { condition: string; requiresEvidence: boolean };
  idempotencyKey: string;
}

export interface DispatchOutcome {
  /** `delivered` = the target accepted the prompt. `queued` = not sent yet. */
  status: 'delivered' | 'queued' | 'failed';
  sessionId?: string | null;
  projectId?: string | null;
  modelId?: string | null;
  account?: string | null;
  reasoning?: string | null;
  nativeTurnId?: string | null;
  workspacePath?: string | null;
  /** Why, in Chinese. Required for `queued` and `failed`. */
  reason?: string;
}

export interface DeliverRequest {
  callbackId: string;
  taskId: string;
  stageId: string;
  runId: string;
  chat: CallbackRoute;
  outcome: string;
  summary: string;
  stageLabel: string;
  topicName: string;
}

export interface DeliverOutcome {
  /** `queued-in-chat` means the host accepted it into a queue, not that it ran. */
  state: 'in-chat' | 'queued-in-chat' | 'awaiting-host' | 'manual' | 'failed';
  reason?: string;
  /** New turn identifier when the host reported one. */
  nativeTurnId?: string | null;
}

export interface ClientProbeResult {
  ok: boolean;
  interfaceReady: CapabilityState;
  version: string | null;
  notes: string[];
  error?: string;
}

export interface DispatchAdapter {
  readonly client: string;
  /** Adapter-reported details merged into the static matrix. */
  describe(): Partial<ClientCapabilityView>;
  dispatch(request: DispatchRequest): Promise<DispatchOutcome>;
  deliver(request: DeliverRequest): Promise<DeliverOutcome>;
  /** Explicit, single-shot check. Never called on a timer. */
  probe?(): Promise<ClientProbeResult>;
  /** Projects the client already has configured. Absent when it cannot list them. */
  listProjects?(): Promise<ProjectOption[]>;
  /** Models the client can select right now. Absent when it cannot list them. */
  listModels?(client?: string): Promise<ModelOption[]>;
}

/* ---------------------------------------------------------------- defaults */

interface ClientSeed {
  client: string;
  label: string;
  version: string | null;
  notes: string[];
  capabilities: Partial<Record<keyof ClientCapabilityView, CapabilityState>>;
}

type ChatInjectionAbility = ChatInjectionCapability;

const UNVERIFIED_INJECTION: ChatInjectionAbility = {
  state: 'unverified',
  reason: '尚未验证外部回传能否进入同一聊天并触发新轮次（P0 门槛）',
  evidencedAt: null,
  chatId: null,
};

/**
 * What the acceptance records actually show, per client.
 *
 * `submitReturns` stays `unverified` everywhere: the shipped adapter runs one
 * turn per invocation and waits for it, so there is no verified submit-and-return
 * boundary yet. That gap is the reason this engine exists.
 */
const CLIENT_SEEDS: ClientSeed[] = [
  {
    client: 'workbuddy',
    label: 'WorkBuddy',
    version: '5.9.2',
    notes: [
      '经本机 CDP → 原生 SDK 提交，回传由模型显式发送。',
      '一次执行即等待本轮结束，未提供提交即返回接口。',
    ],
    capabilities: {
      installed: 'unverified',
      canCreateVisibleSession: 'supported',
      canBindProject: 'supported',
      canSpecifyAccountModelReasoning: 'unverified',
      submitReturns: 'unverified',
      turnEndEvent: 'supported',
      businessCallback: 'unverified',
      busyQueueing: 'unverified',
    },
  },
  {
    client: 'zcode',
    label: 'ZCode',
    version: '3.16.3',
    notes: ['经本机 CDP → 桌面 MessagePort 服务代理调用 v4 接口。', '会话需为活动状态，非活动会话需先恢复。'],
    capabilities: {
      installed: 'unverified',
      canCreateVisibleSession: 'supported',
      canBindProject: 'supported',
      canSpecifyAccountModelReasoning: 'unverified',
      submitReturns: 'unverified',
      turnEndEvent: 'supported',
      businessCallback: 'unverified',
      busyQueueing: 'unverified',
    },
  },
  {
    client: 'factory',
    label: 'Factory',
    version: '1.2.0',
    notes: [
      '经桌面 daemon 提交，完成判定使用原生 turn outcome。',
      '自动拒绝权限请求，含工具的任务可能失败。',
    ],
    capabilities: {
      installed: 'unverified',
      canCreateVisibleSession: 'supported',
      canBindProject: 'supported',
      canSpecifyAccountModelReasoning: 'unverified',
      submitReturns: 'unverified',
      turnEndEvent: 'supported',
      businessCallback: 'unverified',
      busyQueueing: 'unverified',
    },
  },
  {
    client: 'codex',
    label: 'ChatGPT / Codex',
    version: null,
    notes: ['本机尚无已验收的派发适配器。'],
    capabilities: {
      installed: 'unverified',
      canCreateVisibleSession: 'unverified',
      canBindProject: 'unverified',
      canSpecifyAccountModelReasoning: 'unverified',
      submitReturns: 'unverified',
      turnEndEvent: 'unverified',
      businessCallback: 'unverified',
      busyQueueing: 'unverified',
    },
  },
];

export function capabilitySeed(client: string): ClientCapabilityView {
  const seed = CLIENT_SEEDS.find((entry) => entry.client === client);
  const capabilities = seed?.capabilities ?? {};
  return {
    client,
    label: seed?.label ?? client,
    installed: capabilities.installed ?? 'unverified',
    version: seed?.version ?? null,
    interfaceReady: capabilities.interfaceReady ?? 'unverified',
    canCreateVisibleSession: capabilities.canCreateVisibleSession ?? 'unverified',
    canBindProject: capabilities.canBindProject ?? 'unverified',
    canSpecifyAccountModelReasoning: capabilities.canSpecifyAccountModelReasoning ?? 'unverified',
    submitReturns: capabilities.submitReturns ?? 'unverified',
    turnEndEvent: capabilities.turnEndEvent ?? 'unverified',
    businessCallback: capabilities.businessCallback ?? 'unverified',
    chatInjection: { ...UNVERIFIED_INJECTION },
    busyQueueing: capabilities.busyQueueing ?? 'unverified',
    lastSuccessAt: null,
    lastError: null,
    notes: seed?.notes ? [...seed.notes] : [],
  };
}

export function knownClients(): string[] {
  return CLIENT_SEEDS.map((seed) => seed.client);
}

/* ------------------------------------------------------------------ registry */

export class AdapterRegistry {
  private readonly adapters = new Map<string, DispatchAdapter>();

  constructor(adapters: DispatchAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: DispatchAdapter): void {
    this.adapters.set(adapter.client, adapter);
  }

  unregister(client: string): void {
    this.adapters.delete(client);
  }

  resolve(client: string): DispatchAdapter | null {
    return this.adapters.get(client) ?? null;
  }

  list(): DispatchAdapter[] {
    return [...this.adapters.values()];
  }

  /** Ask the client's adapter for its configured projects; `null` when unsupported. */
  projects(client: string): Promise<ProjectOption[]> | null {
    const adapter = this.adapters.get(client);
    if (!adapter?.listProjects) return null;
    return adapter.listProjects();
  }

  /**
   * Ask the client's adapter which models it can run; `null` when unsupported.
   *
   * A catalogue lives in the bridge, not in one client's connection, so a client
   * without its own adapter (an agent the bridge does not dispatch to yet) still
   * gets an answer from whichever bridge is registered.
   */
  models(client: string): Promise<ModelOption[]> | null {
    const own = this.adapters.get(client);
    if (own?.listModels) return own.listModels();
    for (const adapter of this.adapters.values()) {
      if (adapter.listModels) return adapter.listModels(client);
    }
    return null;
  }

  /** Static matrix overlaid with whatever the adapter itself reports. */
  capability(client: string): ClientCapabilityView {
    const base = capabilitySeed(client);
    const adapter = this.adapters.get(client);
    if (!adapter) return base;
    const described = adapter.describe();
    return {
      ...base,
      ...described,
      chatInjection: described.chatInjection ?? base.chatInjection,
      notes: described.notes ?? base.notes,
    };
  }

  capabilities(clients: string[] = knownClients()): ClientCapabilityView[] {
    const seen = new Set<string>(clients);
    for (const adapter of this.adapters.values()) seen.add(adapter.client);
    return [...seen].map((client) => this.capability(client));
  }
}

/* ------------------------------------------------------------- http bridge */

/**
 * Adapter that speaks to a local dispatch bridge over HTTP.
 *
 * The bridge is the process that owns the client integration (CDP → native IPC).
 * Keeping it behind HTTP means the engine has no opinion about how a client is
 * driven, and the bridge can be restarted without restarting the app. Only
 * loopback URLs are accepted: this surface can run code, so it must not be
 * reachable from the network.
 */
export class HttpBridgeAdapter implements DispatchAdapter {
  readonly client: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { client: string; baseUrl: string; timeoutMs?: number; fetchImpl?: typeof fetch }) {
    this.client = options.client;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    assertLoopback(this.baseUrl);
  }

  describe(): Partial<ClientCapabilityView> {
    return {
      // The bridge exists, so the interface is reachable — but reachable is not
      // the same as "can inject into the current chat", which needs a probe.
      interfaceReady: 'unverified',
      submitReturns: 'unverified',
      notes: [`派发桥接：${this.baseUrl}`],
    };
  }

  async dispatch(request: DispatchRequest): Promise<DispatchOutcome> {
    const body = await this.post('/dispatch', request);
    return {
      status: normalizeDispatchStatus(body.status),
      sessionId: stringOrNull(body.sessionId),
      projectId: stringOrNull(body.projectId),
      modelId: stringOrNull(body.modelId),
      account: stringOrNull(body.account),
      reasoning: stringOrNull(body.reasoning),
      nativeTurnId: stringOrNull(body.nativeTurnId),
      workspacePath: stringOrNull(body.workspacePath),
      reason: stringOrNull(body.reason) ?? undefined,
    };
  }

  async deliver(request: DeliverRequest): Promise<DeliverOutcome> {
    const body = await this.post('/deliver', request);
    return {
      state: normalizeDeliverState(body.state),
      reason: stringOrNull(body.reason) ?? undefined,
      nativeTurnId: stringOrNull(body.nativeTurnId),
    };
  }

  async probe(): Promise<ClientProbeResult> {
    try {
      const body = await this.post('/probe', { client: this.client });
      return {
        ok: body.ok === true,
        // A bridge may answer with a boolean or with the capability word; both mean
        // the same thing, and neither may be guessed from the other.
        interfaceReady: toCapabilityState(body.interfaceReady),
        version: stringOrNull(body.version),
        notes: Array.isArray(body.notes) ? body.notes.map(String) : [],
        error: stringOrNull(body.error) ?? undefined,
      };
    } catch (error) {
      return {
        ok: false,
        interfaceReady: 'unverified',
        version: null,
        notes: [],
        error: (error as Error).message,
      };
    }
  }

  /**
   * The client's configured projects, read through the bridge.
   *
   * The bridge owns the client integration, so the app never guesses a project
   * id: it asks once and the form carries whatever comes back.
   */
  async listProjects(): Promise<ProjectOption[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/projects?client=${encodeURIComponent(this.client)}`,
        { signal: controller.signal }
      );
      const text = await response.text();
      if (!response.ok) throw new Error(`派发桥接返回 ${response.status}：${text.slice(0, 200)}`);
      const body = (text ? JSON.parse(text) : {}) as { projects?: unknown; reason?: unknown };
      const projects = Array.isArray(body.projects) ? body.projects : [];
      const parsed = projects
        .map((item) => item as Partial<ProjectOption>)
        .filter((item) => typeof item?.id === 'string' && item.id && typeof item?.path === 'string' && item.path)
        .map((item) => ({
          id: String(item.id),
          name: typeof item.name === 'string' && item.name ? item.name : String(item.path),
          path: String(item.path),
        }));
      if (parsed.length === 0 && typeof body.reason === 'string' && body.reason) {
        throw new Error(body.reason);
      }
      return parsed;
    } catch (error) {
      const message = (error as Error).name === 'AbortError' ? '派发桥接超时' : (error as Error).message;
      throw new Error(message);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Models the client can select right now, read through the bridge.
   *
   * The bridge reads the client's own catalogue; the app never keeps a second
   * list that would drift with the next client release.
   */
  async listModels(client = this.client): Promise<ModelOption[]> {
    const body = await this.getJson<{ models?: unknown; reason?: unknown }>('/models', client);
    const models = Array.isArray(body.models) ? body.models : [];
    const parsed = models
      .map((item) => item as Partial<ModelOption>)
      .filter((item) => typeof item?.id === 'string' && item.id)
      .map((item) => ({
        id: String(item.id),
        label: typeof item.label === 'string' && item.label ? item.label : String(item.id),
        reasoning: Array.isArray(item.reasoning)
          ? item.reasoning.filter((level): level is string => typeof level === 'string')
          : [],
        ...(typeof item.description === 'string' && item.description
          ? { description: item.description }
          : {}),
      }));
    if (parsed.length === 0 && typeof body.reason === 'string' && body.reason) {
      throw new Error(body.reason);
    }
    return parsed;
  }

  private async getJson<T>(path: string, client = this.client): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}${path}?client=${encodeURIComponent(client)}`,
        { signal: controller.signal }
      );
      const text = await response.text();
      if (!response.ok) throw new Error(`派发桥接返回 ${response.status}：${text.slice(0, 200)}`);
      return (text ? JSON.parse(text) : {}) as T;
    } catch (error) {
      const message = (error as Error).name === 'AbortError' ? '派发桥接超时' : (error as Error).message;
      throw new Error(message);
    } finally {
      clearTimeout(timer);
    }
  }

  private async post(path: string, payload: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`派发桥接返回 ${response.status}：${text.slice(0, 200)}`);
      }
      const parsed = text ? (JSON.parse(text) as unknown) : {};
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch (error) {
      const message = (error as Error).name === 'AbortError' ? '派发桥接超时' : (error as Error).message;
      throw new Error(message);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function assertLoopback(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`派发桥接地址无效：${url}`);
  }
  const allowed = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (!allowed.has(host)) {
    throw new Error(`派发桥接必须监听本机回环地址，收到：${host}`);
  }
}

function toCapabilityState(value: unknown): CapabilityState {
  if (value === true || value === 'supported') return 'supported';
  if (value === false) return 'unverified';
  if (value === 'unsupported') return 'unsupported';
  return 'unverified';
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeDispatchStatus(value: unknown): DispatchOutcome['status'] {
  return value === 'delivered' || value === 'failed' ? value : 'queued';
}

function normalizeDeliverState(value: unknown): DeliverOutcome['state'] {
  switch (value) {
    case 'in-chat':
    case 'queued-in-chat':
    case 'awaiting-host':
    case 'failed':
      return value;
    default:
      return 'manual';
  }
}
