/**
 * The async collaboration contract.
 *
 * This file is the single source of truth for what Relay promises when it accepts
 * a task: stable identifiers, four separate status layers, and explicit receipt
 * boundaries. Two rules it encodes on purpose, because the previous generation of
 * scripts got both wrong:
 *
 * 1. A status layer never implies another one. `turn-ended` does not mean the
 *    work is done, `delivered` does not mean the target read it, and a queued
 *    acknowledgement is never rendered as "已送达".
 * 2. Every field that cannot be evidenced is `null` or `unverified`, never a
 *    plausible default. A client whose chat-injection capability was never
 *    tested must not borrow the label "已连接".
 */

/* ------------------------------------------------------------------ status */

/** Transport layer: how far the bytes got. Says nothing about the work. */
export type TransportState =
  | 'local-saved'
  | 'relay-received'
  | 'delivering'
  | 'target-received'
  | 'delivery-failed';

/** Execution layer: what the target client is doing with the prompt. */
export type ExecutionState =
  | 'awaiting-dependency'
  | 'queued'
  | 'accepted'
  | 'running'
  | 'awaiting-confirmation'
  | 'blocked'
  | 'interrupted'
  | 'failed'
  | 'turn-ended'
  | 'unknown';

/** Business layer: whether the requested outcome was actually reached. */
export type BusinessState = 'unconfirmed' | 'developed' | 'reviewed' | 'accepted' | 'rejected' | 'cancelled';

/** Callback layer: whether the originating chat got (and handled) the result. */
export type CallbackDeliveryState =
  | 'pending'
  | 'queued-in-chat'
  | 'in-chat'
  | 'awaiting-host'
  | 'handled'
  | 'manual';

export type CallbackOutcome = 'completed' | 'failed' | 'blocked';

export interface StatusMark<TState extends string> {
  state: TState;
  /** ISO-8601 timestamp of the event that produced this state. */
  at: string;
  /** What evidence produced it, e.g. `adapter.dispatch` or `callback:cb_…`. */
  source: string;
}

export interface LayerStatus {
  transport: StatusMark<TransportState>;
  execution: StatusMark<ExecutionState>;
  business: StatusMark<BusinessState>;
  callback: StatusMark<CallbackDeliveryState>;
}

/* ------------------------------------------------------------------ inputs */

export interface ModelConfig {
  /** Account or provider label the user picked, e.g. `BigModel`. */
  account: string;
  /** Provider identifier when the client distinguishes account from vendor. */
  provider: string;
  /** Concrete model id, e.g. `GLM-5.3-Flash`. */
  modelId: string;
  /** Reasoning effort, e.g. `max`. Never a marketing phrase. */
  reasoning: string;
}

export interface ProjectBinding {
  /** Client-side project id. Not a filesystem path. */
  id: string;
  /** Absolute working directory. Compared normalized (case, separators). */
  path: string;
}

/** A project the client already has configured, read from the client itself. */
export interface ProjectOption {
  /** Internal handle. The person never types this; the form carries it along. */
  id: string;
  name: string;
  path: string;
}

/** A model the client can actually select right now, read from the client itself. */
export interface ModelOption {
  /** Value the client accepts as `model.modelId`. */
  id: string;
  label: string;
  /** Reasoning levels this model reports; empty when the client does not say. */
  reasoning: string[];
  description?: string;
}

export interface SessionPolicy {
  /** `new` creates a desktop-visible session; `continue` reuses `sessionId`. */
  policy: 'new' | 'continue';
  sessionId: string | null;
}

/** Where a stage's result must be reported back. Bound at submit time. */
export interface CallbackRoute {
  app: string;
  device: string;
  chatId: string;
}

/** The chat that submitted the task, and what it may continue without asking. */
export interface TaskOrigin {
  app: string;
  device: string;
  chatId: string;
  senderId: string;
  /** Workflow ids the user already authorised to continue automatically. */
  workflowIds: string[];
}

export interface StageCompletion {
  /** Human-readable exit condition, e.g. `开发完成且测试通过`. */
  condition: string;
  /** When true, a callback without evidence cannot count as completed. */
  requiresEvidence: boolean;
}

export interface SubmitStageInput {
  /** `develop`, `review`, or a user-defined kind. */
  kind: string;
  /** Display label; defaults to the kind's Chinese label. */
  label?: string;
  /** Stage ids this stage waits for. Empty means "runs immediately". */
  dependsOn?: string[];
  client: string;
  project: ProjectBinding;
  session?: SessionPolicy;
  model: ModelConfig;
  completion: StageCompletion;
  /** Overrides the task origin chat for this stage's callback. */
  callback?: CallbackRoute;
  /** Queue instead of failing when the target is unavailable. */
  queueIfUnavailable?: boolean;
  /** Stage id supplied by the caller, so dependencies can be expressed. */
  id?: string;
}

export interface SubmitTaskInput {
  /** Client-supplied idempotency key. Derived from the body when omitted. */
  idempotencyKey?: string;
  /** Group this task belongs to, when it was raised by an `@` mention. */
  groupId?: string;
  topic: { name: string; channel?: string; id?: string };
  title: string;
  body: string;
  /** What the user authorised. Only these scopes may continue automatically. */
  authorization: { scopes: string[]; allowChain: boolean };
  origin: TaskOrigin;
  stages: SubmitStageInput[];
}

export interface RecordCallbackInput {
  /** Idempotency key from the receiver. Content hash is used when omitted. */
  idempotencyKey?: string;
  taskId: string;
  stageId: string;
  runId: string;
  outcome: CallbackOutcome;
  summary: string;
  evidence?: CallbackEvidence;
  /** Free-form limitations the receiver wants surfaced in the UI. */
  limits?: string[];
}

export interface CallbackEvidence {
  commit?: string | null;
  artifacts?: string[];
  tests?: string[];
  sessionId?: string | null;
  nativeTurnId?: string | null;
}

/* ------------------------------------------------------------------- state */

export interface Topic {
  id: string;
  /** What the user typed, Chinese and dates included. */
  name: string;
  /** ASCII-safe mapping for channels that reject non-ASCII names. */
  slug: string;
  /** Underlying channel name when the caller supplied one. */
  channel: string | null;
  createdAt: string;
}

export interface Stage {
  id: string;
  taskId: string;
  /** Position in the declared chain, from 0. */
  index: number;
  kind: string;
  label: string;
  dependsOn: string[];
  client: string;
  project: ProjectBinding;
  session: SessionPolicy;
  model: ModelConfig;
  completion: StageCompletion;
  callback: CallbackRoute;
  queueIfUnavailable: boolean;
  runIds: string[];
  status: LayerStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  taskId: string;
  stageId: string;
  /** 1-based attempt counter; a resubmit is a new attempt, not a retry. */
  attempt: number;
  client: string;
  requestedModel: ModelConfig;
  /** What the adapter reported it actually used. `null` until evidenced. */
  actual: {
    account: string | null;
    modelId: string | null;
    reasoning: string | null;
    projectId: string | null;
    workspacePath: string | null;
    sessionId: string | null;
    nativeTurnId: string | null;
  };
  status: LayerStatus;
  /** Why the run is queued, in Chinese, when it is. */
  queuedReason: string | null;
  /** Consecutive delivery attempts; used for backoff display only. */
  deliveryAttempts: number;
  lastError: string | null;
  messageId: string;
  createdAt: string;
  acceptedAt: string | null;
  lastEventAt: string;
}

export type MessageKind =
  | 'task.submitted'
  | 'stage.dispatched'
  | 'stage.queued'
  | 'stage.accepted'
  | 'callback.received'
  | 'callback.delivered'
  | 'callback.manual'
  | 'stage.continued'
  | 'stage.skipped'
  | 'task.cancelled'
  | 'task.note';

export interface MessageRecord {
  id: string;
  topicId: string;
  taskId: string | null;
  stageId: string | null;
  runId: string | null;
  /** Ties every message of one task execution together. */
  correlationId: string;
  /** The message that caused this one, for the timeline. */
  causationId: string | null;
  idempotencyKey: string | null;
  sender: { app: string; device: string; chatId: string; agentId: string };
  route: 'to-client' | 'to-chat' | 'to-topic';
  kind: MessageKind;
  summary: string;
  createdAt: string;
}

export interface CallbackRecord {
  id: string;
  taskId: string;
  stageId: string;
  runId: string;
  messageId: string;
  outcome: CallbackOutcome;
  summary: string;
  evidence: CallbackEvidence;
  limits: string[];
  /** Hash of the semantic payload, so replays collapse into one record. */
  dedupeKey: string;
  /** True when another callback already claimed this run. */
  duplicate: boolean;
  receivedAt: string;
  delivery: {
    state: CallbackDeliveryState;
    attempts: number;
    lastAttemptAt: string | null;
    deliveredAt: string | null;
    reason: string | null;
    /** Stage dispatch this callback triggered, when authorised. */
    triggeredStageId: string | null;
  };
}

export interface Task {
  id: string;
  topicId: string;
  /** The group conversation this task was raised in, if any. */
  groupId: string | null;
  title: string;
  body: string;
  authorization: { scopes: string[]; allowChain: boolean };
  origin: TaskOrigin;
  correlationId: string;
  stageIds: string[];
  runIds: string[];
  callbackIds: string[];
  messageIds: string[];
  status: LayerStatus;
  cancelled: { at: string; reason: string } | null;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ groups */

/**
 * A group is a topic you can talk in.
 *
 * The chat metaphor is not decoration: it fixes who said what to whom. A mention
 * is an address, a member row is a claim of presence with the session that
 * proves it, and a result message is the reply that closes the loop in the same
 * conversation that opened it.
 */
export type GroupMemberRole = 'owner' | 'worker' | 'observer';

export interface GroupSender {
  /** Agent identity inside the group, e.g. `codex`, `zcode`. */
  agentId: string;
  displayName: string;
  app: string;
  device: string;
  /** The sender's own desktop chat, when it has one. */
  chatId: string;
}

export interface GroupMember {
  id: string;
  groupId: string;
  agentId: string;
  displayName: string;
  role: GroupMemberRole;
  /** Session the member registered itself with. `null` until it reports one. */
  sessionId: string | null;
  app: string;
  device: string;
  chatId: string | null;
  model: ModelConfig | null;
  joinedAt: string;
  joinedBy: 'creator' | 'mention' | 'self' | 'manual';
}

/**
 * One `@` in a message.
 *
 * A mention with a `client` and a `model` is a work request: it becomes a task and
 * is dispatched. A mention without them is just addressing — the message stays a
 * message.
 */
export interface GroupMention {
  target: string;
  client?: string;
  model?: ModelConfig;
  project?: ProjectBinding;
  session?: SessionPolicy;
  completion?: StageCompletion;
}

export type GroupMessageKind = 'text' | 'request' | 'result' | 'join' | 'system';

/** How far a message's delivery got. Never a stand-in for "the work is done". */
export type GroupMessageState = 'sent' | 'queued' | 'delivered' | 'manual' | 'failed';

export interface GroupMessage {
  id: string;
  groupId: string;
  kind: GroupMessageKind;
  sender: GroupSender;
  body: string;
  mentions: GroupMention[];
  taskId: string | null;
  stageId: string | null;
  runId: string | null;
  /** Set on `result` messages. */
  outcome: CallbackOutcome | null;
  state: GroupMessageState;
  /** Why a request stayed queued or a result needs a human. */
  reason: string | null;
  createdAt: string;
}

export interface Group {
  id: string;
  topicId: string;
  /** What the user typed when creating it; also the topic display name. */
  name: string;
  slug: string;
  createdBy: GroupSender;
  memberIds: string[];
  messageIds: string[];
  taskIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateGroupInput {
  name: string;
  creator: GroupSender;
}

export interface PostGroupMessageInput {
  sender: GroupSender;
  body: string;
  mentions?: GroupMention[];
}

export interface JoinGroupInput {
  agentId: string;
  displayName?: string;
  sessionId?: string | null;
  app?: string;
  device?: string;
  chatId?: string | null;
  model?: ModelConfig | null;
}

export interface ReportGroupResultInput {
  sender: GroupSender;
  taskId: string;
  stageId?: string;
  outcome: CallbackOutcome;
  summary: string;
  evidence?: CallbackEvidence;
  limits?: string[];
  /** Defaults to the task origin: the chat that asked for the work. */
  mentions?: GroupMention[];
}

export interface GroupView {
  group: Group;
  members: GroupMember[];
  messages: GroupMessage[];
  tasks: Task[];
}

/* ---------------------------------------------------------------- receipts */

/** Returned by submit. Never waits for the model, never claims more than sent. */
export interface SubmitReceipt {
  taskId: string;
  topicId: string;
  topicName: string;
  topicSlug: string;
  stageId: string;
  runId: string;
  messageId: string;
  /** `queued` = persisted only; `delivered` = target accepted the prompt. */
  phase: 'queued' | 'delivered';
  client: string;
  /** Where the prompt actually landed, when the adapter knows. */
  sessionId: string | null;
  projectId: string | null;
  model: { requested: ModelConfig; actual: string | null };
  reason: string | null;
  status: LayerStatus;
  acceptedAt: string;
  /** True when an identical idempotency key produced this receipt before. */
  idempotent: boolean;
}

export interface CallbackReceipt {
  callbackId: string;
  taskId: string;
  stageId: string;
  runId: string;
  /** False when the payload was a replay of an already recorded callback. */
  recorded: boolean;
  delivery: CallbackRecord['delivery'];
  /** Stage that this callback started, when the chain is authorised. */
  continuedStageId: string | null;
  /** Group message that carries this result, when the task belongs to a group. */
  groupMessageId: string | null;
  status: LayerStatus;
}

/* --------------------------------------------------------- client capability */

/**
 * One capability cell. `unverified` is a first-class value: most desktop clients
 * expose internal interfaces that are not a published contract, so an untested
 * capability must not read as supported.
 */
export type CapabilityState = 'supported' | 'unsupported' | 'unverified';

export interface ChatInjectionCapability {
  state: CapabilityState;
  /** Why, in Chinese: version mismatch, probe failed, never probed, … */
  reason: string;
  /** When the state was last evidenced by a probe or a real callback. */
  evidencedAt: string | null;
  /** Chat id used by the last successful injection, for traceability. */
  chatId: string | null;
}

export interface ClientCapabilityView {
  client: string;
  label: string;
  installed: CapabilityState;
  version: string | null;
  interfaceReady: CapabilityState;
  canCreateVisibleSession: CapabilityState;
  canBindProject: CapabilityState;
  canSpecifyAccountModelReasoning: CapabilityState;
  submitReturns: CapabilityState;
  turnEndEvent: CapabilityState;
  businessCallback: CapabilityState;
  /** The P0 gate: can a callback start a new turn in the same chat? */
  chatInjection: ChatInjectionCapability;
  busyQueueing: CapabilityState;
  lastSuccessAt: string | null;
  lastError: string | null;
  /** Free-form notes the adapter wants the user to see. */
  notes: string[];
}

/* ----------------------------------------------------------------- summary */

export interface AsyncSnapshot {
  generatedAt: string;
  dataRoot: string;
  /** Non-empty when the data root is somewhere the user should know about. */
  warnings: string[];
  topics: Topic[];
  tasks: Task[];
  stages: Stage[];
  runs: Run[];
  callbacks: CallbackRecord[];
  messages: MessageRecord[];
  clients: ClientCapabilityView[];
  counts: {
    tasks: number;
    /** Stage executions that are queued or in flight. */
    inFlight: number;
    awaitingConfirmation: number;
    callbacksPendingDelivery: number;
    callbacksManual: number;
    failed: number;
  };
}
